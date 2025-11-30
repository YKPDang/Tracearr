/**
 * TimescaleDB initialization and setup
 *
 * This module ensures TimescaleDB features are properly configured for the sessions table.
 * It runs on every server startup and is idempotent - safe to run multiple times.
 */

import { db } from './client.js';
import { sql } from 'drizzle-orm';

export interface TimescaleStatus {
  extensionInstalled: boolean;
  sessionsIsHypertable: boolean;
  compressionEnabled: boolean;
  continuousAggregates: string[];
  chunkCount: number;
}

/**
 * Check if TimescaleDB extension is available
 */
async function isTimescaleInstalled(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
      ) as installed
    `);
    return (result.rows[0] as { installed: boolean })?.installed ?? false;
  } catch {
    return false;
  }
}

/**
 * Check if sessions table is already a hypertable
 */
async function isSessionsHypertable(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'sessions'
      ) as is_hypertable
    `);
    return (result.rows[0] as { is_hypertable: boolean })?.is_hypertable ?? false;
  } catch {
    // If timescaledb_information doesn't exist, extension isn't installed
    return false;
  }
}

/**
 * Get list of existing continuous aggregates
 */
async function getContinuousAggregates(): Promise<string[]> {
  try {
    const result = await db.execute(sql`
      SELECT view_name
      FROM timescaledb_information.continuous_aggregates
      WHERE hypertable_name = 'sessions'
    `);
    return (result.rows as { view_name: string }[]).map((r) => r.view_name);
  } catch {
    return [];
  }
}

/**
 * Check if compression is enabled on sessions
 */
async function isCompressionEnabled(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT compression_enabled
      FROM timescaledb_information.hypertables
      WHERE hypertable_name = 'sessions'
    `);
    return (result.rows[0] as { compression_enabled: boolean })?.compression_enabled ?? false;
  } catch {
    return false;
  }
}

/**
 * Get chunk count for sessions hypertable
 */
async function getChunkCount(): Promise<number> {
  try {
    const result = await db.execute(sql`
      SELECT count(*)::int as count
      FROM timescaledb_information.chunks
      WHERE hypertable_name = 'sessions'
    `);
    return (result.rows[0] as { count: number })?.count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Convert sessions table to hypertable
 * This is idempotent - if_not_exists ensures it won't fail if already a hypertable
 */
async function convertToHypertable(): Promise<void> {
  // First, we need to handle the primary key change
  // TimescaleDB requires the partition column (started_at) in the primary key

  // Check if we need to modify the primary key
  const pkResult = await db.execute(sql`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_name = 'sessions'
    AND constraint_type = 'PRIMARY KEY'
  `);

  const pkName = (pkResult.rows[0] as { constraint_name: string })?.constraint_name;

  // Check if started_at is already in the primary key
  const pkColsResult = await db.execute(sql`
    SELECT column_name
    FROM information_schema.key_column_usage
    WHERE table_name = 'sessions'
    AND constraint_name = ${pkName}
  `);

  const pkColumns = (pkColsResult.rows as { column_name: string }[]).map((r) => r.column_name);

  if (!pkColumns.includes('started_at')) {
    // Need to modify primary key for hypertable conversion

    // Drop FK constraint from violations if it exists
    await db.execute(sql`
      ALTER TABLE "violations" DROP CONSTRAINT IF EXISTS "violations_session_id_sessions_id_fk"
    `);

    // Drop existing primary key
    if (pkName) {
      await db.execute(sql.raw(`ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "${pkName}"`));
    }

    // Add composite primary key
    await db.execute(sql`
      ALTER TABLE "sessions" ADD PRIMARY KEY ("id", "started_at")
    `);

    // Add index for violations session lookup (since we can't have FK to hypertable)
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "violations_session_lookup_idx" ON "violations" ("session_id")
    `);
  }

  // Convert to hypertable
  await db.execute(sql`
    SELECT create_hypertable('sessions', 'started_at',
      chunk_time_interval => INTERVAL '7 days',
      migrate_data => true,
      if_not_exists => true
    )
  `);
}

/**
 * Create continuous aggregates for dashboard performance
 */
async function createContinuousAggregates(): Promise<void> {
  // Daily plays by user
  await db.execute(sql`
    CREATE MATERIALIZED VIEW IF NOT EXISTS daily_plays_by_user
    WITH (timescaledb.continuous) AS
    SELECT
      time_bucket('1 day', started_at) AS day,
      user_id,
      COUNT(*) AS play_count,
      SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
    FROM sessions
    GROUP BY day, user_id
    WITH NO DATA
  `);

  // Daily plays by platform
  await db.execute(sql`
    CREATE MATERIALIZED VIEW IF NOT EXISTS daily_plays_by_platform
    WITH (timescaledb.continuous) AS
    SELECT
      time_bucket('1 day', started_at) AS day,
      platform,
      COUNT(*) AS play_count,
      SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
    FROM sessions
    GROUP BY day, platform
    WITH NO DATA
  `);

  // Hourly concurrent streams
  await db.execute(sql`
    CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_concurrent_streams
    WITH (timescaledb.continuous) AS
    SELECT
      time_bucket('1 hour', started_at) AS hour,
      server_id,
      COUNT(*) AS stream_count
    FROM sessions
    WHERE state IN ('playing', 'paused')
    GROUP BY hour, server_id
    WITH NO DATA
  `);

  // Hourly play patterns (for hour-of-day analytics chart)
  await db.execute(sql`
    CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_play_patterns
    WITH (timescaledb.continuous) AS
    SELECT
      time_bucket('1 day', started_at) AS day,
      EXTRACT(HOUR FROM started_at)::int AS hour_of_day,
      COUNT(*) AS play_count,
      SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
    FROM sessions
    GROUP BY day, hour_of_day
    WITH NO DATA
  `);

  // Daily play patterns (for day-of-week analytics chart)
  await db.execute(sql`
    CREATE MATERIALIZED VIEW IF NOT EXISTS daily_play_patterns
    WITH (timescaledb.continuous) AS
    SELECT
      time_bucket('1 week', started_at) AS week,
      EXTRACT(DOW FROM started_at)::int AS day_of_week,
      COUNT(*) AS play_count,
      SUM(COALESCE(duration_ms, 0)) AS total_duration_ms
    FROM sessions
    GROUP BY week, day_of_week
    WITH NO DATA
  `);
}

/**
 * Set up refresh policies for continuous aggregates
 */
async function setupRefreshPolicies(): Promise<void> {
  await db.execute(sql`
    SELECT add_continuous_aggregate_policy('daily_plays_by_user',
      start_offset => INTERVAL '3 days',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '1 hour',
      if_not_exists => true
    )
  `);

  await db.execute(sql`
    SELECT add_continuous_aggregate_policy('daily_plays_by_platform',
      start_offset => INTERVAL '3 days',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '1 hour',
      if_not_exists => true
    )
  `);

  await db.execute(sql`
    SELECT add_continuous_aggregate_policy('hourly_concurrent_streams',
      start_offset => INTERVAL '1 day',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '30 minutes',
      if_not_exists => true
    )
  `);

  await db.execute(sql`
    SELECT add_continuous_aggregate_policy('hourly_play_patterns',
      start_offset => INTERVAL '30 days',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '1 hour',
      if_not_exists => true
    )
  `);

  await db.execute(sql`
    SELECT add_continuous_aggregate_policy('daily_play_patterns',
      start_offset => INTERVAL '30 days',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '1 hour',
      if_not_exists => true
    )
  `);
}

/**
 * Enable compression on sessions hypertable
 */
async function enableCompression(): Promise<void> {
  // Enable compression settings
  await db.execute(sql`
    ALTER TABLE sessions SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'user_id, server_id'
    )
  `);

  // Add compression policy (compress chunks older than 7 days)
  await db.execute(sql`
    SELECT add_compression_policy('sessions', INTERVAL '7 days', if_not_exists => true)
  `);
}

/**
 * Manually refresh all continuous aggregates
 * Call this after bulk data imports (e.g., Tautulli import) to make the data immediately available
 */
export async function refreshAggregates(): Promise<void> {
  const hasExtension = await isTimescaleInstalled();
  if (!hasExtension) return;

  const aggregates = await getContinuousAggregates();

  for (const aggregate of aggregates) {
    try {
      // Refresh the entire aggregate (no time bounds = full refresh)
      await db.execute(
        sql.raw(`CALL refresh_continuous_aggregate('${aggregate}', NULL, NULL)`)
      );
    } catch (err) {
      // Log but don't fail - aggregate might not have data yet
      console.warn(`Failed to refresh aggregate ${aggregate}:`, err);
    }
  }
}

/**
 * Get current TimescaleDB status
 */
export async function getTimescaleStatus(): Promise<TimescaleStatus> {
  const extensionInstalled = await isTimescaleInstalled();

  if (!extensionInstalled) {
    return {
      extensionInstalled: false,
      sessionsIsHypertable: false,
      compressionEnabled: false,
      continuousAggregates: [],
      chunkCount: 0,
    };
  }

  return {
    extensionInstalled: true,
    sessionsIsHypertable: await isSessionsHypertable(),
    compressionEnabled: await isCompressionEnabled(),
    continuousAggregates: await getContinuousAggregates(),
    chunkCount: await getChunkCount(),
  };
}

/**
 * Initialize TimescaleDB for the sessions table
 *
 * This function is idempotent and safe to run on:
 * - Fresh installs (sets everything up)
 * - Existing installs with TimescaleDB already configured (no-op)
 * - Partially configured installs (completes setup)
 * - Installs without TimescaleDB extension (graceful skip)
 */
export async function initTimescaleDB(): Promise<{
  success: boolean;
  status: TimescaleStatus;
  actions: string[];
}> {
  const actions: string[] = [];

  // Check if TimescaleDB extension is available
  const hasExtension = await isTimescaleInstalled();
  if (!hasExtension) {
    return {
      success: true, // Not a failure - just no TimescaleDB
      status: {
        extensionInstalled: false,
        sessionsIsHypertable: false,
        compressionEnabled: false,
        continuousAggregates: [],
        chunkCount: 0,
      },
      actions: ['TimescaleDB extension not installed - skipping setup'],
    };
  }

  actions.push('TimescaleDB extension found');

  // Check if sessions is already a hypertable
  const isHypertable = await isSessionsHypertable();
  if (!isHypertable) {
    await convertToHypertable();
    actions.push('Converted sessions table to hypertable');
  } else {
    actions.push('Sessions already a hypertable');
  }

  // Check and create continuous aggregates
  const existingAggregates = await getContinuousAggregates();
  const expectedAggregates = [
    'daily_plays_by_user',
    'daily_plays_by_platform',
    'hourly_concurrent_streams',
    'hourly_play_patterns',
    'daily_play_patterns',
  ];

  const missingAggregates = expectedAggregates.filter(
    (agg) => !existingAggregates.includes(agg)
  );

  if (missingAggregates.length > 0) {
    await createContinuousAggregates();
    await setupRefreshPolicies();
    actions.push(`Created continuous aggregates: ${missingAggregates.join(', ')}`);
  } else {
    actions.push('All continuous aggregates exist');
  }

  // Check and enable compression
  const hasCompression = await isCompressionEnabled();
  if (!hasCompression) {
    await enableCompression();
    actions.push('Enabled compression on sessions');
  } else {
    actions.push('Compression already enabled');
  }

  // Get final status
  const status = await getTimescaleStatus();

  return {
    success: true,
    status,
    actions,
  };
}

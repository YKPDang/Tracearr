/**
 * Prepared statements for hot-path queries
 *
 * Prepared statements optimize performance by allowing PostgreSQL to reuse
 * query plans across executions. These are particularly valuable for:
 * - Queries called on every page load (dashboard)
 * - Queries called frequently during polling
 * - Queries with predictable parameter patterns
 *
 * @see https://orm.drizzle.team/docs/perf-queries
 */

import { eq, gte, and, isNull, sql } from 'drizzle-orm';
import { db } from './client.js';
import { sessions, violations, users } from './schema.js';

// ============================================================================
// Dashboard Stats Queries
// ============================================================================

/**
 * Count unique plays (grouped by reference_id) since a given date
 * Used for: Dashboard "Today's Plays" metric
 * Called: Every dashboard page load
 */
export const playsCountSince = db
  .select({
    count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
  })
  .from(sessions)
  .where(gte(sessions.startedAt, sql.placeholder('since')))
  .prepare('plays_count_since');

/**
 * Sum total watch time since a given date
 * Used for: Dashboard "Watch Time" metric
 * Called: Every dashboard page load
 */
export const watchTimeSince = db
  .select({
    totalMs: sql<number>`COALESCE(SUM(duration_ms), 0)::bigint`,
  })
  .from(sessions)
  .where(gte(sessions.startedAt, sql.placeholder('since')))
  .prepare('watch_time_since');

/**
 * Count violations since a given date
 * Used for: Dashboard "Alerts" metric
 * Called: Every dashboard page load
 */
export const violationsCountSince = db
  .select({
    count: sql<number>`count(*)::int`,
  })
  .from(violations)
  .where(gte(violations.createdAt, sql.placeholder('since')))
  .prepare('violations_count_since');

/**
 * Count unacknowledged violations
 * Used for: Alert badge in navigation
 * Called: On app load and after acknowledgment
 */
export const unacknowledgedViolationsCount = db
  .select({
    count: sql<number>`count(*)::int`,
  })
  .from(violations)
  .where(isNull(violations.acknowledgedAt))
  .prepare('unacknowledged_violations_count');

// ============================================================================
// Polling Queries
// ============================================================================

/**
 * Find user by server ID and external ID
 * Used for: User lookup during session polling
 * Called: Every poll cycle for each active session (potentially 10+ times per 15 seconds)
 */
export const userByExternalId = db
  .select()
  .from(users)
  .where(
    and(
      eq(users.serverId, sql.placeholder('serverId')),
      eq(users.externalId, sql.placeholder('externalId'))
    )
  )
  .limit(1)
  .prepare('user_by_external_id');

/**
 * Find session by server ID and session key
 * Used for: Session lookup during polling to check for existing sessions
 * Called: Every poll cycle for each active session
 */
export const sessionByServerAndKey = db
  .select()
  .from(sessions)
  .where(
    and(
      eq(sessions.serverId, sql.placeholder('serverId')),
      eq(sessions.sessionKey, sql.placeholder('sessionKey'))
    )
  )
  .limit(1)
  .prepare('session_by_server_and_key');

// ============================================================================
// User Queries
// ============================================================================

/**
 * Get user by ID with basic info
 * Used for: User details in violations, sessions
 * Called: Frequently for UI enrichment
 */
export const userById = db
  .select({
    id: users.id,
    username: users.username,
    thumbUrl: users.thumbUrl,
    trustScore: users.trustScore,
  })
  .from(users)
  .where(eq(users.id, sql.placeholder('id')))
  .limit(1)
  .prepare('user_by_id');

// ============================================================================
// Session Queries
// ============================================================================

/**
 * Get session by ID
 * Used for: Session detail page, violation context
 * Called: When viewing session details
 */
export const sessionById = db
  .select()
  .from(sessions)
  .where(eq(sessions.id, sql.placeholder('id')))
  .limit(1)
  .prepare('session_by_id');

// ============================================================================
// Stats Queries (hot-path for dashboard and analytics pages)
// ============================================================================

/**
 * Plays by platform since a given date
 * Used for: Stats platform breakdown chart
 * Called: Every stats page load
 */
export const playsByPlatformSince = db
  .select({
    platform: sessions.platform,
    count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
  })
  .from(sessions)
  .where(gte(sessions.startedAt, sql.placeholder('since')))
  .groupBy(sessions.platform)
  .orderBy(sql`count(DISTINCT COALESCE(reference_id, id)) DESC`)
  .prepare('plays_by_platform_since');

/**
 * Quality breakdown (direct vs transcode) since a given date
 * Used for: Stats quality chart
 * Called: Every stats page load
 */
export const qualityStatsSince = db
  .select({
    isTranscode: sessions.isTranscode,
    count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
  })
  .from(sessions)
  .where(gte(sessions.startedAt, sql.placeholder('since')))
  .groupBy(sessions.isTranscode)
  .prepare('quality_stats_since');

/**
 * Watch time by media type since a given date
 * Used for: Watch time breakdown by content type
 * Called: Stats page load
 */
export const watchTimeByTypeSince = db
  .select({
    mediaType: sessions.mediaType,
    totalMs: sql<number>`COALESCE(SUM(duration_ms), 0)::bigint`,
  })
  .from(sessions)
  .where(gte(sessions.startedAt, sql.placeholder('since')))
  .groupBy(sessions.mediaType)
  .prepare('watch_time_by_type_since');

// ============================================================================
// Type exports for execute results
// ============================================================================

export type PlaysCountResult = Awaited<ReturnType<typeof playsCountSince.execute>>;
export type WatchTimeResult = Awaited<ReturnType<typeof watchTimeSince.execute>>;
export type ViolationsCountResult = Awaited<ReturnType<typeof violationsCountSince.execute>>;
export type UserByExternalIdResult = Awaited<ReturnType<typeof userByExternalId.execute>>;
export type UserByIdResult = Awaited<ReturnType<typeof userById.execute>>;
export type SessionByIdResult = Awaited<ReturnType<typeof sessionById.execute>>;
export type PlaysByPlatformResult = Awaited<ReturnType<typeof playsByPlatformSince.execute>>;
export type QualityStatsResult = Awaited<ReturnType<typeof qualityStatsSince.execute>>;
export type WatchTimeByTypeResult = Awaited<ReturnType<typeof watchTimeByTypeSince.execute>>;

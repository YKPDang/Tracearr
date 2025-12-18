-- Migration: Change duration columns from INTEGER to BIGINT
-- Required for Tautulli imports with large duration values (>2.1 billion ms)
--
-- This migration handles TimescaleDB hypertables with compression and continuous aggregates.
-- Continuous aggregates are DERIVED data computed from sessions - they will be automatically
-- recreated by the app on next startup and refreshed from source data. No data is lost.

-- Step 1: Remove compression policy (allows decompression)
DO $$
BEGIN
  PERFORM remove_compression_policy('sessions', if_exists => true);
EXCEPTION WHEN undefined_function THEN
  -- TimescaleDB not installed, skip
  NULL;
END $$;

--> statement-breakpoint

-- Step 2: Decompress all chunks (preserves all data, just uncompresses)
DO $$
DECLARE
  chunk_id regclass;
BEGIN
  FOR chunk_id IN
    SELECT format('%I.%I', c.chunk_schema, c.chunk_name)::regclass
    FROM timescaledb_information.chunks c
    WHERE c.hypertable_name = 'sessions'
    AND c.is_compressed = true
  LOOP
    PERFORM decompress_chunk(chunk_id, if_compressed => true);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  -- TimescaleDB not installed or no chunks, skip
  NULL;
END $$;

--> statement-breakpoint

-- Step 3: Drop continuous aggregates that depend on duration_ms
-- These are DERIVED data and will be recreated by initTimescaleDB() on app startup
DROP MATERIALIZED VIEW IF EXISTS daily_plays_by_user CASCADE;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS daily_plays_by_server CASCADE;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS daily_stats_summary CASCADE;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS hourly_concurrent_streams CASCADE;

--> statement-breakpoint

-- Step 4: Alter column types from INTEGER to BIGINT
ALTER TABLE "sessions" ALTER COLUMN "duration_ms" SET DATA TYPE bigint;
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "total_duration_ms" SET DATA TYPE bigint;
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "progress_ms" SET DATA TYPE bigint;
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "paused_duration_ms" SET DATA TYPE bigint;

-- Note: Compression policy and continuous aggregates will be automatically
-- recreated by initTimescaleDB() when the server starts. The aggregates
-- will be refreshed with refreshAggregates() to rebuild from source data.

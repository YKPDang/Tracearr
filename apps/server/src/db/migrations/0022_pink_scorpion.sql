-- Migration: Change duration columns from INTEGER to BIGINT
-- Required for Tautulli imports with large duration values (>2.1 billion ms)
--
-- This is a single atomic block that handles ALL TimescaleDB scenarios:
-- compression, columnstore, continuous aggregates, and edge cases.

DO $$
DECLARE
  cagg_name text;
  chunk_name text;
  has_timescale boolean := false;
  is_hypertable boolean := false;
BEGIN
  -- Check if TimescaleDB is installed
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') INTO has_timescale;

  IF has_timescale THEN
    -- Check if sessions is a hypertable
    SELECT EXISTS(
      SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'sessions'
    ) INTO is_hypertable;
  END IF;

  IF has_timescale AND is_hypertable THEN
    -- Step 1: Drop ALL continuous aggregates that reference sessions table
    -- Query the catalog to find them dynamically
    FOR cagg_name IN
      SELECT format('%I.%I', cv.view_schema, cv.view_name)
      FROM timescaledb_information.continuous_aggregates cv
      WHERE cv.hypertable_name = 'sessions'
    LOOP
      EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS %s CASCADE', cagg_name);
    END LOOP;

    -- Step 2: Remove compression policy
    BEGIN
      PERFORM remove_compression_policy('sessions', if_exists => true);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- Step 3: Convert chunks from columnstore to rowstore (TimescaleDB 2.18+)
    FOR chunk_name IN
      SELECT format('%I.%I', c.chunk_schema, c.chunk_name)
      FROM timescaledb_information.chunks c
      WHERE c.hypertable_name = 'sessions'
    LOOP
      BEGIN
        EXECUTE format('CALL convert_to_rowstore(%L::regclass)', chunk_name);
      EXCEPTION
        WHEN undefined_function THEN
          -- Older TimescaleDB, try decompress
          BEGIN
            EXECUTE format('SELECT decompress_chunk(%L::regclass, if_compressed => true)', chunk_name);
          EXCEPTION WHEN OTHERS THEN NULL;
          END;
        WHEN OTHERS THEN NULL;
      END;
    END LOOP;

    -- Step 4: Disable columnstore (TimescaleDB 2.17+)
    BEGIN
      EXECUTE 'ALTER TABLE sessions SET (timescaledb.enable_columnstore = false)';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  -- Step 5: Also drop any named views that might exist (belt and suspenders)
  DROP MATERIALIZED VIEW IF EXISTS daily_plays_by_user CASCADE;
  DROP MATERIALIZED VIEW IF EXISTS daily_plays_by_server CASCADE;
  DROP MATERIALIZED VIEW IF EXISTS daily_stats_summary CASCADE;
  DROP MATERIALIZED VIEW IF EXISTS hourly_concurrent_streams CASCADE;

  -- Step 6: Alter column types - only if not already bigint
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'duration_ms' AND data_type = 'integer'
  ) THEN
    ALTER TABLE sessions ALTER COLUMN duration_ms SET DATA TYPE bigint;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'total_duration_ms' AND data_type = 'integer'
  ) THEN
    ALTER TABLE sessions ALTER COLUMN total_duration_ms SET DATA TYPE bigint;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'progress_ms' AND data_type = 'integer'
  ) THEN
    ALTER TABLE sessions ALTER COLUMN progress_ms SET DATA TYPE bigint;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'paused_duration_ms' AND data_type = 'integer'
  ) THEN
    ALTER TABLE sessions ALTER COLUMN paused_duration_ms SET DATA TYPE bigint;
  END IF;

END $$;

-- Note: Columnstore, compression policy, and continuous aggregates will be automatically
-- recreated by initTimescaleDB() when the server starts.

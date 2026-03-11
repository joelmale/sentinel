-- ═══════════════════════════════════════════════════════════════
--  Migration 02: Curated Space watchlist status dashboard table
--
--  Apply to an existing running database with:
--    docker exec -i sentinel-db psql -U sentinel -d sentinel \
--      < docker/timescaledb/migrations/02_space_watchlist_status.sql
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS space_watchlist_status (
    watch_id             TEXT            PRIMARY KEY,
    label                TEXT            NOT NULL,
    priority             TEXT            NOT NULL,
    enabled              BOOLEAN         DEFAULT TRUE,
    norad_id             INTEGER,
    satnogs_sat_id       TEXT,
    desired_sources      TEXT[]          DEFAULT '{}',
    notes                TEXT,
    current_name         TEXT,
    in_catalog           BOOLEAN         DEFAULT FALSE,
    active_track         BOOLEAN         DEFAULT FALSE,
    current_tle_source   TEXT,
    tle_epoch            TIMESTAMPTZ,
    tle_age_minutes      DOUBLE PRECISION,
    last_track_seen      TIMESTAMPTZ,
    health_status        TEXT            DEFAULT 'idle',
    source_status        JSONB           DEFAULT '{}'::jsonb,
    metadata             JSONB           DEFAULT '{}'::jsonb,
    updated_at           TIMESTAMPTZ     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_space_watchlist_priority
    ON space_watchlist_status (priority, updated_at DESC);

GRANT ALL ON space_watchlist_status TO sentinel;

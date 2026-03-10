-- ═══════════════════════════════════════════════════════════════
--  SENTINEL — TimescaleDB + PostGIS initialization
--  Runs once on first container start via docker-entrypoint-initdb.d
-- ═══════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- for fast text search on callsigns

-- ── Domain enum ──────────────────────────────────────────────────
CREATE TYPE source_domain AS ENUM (
    'Air',
    'Maritime',
    'Space',
    'GPS',
    'Infra'
);

-- ── Core track events table ───────────────────────────────────────
-- Every position report / state update from every domain lands here.
-- This is a TimescaleDB hypertable partitioned by timestamp.
CREATE TABLE track_events (
    event_id        UUID            DEFAULT uuid_generate_v4(),
    source_domain   source_domain   NOT NULL,
    source_feed     TEXT            NOT NULL,
    track_id        TEXT            NOT NULL,        -- ICAO hex, MMSI, NORAD ID, etc.
    callsign        TEXT,                            -- human-readable label
    position        GEOMETRY(Point, 4326),           -- WGS84 lon/lat
    altitude_m      DOUBLE PRECISION,               -- metres, NULL for surface
    heading_deg     DOUBLE PRECISION,               -- 0-360 true
    speed_mps       DOUBLE PRECISION,               -- metres per second
    timestamp       TIMESTAMPTZ     NOT NULL,        -- EVENT time (partition key)
    metadata        JSONB           DEFAULT '{}'::jsonb,
    classification  TEXT,                            -- Commercial/Military/Unknown/etc.
    ingested_at     TIMESTAMPTZ     DEFAULT NOW()
);

-- Convert to hypertable partitioned by timestamp with 1-day chunks
SELECT create_hypertable(
    'track_events',
    'timestamp',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Spatial index (PostGIS GIST) — critical for bbox queries
CREATE INDEX idx_track_events_position
    ON track_events USING GIST (position);

-- Compound index for domain + entity time-series lookback
CREATE INDEX idx_track_events_domain_track_ts
    ON track_events (source_domain, track_id, timestamp DESC);

-- Text search on callsign
CREATE INDEX idx_track_events_callsign_trgm
    ON track_events USING GIN (callsign gin_trgm_ops);

-- ── Compression policy ───────────────────────────────────────────
-- Compress chunks older than 7 days (typically 10-20x space reduction)
ALTER TABLE track_events SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'source_domain, track_id',
    timescaledb.compress_orderby = 'timestamp DESC'
);

SELECT add_compression_policy(
    'track_events',
    compress_after => INTERVAL '7 days'
);

-- ── Retention policy ─────────────────────────────────────────────
-- Drop data older than 90 days (override per-deployment in admin UI)
SELECT add_retention_policy(
    'track_events',
    drop_after => INTERVAL '90 days'
);

-- ── Current asset state cache ─────────────────────────────────────
-- Mirrors Redis; survives Redis restarts; updated in-place per track
CREATE TABLE asset_states (
    id              BIGSERIAL       PRIMARY KEY,
    source_domain   source_domain   NOT NULL,
    source_feed     TEXT            NOT NULL,
    track_id        TEXT            NOT NULL,
    callsign        TEXT,
    position        GEOMETRY(Point, 4326),
    altitude_m      DOUBLE PRECISION,
    heading_deg     DOUBLE PRECISION,
    speed_mps       DOUBLE PRECISION,
    last_seen       TIMESTAMPTZ     NOT NULL,
    metadata        JSONB           DEFAULT '{}'::jsonb,
    classification  TEXT,
    UNIQUE (source_domain, track_id)
);

CREATE INDEX idx_asset_states_position
    ON asset_states USING GIST (position);

CREATE INDEX idx_asset_states_domain
    ON asset_states (source_domain);

-- ── Analyst annotations ───────────────────────────────────────────
CREATE TABLE annotations (
    id              UUID            DEFAULT uuid_generate_v4() PRIMARY KEY,
    created_by      TEXT            NOT NULL,
    created_at      TIMESTAMPTZ     DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     DEFAULT NOW(),
    position        GEOMETRY(Point, 4326) NOT NULL,
    label           TEXT            NOT NULL,
    body            TEXT,
    linked_track_id TEXT,
    linked_domain   source_domain,
    linked_at       TIMESTAMPTZ,    -- timestamp in history this annotation refers to
    tags            TEXT[]          DEFAULT '{}',
    color           TEXT            DEFAULT '#FF6B35'
);

CREATE INDEX idx_annotations_position
    ON annotations USING GIST (position);

CREATE INDEX idx_annotations_created_by
    ON annotations (created_by, created_at DESC);

-- ── Regions of interest ───────────────────────────────────────────
CREATE TABLE regions_of_interest (
    id          UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
    name        TEXT    NOT NULL,
    description TEXT,
    created_by  TEXT    NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    geometry    GEOMETRY(Polygon, 4326) NOT NULL,
    is_shared   BOOLEAN DEFAULT FALSE,
    metadata    JSONB   DEFAULT '{}'::jsonb
);

CREATE INDEX idx_roi_geometry
    ON regions_of_interest USING GIST (geometry);

-- ── Alerts ────────────────────────────────────────────────────────
CREATE TABLE alert_rules (
    id              UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
    name            TEXT    NOT NULL,
    created_by      TEXT    NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    is_active       BOOLEAN DEFAULT TRUE,
    domain          source_domain,
    roi_id          UUID    REFERENCES regions_of_interest(id),
    classification  TEXT,
    conditions      JSONB   NOT NULL DEFAULT '{}'::jsonb,  -- flexible rule spec
    notify_channels TEXT[]  DEFAULT '{}'  -- 'websocket', 'email', etc.
);

CREATE TABLE alert_events (
    id          UUID        DEFAULT uuid_generate_v4(),
    rule_id     UUID        NOT NULL REFERENCES alert_rules(id),
    track_id    TEXT,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status      TEXT        DEFAULT 'open',  -- open / acknowledged / closed
    payload     JSONB       DEFAULT '{}'::jsonb
);

SELECT create_hypertable(
    'alert_events',
    'triggered_at',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- ── Continuous aggregates ─────────────────────────────────────────
-- 1-minute activity counts per domain (powers live activity sparkline)
CREATE MATERIALIZED VIEW track_events_1min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', timestamp) AS bucket,
    source_domain,
    COUNT(*)                           AS event_count,
    COUNT(DISTINCT track_id)           AS asset_count
FROM track_events
GROUP BY bucket, source_domain
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
    'track_events_1min',
    start_offset => INTERVAL '1 hour',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute'
);

-- 1-hour aggregate for historical trend views
CREATE MATERIALIZED VIEW track_events_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', timestamp) AS bucket,
    source_domain,
    COUNT(*)                         AS event_count,
    COUNT(DISTINCT track_id)         AS asset_count
FROM track_events
GROUP BY bucket, source_domain
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
    'track_events_hourly',
    start_offset => INTERVAL '7 days',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);

-- ── Audit log ─────────────────────────────────────────────────────
CREATE TABLE audit_log (
    id          BIGSERIAL   PRIMARY KEY,
    actor       TEXT        NOT NULL,
    action      TEXT        NOT NULL,
    resource    TEXT,
    detail      JSONB       DEFAULT '{}'::jsonb,
    ip_address  INET,
    logged_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Granted permissions
GRANT ALL ON ALL TABLES IN SCHEMA public TO sentinel;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO sentinel;

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

-- ── Canonical entities ────────────────────────────────────────────
CREATE TABLE entities (
    entity_id        UUID            PRIMARY KEY,
    entity_type      TEXT            NOT NULL,    -- asset | disruption | region | facility
    source_domain    source_domain,
    display_name     TEXT,
    status           TEXT            DEFAULT 'active',
    metadata         JSONB           DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ     DEFAULT NOW(),
    updated_at       TIMESTAMPTZ     DEFAULT NOW()
);

CREATE INDEX idx_entities_type_domain
    ON entities (entity_type, source_domain, updated_at DESC);

-- ── Core track events table ───────────────────────────────────────
-- Every position report / state update from every domain lands here.
-- This is a TimescaleDB hypertable partitioned by timestamp.
CREATE TABLE track_events (
    event_id        UUID            DEFAULT uuid_generate_v4(),
    entity_id       UUID            REFERENCES entities(entity_id),
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

CREATE INDEX idx_track_events_entity_ts
    ON track_events (entity_id, timestamp DESC);

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
    entity_id       UUID            REFERENCES entities(entity_id),
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

CREATE INDEX idx_asset_states_entity
    ON asset_states (entity_id);

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

-- ── Satellite catalog ────────────────────────────────────────────
-- Persistent metadata for tracked space objects, enriched from
-- Space-Track SATCAT (country, launch date, orbit class, RCS size)
-- and optionally from the UCS Satellite Database (operator, purpose).
-- Updated during each TLE refresh cycle.
CREATE TABLE satellite_catalog (
    norad_id        INTEGER         PRIMARY KEY,
    object_name     TEXT            NOT NULL,       -- e.g. "ISS (ZARYA)"
    intl_designator TEXT,                           -- e.g. "1998-067A"
    object_type     TEXT,           -- PAYLOAD / ROCKET BODY / DEBRIS / UNKNOWN
    country_code    TEXT,           -- ISO-3166 alpha-3 or SATCAT code
    launch_date     DATE,
    decay_date      DATE,           -- NULL if still in orbit
    period_min      DOUBLE PRECISION,
    inclination_deg DOUBLE PRECISION,
    apogee_km       DOUBLE PRECISION,
    perigee_km      DOUBLE PRECISION,
    rcs_size        TEXT,           -- SMALL / MEDIUM / LARGE (radar cross section)
    orbit_class     TEXT,           -- LEO / MEO / GEO / HEO / SSO
    -- Enriched fields (may be blank for debris/rocket bodies)
    operator        TEXT,
    purpose         TEXT,           -- e.g. "Earth Observation", "Communications"
    contractor      TEXT,
    launch_site     TEXT,
    -- Source tracking
    sources         TEXT[]          DEFAULT '{}',  -- ['spacetrack', 'ucs', ...]
    last_updated    TIMESTAMPTZ     DEFAULT NOW(),
    metadata        JSONB           DEFAULT '{}'::jsonb
);

CREATE INDEX idx_satellite_catalog_country
    ON satellite_catalog (country_code);

CREATE INDEX idx_satellite_catalog_orbit_class
    ON satellite_catalog (orbit_class);

CREATE INDEX idx_satellite_catalog_object_type
    ON satellite_catalog (object_type);

-- ── Historical TLE snapshots ──────────────────────────────────────
-- One row per (norad_id, epoch). Allows retroactive orbital projection:
-- to replay where a satellite WAS at time T, find the TLE epoch nearest
-- to T and propagate forward/backward using SGP4.
-- Think of it as version-controlling orbital state vectors.
CREATE TABLE satellite_tles (
    norad_id        INTEGER         NOT NULL,
    epoch           TIMESTAMPTZ     NOT NULL,   -- TLE reference epoch (UTC)
    tle_line1       TEXT            NOT NULL,
    tle_line2       TEXT            NOT NULL,
    source          TEXT            NOT NULL,   -- 'spacetrack' | 'celestrak'
    ingested_at     TIMESTAMPTZ     DEFAULT NOW(),
    PRIMARY KEY (norad_id, epoch)
);

-- Index for "give me the TLE snapshot closest to time T for satellite N"
CREATE INDEX idx_satellite_tles_norad_epoch
    ON satellite_tles (norad_id, epoch DESC);

-- ── Curated space watchlist status ────────────────────────────────
-- Read-only operational dashboard for curated Space entries tracked
-- through slow-refresh supplemental sources such as N2YO and SatNOGS.
CREATE TABLE space_watchlist_status (
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

CREATE INDEX idx_space_watchlist_priority
    ON space_watchlist_status (priority, updated_at DESC);

-- ── Normalized disruption events ────────────────────────────────
-- Collector-specific signals such as GPS jamming, internet outages,
-- power outages, and future conflict events are normalized here.
-- `disruption_events` holds the latest incident state per external event;
-- `disruption_observations` preserves the time-series evidence.
CREATE TABLE disruption_events (
    id                  UUID            DEFAULT uuid_generate_v4() PRIMARY KEY,
    entity_id           UUID            REFERENCES entities(entity_id),
    source_domain       source_domain   NOT NULL,
    source_feed         TEXT            NOT NULL,
    external_event_id   TEXT            NOT NULL,
    track_id            TEXT,
    callsign            TEXT,
    event_type          TEXT            NOT NULL,
    category            TEXT            NOT NULL,
    title               TEXT,
    status              TEXT            NOT NULL DEFAULT 'active',
    severity            DOUBLE PRECISION,
    confidence          DOUBLE PRECISION,
    source_trust_score  DOUBLE PRECISION,
    first_seen          TIMESTAMPTZ     NOT NULL,
    last_seen           TIMESTAMPTZ     NOT NULL,
    start_time          TIMESTAMPTZ,
    end_time            TIMESTAMPTZ,
    geometry            GEOMETRY(Geometry, 4326),
    centroid            GEOMETRY(Point, 4326),
    h3_cell             TEXT,
    measurement_value   DOUBLE PRECISION,
    measurement_unit    TEXT,
    affected_assets_count INTEGER       DEFAULT 0,
    correlation_id      UUID,
    metadata            JSONB           DEFAULT '{}'::jsonb,
    classification      TEXT,
    updated_at          TIMESTAMPTZ     DEFAULT NOW(),
    UNIQUE (source_feed, external_event_id)
);

CREATE INDEX idx_disruption_events_domain_time
    ON disruption_events (source_domain, last_seen DESC);

CREATE INDEX idx_disruption_events_type_status
    ON disruption_events (event_type, status, last_seen DESC);

CREATE INDEX idx_disruption_events_geometry
    ON disruption_events USING GIST (geometry);

CREATE INDEX idx_disruption_events_centroid
    ON disruption_events USING GIST (centroid);

CREATE INDEX idx_disruption_events_correlation
    ON disruption_events (correlation_id);

CREATE INDEX idx_disruption_events_entity
    ON disruption_events (entity_id);

CREATE TABLE disruption_observations (
    observation_id      UUID            DEFAULT uuid_generate_v4(),
    entity_id           UUID            REFERENCES entities(entity_id),
    source_domain       source_domain   NOT NULL,
    source_feed         TEXT            NOT NULL,
    external_event_id   TEXT            NOT NULL,
    track_id            TEXT,
    observed_at         TIMESTAMPTZ     NOT NULL,
    observation_type    TEXT            NOT NULL,
    severity            DOUBLE PRECISION,
    confidence          DOUBLE PRECISION,
    source_trust_score  DOUBLE PRECISION,
    geometry            GEOMETRY(Geometry, 4326),
    centroid            GEOMETRY(Point, 4326),
    raw_payload         JSONB           DEFAULT '{}'::jsonb,
    metadata            JSONB           DEFAULT '{}'::jsonb
);

SELECT create_hypertable(
    'disruption_observations',
    'observed_at',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

CREATE INDEX idx_disruption_observations_domain_time
    ON disruption_observations (source_domain, observed_at DESC);

CREATE INDEX idx_disruption_observations_feed_event
    ON disruption_observations (source_feed, external_event_id, observed_at DESC);

CREATE INDEX idx_disruption_observations_entity_time
    ON disruption_observations (entity_id, observed_at DESC);

CREATE INDEX idx_disruption_observations_geometry
    ON disruption_observations USING GIST (geometry);

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

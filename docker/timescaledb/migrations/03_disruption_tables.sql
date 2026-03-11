CREATE TABLE IF NOT EXISTS disruption_events (
    id                    UUID            DEFAULT uuid_generate_v4() PRIMARY KEY,
    source_domain         source_domain   NOT NULL,
    source_feed           TEXT            NOT NULL,
    external_event_id     TEXT            NOT NULL,
    track_id              TEXT,
    callsign              TEXT,
    event_type            TEXT            NOT NULL,
    category              TEXT            NOT NULL,
    title                 TEXT,
    status                TEXT            NOT NULL DEFAULT 'active',
    severity              DOUBLE PRECISION,
    confidence            DOUBLE PRECISION,
    source_trust_score    DOUBLE PRECISION,
    first_seen            TIMESTAMPTZ     NOT NULL,
    last_seen             TIMESTAMPTZ     NOT NULL,
    start_time            TIMESTAMPTZ,
    end_time              TIMESTAMPTZ,
    geometry              GEOMETRY(Geometry, 4326),
    centroid              GEOMETRY(Point, 4326),
    h3_cell               TEXT,
    measurement_value     DOUBLE PRECISION,
    measurement_unit      TEXT,
    affected_assets_count INTEGER         DEFAULT 0,
    correlation_id        UUID,
    metadata              JSONB           DEFAULT '{}'::jsonb,
    classification        TEXT,
    updated_at            TIMESTAMPTZ     DEFAULT NOW(),
    UNIQUE (source_feed, external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_disruption_events_domain_time
    ON disruption_events (source_domain, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_disruption_events_type_status
    ON disruption_events (event_type, status, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_disruption_events_geometry
    ON disruption_events USING GIST (geometry);

CREATE INDEX IF NOT EXISTS idx_disruption_events_centroid
    ON disruption_events USING GIST (centroid);

CREATE INDEX IF NOT EXISTS idx_disruption_events_correlation
    ON disruption_events (correlation_id);

CREATE TABLE IF NOT EXISTS disruption_observations (
    observation_id        UUID            DEFAULT uuid_generate_v4(),
    source_domain         source_domain   NOT NULL,
    source_feed           TEXT            NOT NULL,
    external_event_id     TEXT            NOT NULL,
    track_id              TEXT,
    observed_at           TIMESTAMPTZ     NOT NULL,
    observation_type      TEXT            NOT NULL,
    severity              DOUBLE PRECISION,
    confidence            DOUBLE PRECISION,
    source_trust_score    DOUBLE PRECISION,
    geometry              GEOMETRY(Geometry, 4326),
    centroid              GEOMETRY(Point, 4326),
    raw_payload           JSONB           DEFAULT '{}'::jsonb,
    metadata              JSONB           DEFAULT '{}'::jsonb
);

SELECT create_hypertable(
    'disruption_observations',
    'observed_at',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_disruption_observations_domain_time
    ON disruption_observations (source_domain, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_disruption_observations_feed_event
    ON disruption_observations (source_feed, external_event_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_disruption_observations_geometry
    ON disruption_observations USING GIST (geometry);

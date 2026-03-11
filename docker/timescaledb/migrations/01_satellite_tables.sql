-- ═══════════════════════════════════════════════════════════════
--  Migration 01: Satellite catalog + historical TLE snapshots
--
--  Apply to an existing running database with:
--    docker exec -i sentinel-db psql -U sentinel -d sentinel \
--      < docker/timescaledb/migrations/01_satellite_tables.sql
--
--  These tables are already included in init.sql for fresh installs.
--  This migration is idempotent (IF NOT EXISTS throughout).
-- ═══════════════════════════════════════════════════════════════

-- ── Satellite catalog ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS satellite_catalog (
    norad_id        INTEGER         PRIMARY KEY,
    object_name     TEXT            NOT NULL,
    intl_designator TEXT,
    object_type     TEXT,
    country_code    TEXT,
    launch_date     DATE,
    decay_date      DATE,
    period_min      DOUBLE PRECISION,
    inclination_deg DOUBLE PRECISION,
    apogee_km       DOUBLE PRECISION,
    perigee_km      DOUBLE PRECISION,
    rcs_size        TEXT,
    orbit_class     TEXT,
    operator        TEXT,
    purpose         TEXT,
    contractor      TEXT,
    launch_site     TEXT,
    sources         TEXT[]          DEFAULT '{}',
    last_updated    TIMESTAMPTZ     DEFAULT NOW(),
    metadata        JSONB           DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_satellite_catalog_country
    ON satellite_catalog (country_code);

CREATE INDEX IF NOT EXISTS idx_satellite_catalog_orbit_class
    ON satellite_catalog (orbit_class);

CREATE INDEX IF NOT EXISTS idx_satellite_catalog_object_type
    ON satellite_catalog (object_type);

-- ── Historical TLE snapshots ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS satellite_tles (
    norad_id        INTEGER         NOT NULL,
    epoch           TIMESTAMPTZ     NOT NULL,
    tle_line1       TEXT            NOT NULL,
    tle_line2       TEXT            NOT NULL,
    source          TEXT            NOT NULL,
    ingested_at     TIMESTAMPTZ     DEFAULT NOW(),
    PRIMARY KEY (norad_id, epoch)
);

CREATE INDEX IF NOT EXISTS idx_satellite_tles_norad_epoch
    ON satellite_tles (norad_id, epoch DESC);

-- Grant access to the sentinel user
GRANT ALL ON satellite_catalog TO sentinel;
GRANT ALL ON satellite_tles TO sentinel;

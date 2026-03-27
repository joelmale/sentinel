"""
BaseCollector — abstract base class for all domain collectors.

Every collector inherits from this and implements:
  - async def fetch() -> list[TrackEvent]  — poll source API
  - settings: pydantic Settings subclass

The base class handles:
  - Retry logic with exponential backoff
  - Writing to TimescaleDB (batch upsert)
  - Publishing to Redis Stream (for real-time fan-out)
  - Structured logging + Prometheus metrics stub

Analogy: Each collector is like a specialized foreign correspondent.
They all file dispatches in the same wire format (TrackEvent), using
the same transmission system (Redis + DB). The base class is the
editorial process they all share.
"""

import asyncio
import json
import logging
import math
import os
import time
from abc import ABC, abstractmethod
from datetime import date, datetime
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import asyncpg
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

STREAM_KEY = "sentinel:track_events"
CURRENT_STATE_PREFIX = "sentinel:state:"
DEFAULT_DATABASE_URL = "postgresql+asyncpg://sentinel:sentinel@localhost:5432/sentinel"
DEFAULT_REDIS_URL = "redis://localhost:6379"


def _public_metadata(metadata: dict | None) -> dict:
    if not isinstance(metadata, dict):
        return {}
    return {
        key: value
        for key, value in metadata.items()
        if not (isinstance(key, str) and key.startswith("_"))
    }


def _point_geojson(lon: float | None, lat: float | None) -> str | None:
    if lon is None or lat is None:
        return None
    return json.dumps({
        "type": "Point",
        "coordinates": [lon, lat],
    })


class TrackEventDict:
    """Lightweight dict-based event (avoids Pydantic import in collectors)."""

    @staticmethod
    def create(
        source_domain: str,
        source_feed: str,
        track_id: str,
        timestamp: datetime,
        lon: float | None = None,
        lat: float | None = None,
        callsign: str | None = None,
        altitude_m: float | None = None,
        heading_deg: float | None = None,
        speed_mps: float | None = None,
        classification: str | None = None,
        metadata: dict | None = None,
    ) -> dict:
        return {
            "source_domain": source_domain,
            "source_feed": source_feed,
            "track_id": track_id,
            "callsign": callsign,
            "lon": _finite_or_none(lon),
            "lat": _finite_or_none(lat),
            "altitude_m": _finite_or_none(altitude_m),
            "heading_deg": (_finite_or_none(heading_deg) % 360) if _finite_or_none(heading_deg) is not None else None,
            "speed_mps": _finite_or_none(speed_mps),
            "timestamp": timestamp.isoformat() if isinstance(timestamp, datetime) else timestamp,
            "classification": classification,
            "metadata": metadata or {},
        }


def _finite_or_none(value: float | None) -> float | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def _sanitize_json_value(value):
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _sanitize_json_value(val) for key, val in value.items()}
    if isinstance(value, list):
        return [_sanitize_json_value(item) for item in value]
    return value


def _text_or_none(value: object) -> str | None:
    if value in (None, "", []):
        return None
    text = str(value).strip()
    return text or None


def read_env_text(name: str, default: str = "") -> str:
    file_var = f"{name}_FILE"
    file_path = _text_or_none(os.environ.get(file_var))
    if file_path:
        try:
            return Path(file_path).read_text(encoding="utf-8").strip()
        except OSError as exc:
            logger.warning("Failed to read %s=%s: %s", file_var, file_path, exc)
    return os.environ.get(name, default).strip()


class BaseCollector(ABC):
    DOMAIN: str = "Unknown"
    FEED_NAME: str = "Unknown"
    DEFAULT_SOURCE_TRUST_SCORE: float = 0.7

    def __init__(self, db_url: str, redis_url: str, poll_interval: float = 10.0):
        self.db_url = db_url
        self.redis_url = redis_url
        self.poll_interval = poll_interval
        self._db: asyncpg.Pool | None = None
        self._redis: aioredis.Redis | None = None
        self._running = False
        self._source_run_id: UUID | None = None

    # ── Abstract interface ────────────────────────────────────────
    @abstractmethod
    async def fetch(self) -> list[dict]:
        """Poll the source and return a list of TrackEventDict."""
        ...

    # ── Lifecycle ─────────────────────────────────────────────────
    async def startup(self):
        self._db = await asyncpg.create_pool(
            self.db_url.replace("postgresql+asyncpg://", "postgresql://"),
            min_size=2, max_size=5,
        )
        await self._ensure_storage_model()
        await self._register_source()
        await self._start_source_run()
        self._redis = await aioredis.from_url(
            self.redis_url, encoding="utf-8", decode_responses=True
        )
        # Ensure stream exists
        try:
            await self._redis.xgroup_create(
                STREAM_KEY, f"collector-{self.DOMAIN}", id="$", mkstream=True
            )
        except aioredis.ResponseError as e:
            if "BUSYGROUP" not in str(e):
                raise
        logger.info(f"[{self.FEED_NAME}] Collector started (interval={self.poll_interval}s)")

    async def shutdown(self):
        await self._finish_source_run("stopped")
        if self._db:
            await self._db.close()
        if self._redis:
            await self._redis.aclose()

    async def run(self):
        """Main loop: fetch → write → sleep."""
        await self.startup()
        self._running = True
        consecutive_errors = 0

        while self._running:
            t0 = time.monotonic()
            try:
                events = await self.fetch()
                if events:
                    await self._write_batch(events)
                    logger.info(f"[{self.FEED_NAME}] Wrote {len(events)} events")
                consecutive_errors = 0
            except asyncio.CancelledError:
                break
            except Exception as exc:
                consecutive_errors += 1
                backoff = min(60, 2 ** consecutive_errors)
                await self._record_source_run_error(str(exc))
                logger.error(
                    f"[{self.FEED_NAME}] Fetch error (attempt {consecutive_errors}): {exc}. "
                    f"Backing off {backoff}s"
                )
                await asyncio.sleep(backoff)
                continue

            elapsed = time.monotonic() - t0
            sleep_time = max(0, self.poll_interval - elapsed)
            await asyncio.sleep(sleep_time)

        await self.shutdown()

    # ── Write helpers ─────────────────────────────────────────────
    async def _write_batch(self, events: list[dict]):
        """Write events to TimescaleDB and publish to Redis Stream."""
        history_events = self._events_for_track_history(events)
        current_state_events = self._events_for_current_state(events)
        publish_events = self._events_for_publish(events)
        disruption_events, disruption_observations = self._events_for_disruptions(events)

        tasks = []
        if history_events or current_state_events or disruption_events or disruption_observations:
            tasks.append(
                self._write_to_db(
                    history_events,
                    current_state_events,
                    disruption_events,
                    disruption_observations,
                )
            )
        if publish_events:
            tasks.append(self._publish_to_redis(publish_events))
        if tasks:
            await asyncio.gather(*tasks)
        await self._update_source_run(
            batches_delta=1 if events else 0,
            events_delta=len(events),
            success=bool(events),
        )

    async def _ensure_storage_model(self) -> None:
        statements = [
            """
            CREATE TABLE IF NOT EXISTS entities (
                entity_id UUID PRIMARY KEY,
                entity_type TEXT NOT NULL,
                source_domain source_domain,
                display_name TEXT,
                status TEXT DEFAULT 'active',
                metadata JSONB DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS entity_identifiers (
                id BIGSERIAL PRIMARY KEY,
                entity_id UUID NOT NULL REFERENCES entities(entity_id),
                id_type TEXT NOT NULL,
                id_value TEXT NOT NULL,
                source_feed TEXT NOT NULL DEFAULT '',
                is_primary BOOLEAN DEFAULT FALSE,
                confidence DOUBLE PRECISION DEFAULT 1.0,
                first_seen TIMESTAMPTZ DEFAULT NOW(),
                last_seen TIMESTAMPTZ DEFAULT NOW(),
                metadata JSONB DEFAULT '{}'::jsonb,
                UNIQUE (id_type, id_value, source_feed)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS asset_identity_resolutions (
                source_domain source_domain NOT NULL,
                source_feed TEXT NOT NULL,
                track_id TEXT NOT NULL,
                entity_id UUID NOT NULL REFERENCES entities(entity_id),
                resolution_confidence DOUBLE PRECISION,
                resolution_basis JSONB DEFAULT '{}'::jsonb,
                first_resolved_at TIMESTAMPTZ DEFAULT NOW(),
                last_resolved_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (source_domain, source_feed, track_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS sources (
                source_feed TEXT PRIMARY KEY,
                source_domain source_domain NOT NULL,
                provider TEXT,
                collector_name TEXT,
                default_trust_score DOUBLE PRECISION DEFAULT 0.7,
                update_profile JSONB DEFAULT '{}'::jsonb,
                metadata JSONB DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS source_runs (
                run_id UUID PRIMARY KEY,
                source_feed TEXT NOT NULL REFERENCES sources(source_feed),
                source_domain source_domain NOT NULL,
                collector_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'starting',
                started_at TIMESTAMPTZ DEFAULT NOW(),
                last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
                last_success_at TIMESTAMPTZ,
                ended_at TIMESTAMPTZ,
                batches_written INTEGER DEFAULT 0,
                events_written INTEGER DEFAULT 0,
                last_error TEXT,
                metadata JSONB DEFAULT '{}'::jsonb
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS entity_assertions (
                assertion_id UUID PRIMARY KEY,
                entity_id UUID NOT NULL REFERENCES entities(entity_id),
                attribute_key TEXT NOT NULL,
                asserted_value JSONB NOT NULL,
                source_feed TEXT NOT NULL,
                asserted_at TIMESTAMPTZ NOT NULL,
                confidence DOUBLE PRECISION,
                source_trust_score DOUBLE PRECISION,
                resolution_status TEXT NOT NULL DEFAULT 'active',
                metadata JSONB DEFAULT '{}'::jsonb
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS entity_impacts (
                impact_id UUID PRIMARY KEY,
                source_entity_id UUID NOT NULL REFERENCES entities(entity_id),
                target_entity_id UUID NOT NULL REFERENCES entities(entity_id),
                relationship_type TEXT NOT NULL,
                confidence DOUBLE PRECISION,
                valid_from TIMESTAMPTZ,
                valid_to TIMESTAMPTZ,
                metadata JSONB DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (source_entity_id, target_entity_id, relationship_type)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS entity_enrichments (
                entity_id UUID PRIMARY KEY REFERENCES entities(entity_id),
                source_domain source_domain NOT NULL,
                registration TEXT,
                aircraft_type TEXT,
                ship_type TEXT,
                flag TEXT,
                destination TEXT,
                operator TEXT,
                owner TEXT,
                platform_type TEXT,
                country_code TEXT,
                object_type TEXT,
                orbit_class TEXT,
                purpose TEXT,
                contractor TEXT,
                launch_date DATE,
                launch_site TEXT,
                intl_designator TEXT,
                metadata JSONB DEFAULT '{}'::jsonb,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS asset_observations (
                observation_id UUID PRIMARY KEY,
                entity_id UUID REFERENCES entities(entity_id),
                source_domain source_domain NOT NULL,
                source_feed TEXT NOT NULL,
                source_record_id TEXT,
                observed_at TIMESTAMPTZ NOT NULL,
                ingested_at TIMESTAMPTZ DEFAULT NOW(),
                position GEOMETRY(Point, 4326),
                altitude_m DOUBLE PRECISION,
                heading_deg DOUBLE PRECISION,
                speed_mps DOUBLE PRECISION,
                raw_payload JSONB DEFAULT '{}'::jsonb,
                normalized_payload JSONB DEFAULT '{}'::jsonb,
                classification TEXT,
                source_trust_score DOUBLE PRECISION,
                observation_confidence DOUBLE PRECISION,
                identity_confidence DOUBLE PRECISION
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS asset_current_state (
                entity_id UUID PRIMARY KEY REFERENCES entities(entity_id),
                source_domain source_domain NOT NULL,
                winning_source_feed TEXT,
                track_id TEXT,
                callsign TEXT,
                position GEOMETRY(Point, 4326),
                altitude_m DOUBLE PRECISION,
                heading_deg DOUBLE PRECISION,
                speed_mps DOUBLE PRECISION,
                first_seen TIMESTAMPTZ,
                last_seen TIMESTAMPTZ NOT NULL,
                source_trust_score DOUBLE PRECISION,
                identity_confidence DOUBLE PRECISION,
                state_confidence DOUBLE PRECISION,
                winning_event_id UUID,
                provenance JSONB DEFAULT '{}'::jsonb,
                metadata JSONB DEFAULT '{}'::jsonb,
                classification TEXT,
                fused_at TIMESTAMPTZ DEFAULT NOW()
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS asset_source_states (
                id BIGSERIAL PRIMARY KEY,
                entity_id UUID REFERENCES entities(entity_id),
                source_domain source_domain NOT NULL,
                source_feed TEXT NOT NULL,
                track_id TEXT NOT NULL,
                callsign TEXT,
                position GEOMETRY(Point, 4326),
                altitude_m DOUBLE PRECISION,
                heading_deg DOUBLE PRECISION,
                speed_mps DOUBLE PRECISION,
                first_seen TIMESTAMPTZ,
                last_seen TIMESTAMPTZ NOT NULL,
                source_trust_score DOUBLE PRECISION,
                identity_confidence DOUBLE PRECISION,
                state_confidence DOUBLE PRECISION,
                winning_event_id UUID,
                provenance JSONB DEFAULT '{}'::jsonb,
                metadata JSONB DEFAULT '{}'::jsonb,
                classification TEXT,
                UNIQUE (source_domain, source_feed, track_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS disruption_events (
                id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
                entity_id UUID REFERENCES entities(entity_id),
                source_domain source_domain NOT NULL,
                source_feed TEXT NOT NULL,
                external_event_id TEXT NOT NULL,
                track_id TEXT,
                callsign TEXT,
                event_type TEXT NOT NULL,
                category TEXT NOT NULL,
                title TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                severity DOUBLE PRECISION,
                confidence DOUBLE PRECISION,
                source_trust_score DOUBLE PRECISION,
                entity_confidence DOUBLE PRECISION,
                first_seen TIMESTAMPTZ NOT NULL,
                last_seen TIMESTAMPTZ NOT NULL,
                start_time TIMESTAMPTZ,
                end_time TIMESTAMPTZ,
                valid_from TIMESTAMPTZ,
                valid_to TIMESTAMPTZ,
                expires_at TIMESTAMPTZ,
                geometry GEOMETRY(Geometry, 4326),
                centroid GEOMETRY(Point, 4326),
                h3_cell TEXT,
                measurement_value DOUBLE PRECISION,
                measurement_unit TEXT,
                affected_assets_count INTEGER DEFAULT 0,
                correlation_id UUID,
                provenance JSONB DEFAULT '{}'::jsonb,
                metadata JSONB DEFAULT '{}'::jsonb,
                classification TEXT,
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (source_feed, external_event_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS disruption_observations (
                observation_id UUID DEFAULT uuid_generate_v4(),
                entity_id UUID REFERENCES entities(entity_id),
                source_domain source_domain NOT NULL,
                source_feed TEXT NOT NULL,
                external_event_id TEXT NOT NULL,
                track_id TEXT,
                observed_at TIMESTAMPTZ NOT NULL,
                observation_type TEXT NOT NULL,
                severity DOUBLE PRECISION,
                confidence DOUBLE PRECISION,
                source_trust_score DOUBLE PRECISION,
                geometry GEOMETRY(Geometry, 4326),
                centroid GEOMETRY(Point, 4326),
                raw_payload JSONB DEFAULT '{}'::jsonb,
                metadata JSONB DEFAULT '{}'::jsonb
            )
            """,
            "ALTER TABLE track_events ADD COLUMN IF NOT EXISTS source_observation_id UUID",
            "ALTER TABLE track_events ADD COLUMN IF NOT EXISTS source_record_id TEXT",
            "ALTER TABLE track_events ADD COLUMN IF NOT EXISTS entity_id UUID",
            "ALTER TABLE asset_states ADD COLUMN IF NOT EXISTS entity_id UUID",
            "ALTER TABLE asset_states ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ",
            "ALTER TABLE asset_states ADD COLUMN IF NOT EXISTS source_trust_score DOUBLE PRECISION",
            "ALTER TABLE asset_states ADD COLUMN IF NOT EXISTS identity_confidence DOUBLE PRECISION",
            "ALTER TABLE asset_states ADD COLUMN IF NOT EXISTS state_confidence DOUBLE PRECISION",
            "ALTER TABLE asset_states ADD COLUMN IF NOT EXISTS winning_event_id UUID",
            "ALTER TABLE asset_states ADD COLUMN IF NOT EXISTS provenance JSONB DEFAULT '{}'::jsonb",
            "ALTER TABLE disruption_events ADD COLUMN IF NOT EXISTS entity_id UUID",
            "ALTER TABLE disruption_events ADD COLUMN IF NOT EXISTS entity_confidence DOUBLE PRECISION",
            "ALTER TABLE disruption_events ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ",
            "ALTER TABLE disruption_events ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ",
            "ALTER TABLE disruption_events ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ",
            "ALTER TABLE disruption_events ADD COLUMN IF NOT EXISTS provenance JSONB DEFAULT '{}'::jsonb",
            "ALTER TABLE disruption_observations ADD COLUMN IF NOT EXISTS entity_id UUID",
            """
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'track_events_entity_id_fkey'
                ) THEN
                    ALTER TABLE track_events
                    ADD CONSTRAINT track_events_entity_id_fkey
                    FOREIGN KEY (entity_id) REFERENCES entities(entity_id);
                END IF;
            END $$;
            """,
            """
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'asset_states_entity_id_fkey'
                ) THEN
                    ALTER TABLE asset_states
                    ADD CONSTRAINT asset_states_entity_id_fkey
                    FOREIGN KEY (entity_id) REFERENCES entities(entity_id);
                END IF;
            END $$;
            """,
            """
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'disruption_events_entity_id_fkey'
                ) THEN
                    ALTER TABLE disruption_events
                    ADD CONSTRAINT disruption_events_entity_id_fkey
                    FOREIGN KEY (entity_id) REFERENCES entities(entity_id);
                END IF;
            END $$;
            """,
            """
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'disruption_observations_entity_id_fkey'
                ) THEN
                    ALTER TABLE disruption_observations
                    ADD CONSTRAINT disruption_observations_entity_id_fkey
                    FOREIGN KEY (entity_id) REFERENCES entities(entity_id);
                END IF;
            END $$;
            """,
            "CREATE INDEX IF NOT EXISTS idx_entities_type_domain ON entities (entity_type, source_domain, updated_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entity_identifiers_entity ON entity_identifiers (entity_id, last_seen DESC)",
            "CREATE INDEX IF NOT EXISTS idx_asset_identity_resolutions_entity ON asset_identity_resolutions (entity_id, last_resolved_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_source_runs_feed_started ON source_runs (source_feed, started_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entity_assertions_entity_time ON entity_assertions (entity_id, asserted_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entity_assertions_attr ON entity_assertions (attribute_key, asserted_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entity_impacts_source ON entity_impacts (source_entity_id, relationship_type, updated_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entity_impacts_target ON entity_impacts (target_entity_id, relationship_type, updated_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_entity_enrichments_domain ON entity_enrichments (source_domain, updated_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_asset_observations_entity_time ON asset_observations (entity_id, observed_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_asset_observations_feed_record ON asset_observations (source_feed, source_record_id, observed_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_asset_observations_position ON asset_observations USING GIST (position)",
            "CREATE INDEX IF NOT EXISTS idx_asset_current_state_position ON asset_current_state USING GIST (position)",
            "CREATE INDEX IF NOT EXISTS idx_asset_current_state_domain ON asset_current_state (source_domain, last_seen DESC)",
            "CREATE INDEX IF NOT EXISTS idx_asset_source_states_position ON asset_source_states USING GIST (position)",
            "CREATE INDEX IF NOT EXISTS idx_asset_source_states_domain ON asset_source_states (source_domain, source_feed, last_seen DESC)",
            "CREATE INDEX IF NOT EXISTS idx_asset_source_states_entity ON asset_source_states (entity_id, last_seen DESC)",
            "CREATE INDEX IF NOT EXISTS idx_track_events_entity_ts ON track_events (entity_id, timestamp DESC)",
            "CREATE INDEX IF NOT EXISTS idx_asset_states_entity ON asset_states (entity_id)",
            "CREATE INDEX IF NOT EXISTS idx_disruption_events_domain_time ON disruption_events (source_domain, last_seen DESC)",
            "CREATE INDEX IF NOT EXISTS idx_disruption_events_type_status ON disruption_events (event_type, status, last_seen DESC)",
            "CREATE INDEX IF NOT EXISTS idx_disruption_events_geometry ON disruption_events USING GIST (geometry)",
            "CREATE INDEX IF NOT EXISTS idx_disruption_events_centroid ON disruption_events USING GIST (centroid)",
            "CREATE INDEX IF NOT EXISTS idx_disruption_events_correlation ON disruption_events (correlation_id)",
            "CREATE INDEX IF NOT EXISTS idx_disruption_events_entity ON disruption_events (entity_id)",
            "CREATE INDEX IF NOT EXISTS idx_disruption_observations_domain_time ON disruption_observations (source_domain, observed_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_disruption_observations_feed_event ON disruption_observations (source_feed, external_event_id, observed_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_disruption_observations_entity_time ON disruption_observations (entity_id, observed_at DESC)",
        ]
        async with self._db.acquire() as conn:
            for statement in statements:
                await conn.execute(statement)

    def _asset_entity_id(self, source_domain: str, track_id: str) -> UUID:
        return uuid5(NAMESPACE_URL, f"sentinel:asset:{source_domain}:{track_id}")

    def _disruption_entity_id(self, source_feed: str, external_event_id: str) -> UUID:
        return uuid5(NAMESPACE_URL, f"sentinel:disruption:{source_feed}:{external_event_id}")

    def _entity_id_for_event(self, event: dict) -> UUID:
        resolved = event.get("_entity_id")
        if isinstance(resolved, UUID):
            return resolved
        return self._asset_entity_id(event["source_domain"], str(event["track_id"]))

    def _candidate_identifier_rows_for_asset(
        self,
        event: dict,
        *,
        entity_id: UUID | None = None,
    ) -> list[tuple[str, str, str, bool, float]]:
        metadata = _public_metadata(event.get("metadata"))
        rows: list[tuple[str, str, str, bool, float]] = []

        def add_identifier(id_type: str, raw_value: object, source_feed: str, is_primary: bool, confidence: float) -> None:
            if raw_value in (None, "", []):
                return
            id_value = str(raw_value).strip()
            if not id_value:
                return
            candidate = (id_type, id_value, source_feed, is_primary, confidence)
            if candidate not in rows:
                rows.append(candidate)

        primary_id_type = self._identifier_type_for_domain(event["source_domain"])
        add_identifier(primary_id_type, event["track_id"], "", True, 1.0)
        add_identifier("feed_track_id", event["track_id"], event["source_feed"], False, 0.95)

        if event["source_domain"] == "Air":
            add_identifier("registration", metadata.get("registration"), "", False, 0.85)
            add_identifier("tail_number", metadata.get("registration"), "", False, 0.85)
        elif event["source_domain"] == "Maritime":
            add_identifier("imo", metadata.get("imo"), "", False, 0.9)
        elif event["source_domain"] == "Space":
            add_identifier("intl_designator", metadata.get("intl_designator"), "", False, 0.9)
            add_identifier("catalog_name", metadata.get("object_name") or event.get("callsign"), "", False, 0.55)

        return rows

    async def _resolve_asset_entity_id(self, conn: asyncpg.Connection, event: dict) -> UUID:
        cached = await conn.fetchrow("""
            SELECT entity_id
            FROM asset_identity_resolutions
            WHERE source_domain = $1::source_domain
              AND source_feed = $2
              AND track_id = $3
        """, event["source_domain"], event["source_feed"], str(event["track_id"]))
        if cached and cached["entity_id"] is not None:
            return cached["entity_id"]

        candidates = self._candidate_identifier_rows_for_asset(event)
        resolved_entity_id: UUID | None = None
        resolution_basis = {"mode": "deterministic_fallback", "matched_identifiers": []}
        resolution_confidence = 0.5

        for id_type, id_value, source_feed, _is_primary, confidence in candidates:
            row = await conn.fetchrow("""
                SELECT entity_id
                FROM entity_identifiers
                WHERE id_type = $1
                  AND id_value = $2
                  AND (source_feed = $3 OR source_feed = '' OR $3 = '')
                ORDER BY confidence DESC, last_seen DESC
                LIMIT 1
            """, id_type, id_value, source_feed)
            if row and row["entity_id"] is not None:
                resolved_entity_id = row["entity_id"]
                resolution_basis = {
                    "mode": "identifier_match",
                    "matched_identifiers": [{
                        "id_type": id_type,
                        "id_value": id_value,
                        "source_feed": source_feed,
                    }],
                }
                resolution_confidence = max(confidence, 0.8)
                break

        if resolved_entity_id is None:
            resolved_entity_id = self._asset_entity_id(event["source_domain"], str(event["track_id"]))

        await conn.execute("""
            INSERT INTO entities (entity_id, entity_type, source_domain, display_name, status, metadata)
            VALUES ($1, 'asset', $2::source_domain, $3, 'active', $4::jsonb)
            ON CONFLICT (entity_id) DO UPDATE SET
                display_name = COALESCE(EXCLUDED.display_name, entities.display_name),
                status = EXCLUDED.status,
                metadata = entities.metadata || EXCLUDED.metadata,
                updated_at = NOW()
        """,
            resolved_entity_id,
            event["source_domain"],
            event.get("callsign") or str(event["track_id"]),
            json.dumps({"source_feed": event["source_feed"]}),
        )

        observed_at = event["timestamp"] if isinstance(event["timestamp"], datetime) else datetime.fromisoformat(str(event["timestamp"]).replace("Z", "+00:00"))
        await conn.execute("""
            INSERT INTO asset_identity_resolutions (
                source_domain, source_feed, track_id, entity_id,
                resolution_confidence, resolution_basis, first_resolved_at, last_resolved_at
            )
            VALUES ($1::source_domain, $2, $3, $4, $5, $6::jsonb, $7, $7)
            ON CONFLICT (source_domain, source_feed, track_id) DO UPDATE SET
                entity_id = EXCLUDED.entity_id,
                resolution_confidence = EXCLUDED.resolution_confidence,
                resolution_basis = EXCLUDED.resolution_basis,
                last_resolved_at = EXCLUDED.last_resolved_at
        """,
            event["source_domain"],
            event["source_feed"],
            str(event["track_id"]),
            resolved_entity_id,
            resolution_confidence,
            json.dumps(resolution_basis),
            observed_at,
        )
        return resolved_entity_id

    def _entity_rows_for_assets(self, events: list[dict]) -> list[tuple[UUID, str, str, str | None, str, str]]:
        rows: dict[UUID, tuple[UUID, str, str, str | None, str, str]] = {}
        for event in events:
            entity_id = self._entity_id_for_event(event)
            rows[entity_id] = (
                entity_id,
                "asset",
                event["source_domain"],
                event.get("callsign") or str(event["track_id"]),
                "active",
                json.dumps({"source_feed": event["source_feed"]}),
            )
        return list(rows.values())

    def _entity_rows_for_disruptions(self, events: list[dict]) -> list[tuple[UUID, str, str, str | None, str, str]]:
        rows: dict[UUID, tuple[UUID, str, str, str | None, str, str]] = {}
        for event in events:
            entity_id = self._disruption_entity_id(event["source_feed"], event["external_event_id"])
            rows[entity_id] = (
                entity_id,
                "disruption",
                event["source_domain"],
                event.get("title") or event.get("callsign") or event["external_event_id"],
                event.get("status") or "active",
                json.dumps({"source_feed": event["source_feed"], "event_type": event["event_type"]}),
            )
        return list(rows.values())

    def _identifier_type_for_domain(self, source_domain: str) -> str:
        return {
            "Air": "icao24",
            "Maritime": "mmsi",
            "Space": "norad_id",
            "GPS": "cell_id",
            "Infra": "entity_key",
        }.get(source_domain, "track_id")

    def _identifier_rows_for_assets(self, events: list[dict]) -> list[tuple[UUID, str, str, str, bool, float, datetime, datetime, str]]:
        rows: dict[tuple[str, str, str], tuple[UUID, str, str, str, bool, float, datetime, datetime, str]] = {}
        for event in events:
            observed_at = event["timestamp"] if isinstance(event["timestamp"], datetime) else datetime.fromisoformat(str(event["timestamp"]).replace("Z", "+00:00"))
            entity_id = self._entity_id_for_event(event)
            for id_type, id_value, source_feed, is_primary, confidence in self._candidate_identifier_rows_for_asset(event, entity_id=entity_id):
                rows[(id_type, id_value, source_feed)] = (
                    entity_id,
                    id_type,
                    id_value,
                    source_feed,
                    is_primary,
                    confidence,
                    observed_at,
                    observed_at,
                    json.dumps({"source_domain": event["source_domain"]}),
                )
        return list(rows.values())

    def _identifier_rows_for_disruptions(self, events: list[dict]) -> list[tuple[UUID, str, str, str, bool, float, datetime, datetime, str]]:
        rows: dict[tuple[str, str, str], tuple[UUID, str, str, str, bool, float, datetime, datetime, str]] = {}
        for event in events:
            observed_at = event["last_seen"] if isinstance(event["last_seen"], datetime) else datetime.fromisoformat(str(event["last_seen"]).replace("Z", "+00:00"))
            entity_id = self._disruption_entity_id(event["source_feed"], event["external_event_id"])
            rows[("external_event_id", event["external_event_id"], event["source_feed"])] = (
                entity_id,
                "external_event_id",
                event["external_event_id"],
                event["source_feed"],
                True,
                1.0,
                observed_at,
                observed_at,
                json.dumps({"event_type": event["event_type"]}),
            )
        return list(rows.values())

    def _estimate_source_trust_score(self, event: dict) -> float:
        metadata = event.get("metadata") or {}
        for key in ("source_trust_score", "_source_trust_score"):
            value = metadata.get(key)
            if isinstance(value, (int, float)):
                return float(value)
        return float(self.DEFAULT_SOURCE_TRUST_SCORE)

    def _estimate_identity_confidence(self, event: dict) -> float:
        if event.get("track_id"):
            return 0.95
        return 0.5

    def _estimate_state_confidence(self, event: dict) -> float:
        has_position = event.get("lon") is not None and event.get("lat") is not None
        has_motion = any(event.get(key) is not None for key in ("heading_deg", "speed_mps", "altitude_m"))
        if has_position and has_motion:
            return 0.9
        if has_position:
            return 0.8
        return 0.6

    def _asset_provenance(self, event: dict) -> dict:
        return {
            "source_feed": event["source_feed"],
            "collector": self.FEED_NAME,
            "observed_at": event["timestamp"] if isinstance(event["timestamp"], str) else event["timestamp"].isoformat(),
        }

    def _observation_id(self, event: dict) -> UUID:
        timestamp = event["timestamp"] if isinstance(event["timestamp"], str) else event["timestamp"].isoformat()
        source_record_id = (event.get("metadata") or {}).get("source_record_id") or ""
        return uuid5(
            NAMESPACE_URL,
            f"sentinel:observation:{event['source_feed']}:{event['source_domain']}:{event['track_id']}:{timestamp}:{source_record_id}",
        )

    def _stable_assertion_rows_for_assets(self, events: list[dict]) -> list[tuple[UUID, UUID, str, str, str, datetime, float, float, str, str]]:
        stable_keys = (
            "registration",
            "aircraft_type",
            "origin_country",
            "category",
            "ship_type",
            "destination",
            "flag",
            "object_type",
            "orbit_class",
            "norad_id",
            "operator",
            "purpose",
            "contractor",
            "launch_date",
            "launch_site",
            "intl_designator",
        )
        rows: list[tuple[UUID, UUID, str, str, str, datetime, float, float, str, str]] = []
        for event in events:
            metadata = _public_metadata(event.get("metadata"))
            observed_at = event["timestamp"] if isinstance(event["timestamp"], datetime) else datetime.fromisoformat(str(event["timestamp"]).replace("Z", "+00:00"))
            entity_id = self._entity_id_for_event(event)
            for key in stable_keys:
                value = metadata.get(key)
                if value in (None, "", []):
                    continue
                assertion_id = uuid5(NAMESPACE_URL, f"sentinel:assertion:{entity_id}:{key}:{event['source_feed']}:{observed_at.isoformat()}:{json.dumps(value, sort_keys=True, default=str)}")
                rows.append((
                    assertion_id,
                    entity_id,
                    key,
                    json.dumps(value),
                    event["source_feed"],
                    observed_at,
                    self._estimate_identity_confidence(event),
                    self._estimate_source_trust_score(event),
                    "active",
                    json.dumps({"collector": self.FEED_NAME, "source_domain": event["source_domain"]}),
                ))
        return rows

    def _parse_date_value(self, value: object) -> date | None:
        if value in (None, "", []):
            return None
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            try:
                return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
            except ValueError:
                try:
                    return date.fromisoformat(text[:10])
                except ValueError:
                    return None
        return None

    def _stable_enrichment_rows_for_assets(
        self,
        events: list[dict],
    ) -> list[tuple[UUID, str, str | None, str | None, str | None, str | None, str | None, str | None, str | None, str | None, str | None, str | None, str | None, str | None, date | None, str | None, str | None, str]]:
        rows: dict[
            UUID,
            tuple[
                UUID,
                str,
                str | None,
                str | None,
                str | None,
                str | None,
                str | None,
                str | None,
                str | None,
                str | None,
                str | None,
                str | None,
                str | None,
                str | None,
                date | None,
                str | None,
                str | None,
                str,
            ],
        ] = {}
        structured_keys = {
            "registration",
            "aircraft_type",
            "ship_type",
            "flag",
            "destination",
            "operator",
            "owner",
            "platform_type",
            "country_code",
            "object_type",
            "orbit_class",
            "purpose",
            "contractor",
            "launch_date",
            "launch_site",
            "intl_designator",
        }
        for event in events:
            metadata = _public_metadata(event.get("metadata"))
            entity_id = self._entity_id_for_event(event)
            rows[entity_id] = (
                entity_id,
                event["source_domain"],
                _text_or_none(metadata.get("registration")),
                _text_or_none(metadata.get("aircraft_type")),
                _text_or_none(metadata.get("ship_type")),
                _text_or_none(metadata.get("flag")),
                _text_or_none(metadata.get("destination")),
                _text_or_none(metadata.get("operator")),
                _text_or_none(metadata.get("owner")),
                _text_or_none(metadata.get("platform_type")),
                _text_or_none(metadata.get("country_code")),
                _text_or_none(metadata.get("object_type")),
                _text_or_none(metadata.get("orbit_class")),
                _text_or_none(metadata.get("purpose")),
                _text_or_none(metadata.get("contractor")),
                self._parse_date_value(metadata.get("launch_date")),
                _text_or_none(metadata.get("launch_site")),
                _text_or_none(metadata.get("intl_designator")),
                json.dumps({
                    key: metadata[key]
                    for key in sorted(metadata.keys())
                    if key not in structured_keys
                }),
            )
        return list(rows.values())

    async def _register_source(self) -> None:
        async with self._db.acquire() as conn:
            await conn.execute("""
                INSERT INTO sources (
                    source_feed, source_domain, provider, collector_name,
                    default_trust_score, update_profile, metadata
                )
                VALUES ($1, $2::source_domain, $3, $4, $5, $6::jsonb, $7::jsonb)
                ON CONFLICT (source_feed) DO UPDATE SET
                    source_domain = EXCLUDED.source_domain,
                    provider = EXCLUDED.provider,
                    collector_name = EXCLUDED.collector_name,
                    default_trust_score = EXCLUDED.default_trust_score,
                    update_profile = EXCLUDED.update_profile,
                    metadata = sources.metadata || EXCLUDED.metadata,
                    updated_at = NOW()
            """, self.FEED_NAME, self.DOMAIN, self.FEED_NAME, self.__class__.__name__, self.DEFAULT_SOURCE_TRUST_SCORE,
                 json.dumps({"poll_interval_sec": self.poll_interval}),
                 json.dumps({"collector_class": self.__class__.__name__}))

    async def _start_source_run(self) -> None:
        self._source_run_id = uuid4()
        async with self._db.acquire() as conn:
            await conn.execute("""
                INSERT INTO source_runs (
                    run_id, source_feed, source_domain, collector_name, status, metadata
                )
                VALUES ($1, $2, $3::source_domain, $4, 'running', $5::jsonb)
            """, self._source_run_id, self.FEED_NAME, self.DOMAIN, self.__class__.__name__,
                 json.dumps({"poll_interval_sec": self.poll_interval}))

    async def _update_source_run(self, *, batches_delta: int = 0, events_delta: int = 0, success: bool = False, error: str | None = None) -> None:
        if self._source_run_id is None:
            return
        async with self._db.acquire() as conn:
            await conn.execute("""
                UPDATE source_runs
                SET last_heartbeat = NOW(),
                    last_success_at = CASE WHEN $2 THEN NOW() ELSE last_success_at END,
                    batches_written = batches_written + $3,
                    events_written = events_written + $4,
                    status = CASE WHEN $5::text IS NULL THEN 'running' ELSE 'degraded' END,
                    last_error = COALESCE($5::text, last_error)
                WHERE run_id = $1
            """, self._source_run_id, success, batches_delta, events_delta, error)

    async def _record_source_run_error(self, error: str) -> None:
        await self._update_source_run(error=error)

    async def _finish_source_run(self, status: str) -> None:
        if self._source_run_id is None or self._db is None:
            return
        async with self._db.acquire() as conn:
            await conn.execute("""
                UPDATE source_runs
                SET status = $2,
                    last_heartbeat = NOW(),
                    ended_at = NOW()
                WHERE run_id = $1
            """, self._source_run_id, status)

    def _events_for_track_history(self, events: list[dict]) -> list[dict]:
        return events

    def _events_for_current_state(self, events: list[dict]) -> list[dict]:
        return events

    def _events_for_publish(self, events: list[dict]) -> list[dict]:
        return [
            {**event, "metadata": _public_metadata(event.get("metadata"))}
            for event in events
        ]

    def _events_for_disruptions(self, events: list[dict]) -> tuple[list[dict], list[dict]]:
        disruption_events: list[dict] = []
        disruption_observations: list[dict] = []

        for event in events:
            metadata = event.get("metadata") or {}
            disruption = metadata.get("_disruption")
            if not isinstance(disruption, dict):
                continue

            source_feed = event["source_feed"]
            track_id = str(event["track_id"])
            external_event_id = str(disruption.get("external_event_id") or track_id)
            event_key = f"{source_feed}:{external_event_id}"
            lon = event.get("lon")
            lat = event.get("lat")

            geometry_geojson = disruption.get("geometry_geojson") or _point_geojson(lon, lat)
            centroid_geojson = _point_geojson(lon, lat)
            event_timestamp = event["timestamp"]
            if isinstance(event_timestamp, datetime):
                observed_at = event_timestamp
            else:
                observed_at = datetime.fromisoformat(str(event_timestamp).replace("Z", "+00:00"))

            disruption_events.append({
                "source_domain": event["source_domain"],
                "source_feed": source_feed,
                "external_event_id": external_event_id,
                "track_id": track_id,
                "callsign": event.get("callsign"),
                "event_type": disruption.get("event_type") or "disruption",
                "category": disruption.get("category") or "disruption",
                "title": disruption.get("title") or event.get("callsign") or track_id,
                "status": disruption.get("status") or "active",
                "severity": disruption.get("severity"),
                "confidence": disruption.get("confidence"),
                "source_trust_score": disruption.get("source_trust_score"),
                "first_seen": disruption.get("first_seen") or observed_at,
                "last_seen": disruption.get("last_seen") or observed_at,
                "start_time": disruption.get("start_time") or observed_at,
                "end_time": disruption.get("end_time"),
                "valid_from": disruption.get("valid_from") or disruption.get("start_time") or observed_at,
                "valid_to": disruption.get("valid_to") or disruption.get("end_time"),
                "expires_at": disruption.get("expires_at"),
                "geometry_geojson": geometry_geojson,
                "centroid_geojson": centroid_geojson,
                "h3_cell": disruption.get("h3_cell"),
                "measurement_value": disruption.get("measurement_value"),
                "measurement_unit": disruption.get("measurement_unit"),
                "classification": event.get("classification"),
                "correlation_id": disruption.get("correlation_id") or str(uuid5(NAMESPACE_URL, event_key)),
                "metadata": {
                    **_public_metadata(metadata),
                    **(disruption.get("event_metadata") or {}),
                },
            })
            disruption_observations.append({
                "source_domain": event["source_domain"],
                "source_feed": source_feed,
                "external_event_id": external_event_id,
                "track_id": track_id,
                "observed_at": observed_at,
                "observation_type": disruption.get("observation_type") or "measurement",
                "severity": disruption.get("severity"),
                "confidence": disruption.get("confidence"),
                "source_trust_score": disruption.get("source_trust_score"),
                "geometry_geojson": geometry_geojson,
                "centroid_geojson": centroid_geojson,
                "raw_payload": disruption.get("raw_payload") or _public_metadata(metadata),
                "metadata": {
                    **_public_metadata(metadata),
                    **(disruption.get("observation_metadata") or {}),
                },
            })

        return disruption_events, disruption_observations

    async def _write_to_db(
        self,
        history_events: list[dict],
        current_state_events: list[dict],
        disruption_events: list[dict],
        disruption_observations: list[dict],
    ):
        """Batch insert into track_events and upsert asset_states."""
        def db_timestamp(value):
            if isinstance(value, datetime):
                return value
            if isinstance(value, str):
                text = value.replace("Z", "+00:00")
                return datetime.fromisoformat(text)
            return value

        async with self._db.acquire() as conn:
            asset_events = [*history_events, *current_state_events]
            if asset_events:
                for event in asset_events:
                    if not isinstance(event.get("_entity_id"), UUID):
                        event["_entity_id"] = await self._resolve_asset_entity_id(conn, event)

            entity_rows = self._entity_rows_for_assets(current_state_events) + self._entity_rows_for_disruptions(disruption_events)
            if entity_rows:
                await conn.executemany("""
                    INSERT INTO entities (entity_id, entity_type, source_domain, display_name, status, metadata)
                    VALUES ($1, $2, $3::source_domain, $4, $5, $6::jsonb)
                    ON CONFLICT (entity_id) DO UPDATE SET
                        display_name = COALESCE(EXCLUDED.display_name, entities.display_name),
                        status = EXCLUDED.status,
                        metadata = entities.metadata || EXCLUDED.metadata,
                        updated_at = NOW()
                """, entity_rows)

            identifier_rows = self._identifier_rows_for_assets(current_state_events) + self._identifier_rows_for_disruptions(disruption_events)
            if identifier_rows:
                await conn.executemany("""
                    INSERT INTO entity_identifiers (
                        entity_id, id_type, id_value, source_feed, is_primary,
                        confidence, first_seen, last_seen, metadata
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
                    ON CONFLICT (id_type, id_value, source_feed) DO UPDATE SET
                        entity_id = EXCLUDED.entity_id,
                        is_primary = EXCLUDED.is_primary,
                        confidence = EXCLUDED.confidence,
                        first_seen = LEAST(entity_identifiers.first_seen, EXCLUDED.first_seen),
                        last_seen = GREATEST(entity_identifiers.last_seen, EXCLUDED.last_seen),
                        metadata = entity_identifiers.metadata || EXCLUDED.metadata
                """, identifier_rows)

            assertion_rows = self._stable_assertion_rows_for_assets(current_state_events)
            if assertion_rows:
                await conn.executemany("""
                    INSERT INTO entity_assertions (
                        assertion_id, entity_id, attribute_key, asserted_value, source_feed,
                        asserted_at, confidence, source_trust_score, resolution_status, metadata
                    )
                    VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb)
                    ON CONFLICT (assertion_id) DO NOTHING
                """, assertion_rows)

            enrichment_rows = self._stable_enrichment_rows_for_assets(current_state_events)
            if enrichment_rows:
                await conn.executemany("""
                    INSERT INTO entity_enrichments (
                        entity_id, source_domain, registration, aircraft_type, ship_type, flag,
                        destination, operator, owner, platform_type, country_code, object_type,
                        orbit_class, purpose, contractor, launch_date, launch_site,
                        intl_designator, metadata
                    )
                    VALUES (
                        $1, $2::source_domain, $3, $4, $5, $6,
                        $7, $8, $9, $10, $11, $12,
                        $13, $14, $15, $16, $17,
                        $18, $19::jsonb
                    )
                    ON CONFLICT (entity_id) DO UPDATE SET
                        source_domain = EXCLUDED.source_domain,
                        registration = COALESCE(EXCLUDED.registration, entity_enrichments.registration),
                        aircraft_type = COALESCE(EXCLUDED.aircraft_type, entity_enrichments.aircraft_type),
                        ship_type = COALESCE(EXCLUDED.ship_type, entity_enrichments.ship_type),
                        flag = COALESCE(EXCLUDED.flag, entity_enrichments.flag),
                        destination = COALESCE(EXCLUDED.destination, entity_enrichments.destination),
                        operator = COALESCE(EXCLUDED.operator, entity_enrichments.operator),
                        owner = COALESCE(EXCLUDED.owner, entity_enrichments.owner),
                        platform_type = COALESCE(EXCLUDED.platform_type, entity_enrichments.platform_type),
                        country_code = COALESCE(EXCLUDED.country_code, entity_enrichments.country_code),
                        object_type = COALESCE(EXCLUDED.object_type, entity_enrichments.object_type),
                        orbit_class = COALESCE(EXCLUDED.orbit_class, entity_enrichments.orbit_class),
                        purpose = COALESCE(EXCLUDED.purpose, entity_enrichments.purpose),
                        contractor = COALESCE(EXCLUDED.contractor, entity_enrichments.contractor),
                        launch_date = COALESCE(EXCLUDED.launch_date, entity_enrichments.launch_date),
                        launch_site = COALESCE(EXCLUDED.launch_site, entity_enrichments.launch_site),
                        intl_designator = COALESCE(EXCLUDED.intl_designator, entity_enrichments.intl_designator),
                        metadata = COALESCE(entity_enrichments.metadata, '{}'::jsonb) || EXCLUDED.metadata,
                        updated_at = NOW()
                """, enrichment_rows)

            if history_events:
                await conn.executemany("""
                    INSERT INTO asset_observations
                        (observation_id, entity_id, source_domain, source_feed, source_record_id,
                         observed_at, position, altitude_m, heading_deg, speed_mps,
                         raw_payload, normalized_payload, classification, source_trust_score,
                         observation_confidence, identity_confidence)
                    VALUES
                        ($1, $2, $3, $4, $5,
                         $6,
                         CASE
                              WHEN $7::double precision IS NOT NULL AND $8::double precision IS NOT NULL
                              THEN ST_SetSRID(ST_MakePoint($7::double precision, $8::double precision), 4326)
                              ELSE NULL::geometry(Point, 4326)
                         END,
                         $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17)
                    ON CONFLICT (observation_id) DO NOTHING
                """, [
                    (
                        self._observation_id(e),
                        self._entity_id_for_event(e),
                        e["source_domain"],
                        e["source_feed"],
                        str((e.get("metadata") or {}).get("source_record_id") or f"{e['source_feed']}:{e['track_id']}:{e['timestamp']}"),
                        db_timestamp(e["timestamp"]),
                        e.get("lon"), e.get("lat"),
                        e.get("altitude_m"), e.get("heading_deg"), e.get("speed_mps"),
                        json.dumps((e.get("metadata") or {}).get("raw_payload") or _public_metadata(e.get("metadata"))),
                        json.dumps(_public_metadata(e.get("metadata"))),
                        e.get("classification"),
                        self._estimate_source_trust_score(e),
                        self._estimate_state_confidence(e),
                        self._estimate_identity_confidence(e),
                    )
                    for e in history_events
                ])

            if history_events:
                await conn.executemany("""
                    INSERT INTO track_events
                        (event_id, entity_id, source_observation_id, source_record_id, source_domain, source_feed, track_id, callsign,
                         position, altitude_m, heading_deg, speed_mps,
                         timestamp, metadata, classification)
                    VALUES
                        ($1, $2, $3, $4, $5, $6, $7, $8,
                         CASE
                              WHEN $9::double precision IS NOT NULL AND $10::double precision IS NOT NULL
                              THEN ST_SetSRID(ST_MakePoint($9::double precision, $10::double precision), 4326)
                              ELSE NULL::geometry(Point, 4326)
                         END,
                         $11, $12, $13, $14, $15::jsonb, $16)
                """, [
                    (
                        self._observation_id(e),
                        self._entity_id_for_event(e),
                        self._observation_id(e),
                        str((e.get("metadata") or {}).get("source_record_id") or f"{e['source_feed']}:{e['track_id']}:{e['timestamp']}"),
                        e["source_domain"], e["source_feed"], e["track_id"],
                        e.get("callsign"),
                        e.get("lon"), e.get("lat"),
                        e.get("altitude_m"), e.get("heading_deg"), e.get("speed_mps"),
                        db_timestamp(e["timestamp"]),
                        json.dumps(_public_metadata(e.get("metadata"))),
                        e.get("classification"),
                    )
                    for e in history_events
                ])

            if current_state_events:
                await conn.executemany("""
                    INSERT INTO asset_source_states
                        (entity_id, source_domain, source_feed, track_id, callsign,
                         position, altitude_m, heading_deg, speed_mps,
                         first_seen, last_seen, source_trust_score, identity_confidence, state_confidence,
                         winning_event_id, provenance, metadata, classification)
                    VALUES
                        ($1, $2, $3, $4, $5,
                         CASE
                              WHEN $6::double precision IS NOT NULL AND $7::double precision IS NOT NULL
                              THEN ST_SetSRID(ST_MakePoint($6::double precision, $7::double precision), 4326)
                              ELSE NULL::geometry(Point, 4326)
                         END,
                         $8, $9, $10, $11, $12, $13, $14, $15,
                         $16::uuid, $17::jsonb, $18::jsonb, $19)
                    ON CONFLICT (source_domain, source_feed, track_id) DO UPDATE SET
                        entity_id = EXCLUDED.entity_id,
                        callsign = EXCLUDED.callsign,
                        position = EXCLUDED.position,
                        altitude_m = EXCLUDED.altitude_m,
                        heading_deg = EXCLUDED.heading_deg,
                        speed_mps = EXCLUDED.speed_mps,
                        first_seen = LEAST(COALESCE(asset_source_states.first_seen, EXCLUDED.first_seen), EXCLUDED.first_seen),
                        last_seen = EXCLUDED.last_seen,
                        source_trust_score = EXCLUDED.source_trust_score,
                        identity_confidence = EXCLUDED.identity_confidence,
                        state_confidence = EXCLUDED.state_confidence,
                        winning_event_id = EXCLUDED.winning_event_id,
                        provenance = COALESCE(asset_source_states.provenance, '{}'::jsonb) || EXCLUDED.provenance,
                        metadata = EXCLUDED.metadata,
                        classification = EXCLUDED.classification
                """, [
                    (
                        self._entity_id_for_event(e),
                        e["source_domain"], e["source_feed"], e["track_id"],
                        e.get("callsign"),
                        e.get("lon"), e.get("lat"),
                        e.get("altitude_m"), e.get("heading_deg"), e.get("speed_mps"),
                        db_timestamp(e["timestamp"]),
                        db_timestamp(e["timestamp"]),
                        self._estimate_source_trust_score(e),
                        self._estimate_identity_confidence(e),
                        self._estimate_state_confidence(e),
                        self._observation_id(e),
                        json.dumps(self._asset_provenance(e)),
                        json.dumps(_public_metadata(e.get("metadata"))),
                        e.get("classification"),
                    )
                    for e in current_state_events
                ])

            if current_state_events:
                await conn.executemany("""
                    INSERT INTO asset_states
                        (entity_id, source_domain, source_feed, track_id, callsign,
                         position, altitude_m, heading_deg, speed_mps,
                         first_seen, last_seen, source_trust_score, identity_confidence, state_confidence,
                         winning_event_id, provenance, metadata, classification)
                    VALUES
                        ($1, $2, $3, $4, $5,
                         CASE
                              WHEN $6::double precision IS NOT NULL AND $7::double precision IS NOT NULL
                              THEN ST_SetSRID(ST_MakePoint($6::double precision, $7::double precision), 4326)
                              ELSE NULL::geometry(Point, 4326)
                         END,
                         $8, $9, $10, $11, $12, $13, $14, $15,
                         $16::uuid, $17::jsonb, $18::jsonb, $19)
                    ON CONFLICT (source_domain, track_id) DO UPDATE SET
                        entity_id       = EXCLUDED.entity_id,
                        callsign       = EXCLUDED.callsign,
                        position       = EXCLUDED.position,
                        altitude_m     = EXCLUDED.altitude_m,
                        heading_deg    = EXCLUDED.heading_deg,
                        speed_mps      = EXCLUDED.speed_mps,
                        first_seen     = LEAST(COALESCE(asset_states.first_seen, EXCLUDED.first_seen), EXCLUDED.first_seen),
                        last_seen      = EXCLUDED.last_seen,
                        source_trust_score = EXCLUDED.source_trust_score,
                        identity_confidence = EXCLUDED.identity_confidence,
                        state_confidence = EXCLUDED.state_confidence,
                        winning_event_id = EXCLUDED.winning_event_id,
                        provenance = COALESCE(asset_states.provenance, '{}'::jsonb) || EXCLUDED.provenance,
                        metadata       = EXCLUDED.metadata,
                        classification = EXCLUDED.classification
                """, [
                    (
                        self._entity_id_for_event(e),
                        e["source_domain"], e["source_feed"], e["track_id"],
                        e.get("callsign"),
                        e.get("lon"), e.get("lat"),
                        e.get("altitude_m"), e.get("heading_deg"), e.get("speed_mps"),
                        db_timestamp(e["timestamp"]),
                        db_timestamp(e["timestamp"]),
                        self._estimate_source_trust_score(e),
                        self._estimate_identity_confidence(e),
                        self._estimate_state_confidence(e),
                        self._observation_id(e),
                        json.dumps(self._asset_provenance(e)),
                        json.dumps(_public_metadata(e.get("metadata"))),
                        e.get("classification"),
                    )
                    for e in current_state_events
                ])

            if current_state_events:
                await conn.executemany("""
                    INSERT INTO asset_current_state (
                        entity_id, source_domain, winning_source_feed, track_id, callsign,
                        position, altitude_m, heading_deg, speed_mps,
                        first_seen, last_seen, source_trust_score, identity_confidence, state_confidence,
                        winning_event_id, provenance, metadata, classification, fused_at
                    )
                    SELECT
                        entity_id,
                        source_domain,
                        source_feed,
                        track_id,
                        callsign,
                        position,
                        altitude_m,
                        heading_deg,
                        speed_mps,
                        first_seen,
                        last_seen,
                        source_trust_score,
                        identity_confidence,
                        state_confidence,
                        winning_event_id,
                        provenance,
                        metadata,
                        classification,
                        NOW()
                    FROM asset_source_states
                    WHERE entity_id = $1::uuid
                    ORDER BY
                        state_confidence DESC NULLS LAST,
                        source_trust_score DESC NULLS LAST,
                        last_seen DESC
                    LIMIT 1
                    ON CONFLICT (entity_id) DO UPDATE SET
                        source_domain = EXCLUDED.source_domain,
                        winning_source_feed = EXCLUDED.winning_source_feed,
                        track_id = COALESCE(EXCLUDED.track_id, asset_current_state.track_id),
                        callsign = COALESCE(EXCLUDED.callsign, asset_current_state.callsign),
                        position = EXCLUDED.position,
                        altitude_m = EXCLUDED.altitude_m,
                        heading_deg = EXCLUDED.heading_deg,
                        speed_mps = EXCLUDED.speed_mps,
                        first_seen = LEAST(COALESCE(asset_current_state.first_seen, EXCLUDED.first_seen), EXCLUDED.first_seen),
                        last_seen = EXCLUDED.last_seen,
                        source_trust_score = EXCLUDED.source_trust_score,
                        identity_confidence = EXCLUDED.identity_confidence,
                        state_confidence = EXCLUDED.state_confidence,
                        winning_event_id = EXCLUDED.winning_event_id,
                        provenance = COALESCE(asset_current_state.provenance, '{}'::jsonb) || EXCLUDED.provenance,
                        metadata = EXCLUDED.metadata,
                        classification = COALESCE(EXCLUDED.classification, asset_current_state.classification),
                        fused_at = NOW()
                """, [
                    (self._entity_id_for_event(event),)
                    for event in {
                        self._entity_id_for_event(e): e
                        for e in current_state_events
                    }.values()
                ])

            if disruption_events:
                await conn.executemany("""
                    INSERT INTO disruption_events
                        (entity_id, source_domain, source_feed, external_event_id, track_id, callsign,
                         event_type, category, title, status, severity, confidence,
                         source_trust_score, entity_confidence, first_seen, last_seen, start_time, end_time, valid_from, valid_to, expires_at,
                         geometry, centroid, h3_cell, measurement_value, measurement_unit,
                         affected_assets_count, correlation_id, provenance, metadata, classification)
                    VALUES
                        ($1, $2, $3, $4, $5, $6,
                         $7, $8, $9, $10, $11, $12,
                         $13, $14, $15, $16, $17, $18, $19, $20, $21,
                         CASE
                              WHEN $22::text IS NOT NULL
                              THEN ST_SetSRID(ST_GeomFromGeoJSON($22::text), 4326)
                              ELSE NULL::geometry(Geometry, 4326)
                         END,
                         CASE
                              WHEN $23::text IS NOT NULL
                              THEN ST_SetSRID(ST_GeomFromGeoJSON($23::text), 4326)
                              ELSE NULL::geometry(Point, 4326)
                         END,
                         $24, $25, $26,
                         0, $27::uuid, $28::jsonb, $29::jsonb, $30)
                    ON CONFLICT (source_feed, external_event_id) DO UPDATE SET
                        entity_id = EXCLUDED.entity_id,
                        track_id = EXCLUDED.track_id,
                        callsign = COALESCE(EXCLUDED.callsign, disruption_events.callsign),
                        event_type = EXCLUDED.event_type,
                        category = EXCLUDED.category,
                        title = COALESCE(EXCLUDED.title, disruption_events.title),
                        status = EXCLUDED.status,
                        severity = EXCLUDED.severity,
                        confidence = EXCLUDED.confidence,
                        source_trust_score = EXCLUDED.source_trust_score,
                        entity_confidence = EXCLUDED.entity_confidence,
                        last_seen = GREATEST(disruption_events.last_seen, EXCLUDED.last_seen),
                        first_seen = LEAST(disruption_events.first_seen, EXCLUDED.first_seen),
                        start_time = COALESCE(disruption_events.start_time, EXCLUDED.start_time),
                        end_time = COALESCE(EXCLUDED.end_time, disruption_events.end_time),
                        valid_from = COALESCE(disruption_events.valid_from, EXCLUDED.valid_from, disruption_events.start_time, EXCLUDED.start_time),
                        valid_to = COALESCE(EXCLUDED.valid_to, disruption_events.valid_to, EXCLUDED.end_time, disruption_events.end_time),
                        expires_at = COALESCE(EXCLUDED.expires_at, disruption_events.expires_at),
                        geometry = COALESCE(EXCLUDED.geometry, disruption_events.geometry),
                        centroid = COALESCE(EXCLUDED.centroid, disruption_events.centroid),
                        h3_cell = COALESCE(EXCLUDED.h3_cell, disruption_events.h3_cell),
                        measurement_value = COALESCE(EXCLUDED.measurement_value, disruption_events.measurement_value),
                        measurement_unit = COALESCE(EXCLUDED.measurement_unit, disruption_events.measurement_unit),
                        correlation_id = EXCLUDED.correlation_id,
                        provenance = COALESCE(disruption_events.provenance, '{}'::jsonb) || EXCLUDED.provenance,
                        metadata = disruption_events.metadata || EXCLUDED.metadata,
                        classification = COALESCE(EXCLUDED.classification, disruption_events.classification),
                        updated_at = NOW(),
                        affected_assets_count = CASE
                            WHEN COALESCE(EXCLUDED.geometry, disruption_events.geometry) IS NULL THEN disruption_events.affected_assets_count
                            ELSE (
                                SELECT COUNT(*)
                                FROM asset_current_state AS a
                                WHERE a.source_domain IN ('Air', 'Maritime', 'Space')
                                  AND a.position IS NOT NULL
                                  AND ST_Intersects(
                                      a.position,
                                      COALESCE(EXCLUDED.geometry, disruption_events.geometry)
                                  )
                            )
                        END
                """, [
                    (
                        self._disruption_entity_id(e["source_feed"], e["external_event_id"]),
                        e["source_domain"], e["source_feed"], e["external_event_id"], e["track_id"], e.get("callsign"),
                        e["event_type"], e["category"], e.get("title"), e["status"], e.get("severity"), e.get("confidence"),
                        e.get("source_trust_score"), e.get("confidence"), db_timestamp(e["first_seen"]), db_timestamp(e["last_seen"]),
                        db_timestamp(e["start_time"]), db_timestamp(e["end_time"]) if e.get("end_time") else None,
                        db_timestamp(e["valid_from"]), db_timestamp(e["valid_to"]) if e.get("valid_to") else None, db_timestamp(e["expires_at"]) if e.get("expires_at") else None,
                        e.get("geometry_geojson"), e.get("centroid_geojson"), e.get("h3_cell"), e.get("measurement_value"),
                        e.get("measurement_unit"), e["correlation_id"], json.dumps({"collector": self.FEED_NAME, "source_feed": e["source_feed"]}), json.dumps(e.get("metadata", {})),
                        e.get("classification"),
                    )
                    for e in disruption_events
                ])
                await conn.executemany("""
                    UPDATE disruption_events AS d
                    SET affected_assets_count = CASE
                        WHEN d.geometry IS NULL THEN 0
                        ELSE (
                            SELECT COUNT(*)
                            FROM asset_current_state AS a
                            WHERE a.source_domain IN ('Air', 'Maritime', 'Space')
                              AND a.position IS NOT NULL
                              AND ST_Intersects(a.position, d.geometry)
                        )
                    END,
                    updated_at = NOW()
                    WHERE d.source_feed = $1
                      AND d.external_event_id = $2
                """, [
                    (e["source_feed"], e["external_event_id"])
                    for e in disruption_events
                ])
                await conn.executemany("""
                    DELETE FROM entity_impacts
                    WHERE source_entity_id = $1
                      AND relationship_type = 'intersects'
                """, [
                    (self._disruption_entity_id(e["source_feed"], e["external_event_id"]),)
                    for e in disruption_events
                ])
                await conn.executemany("""
                    INSERT INTO entity_impacts (
                        impact_id, source_entity_id, target_entity_id, relationship_type,
                        confidence, valid_from, valid_to, metadata
                    )
                    SELECT
                        uuid_generate_v4(),
                        $1::uuid,
                        a.entity_id,
                        'intersects',
                        $2,
                        $3,
                        $4,
                        $5::jsonb
                    FROM disruption_events AS d
                    JOIN asset_current_state AS a
                      ON a.entity_id IS NOT NULL
                     AND a.source_domain IN ('Air', 'Maritime', 'Space')
                     AND a.position IS NOT NULL
                     AND d.geometry IS NOT NULL
                     AND ST_Intersects(a.position, d.geometry)
                    WHERE d.source_feed = $6
                      AND d.external_event_id = $7
                    ON CONFLICT (source_entity_id, target_entity_id, relationship_type) DO UPDATE SET
                        confidence = EXCLUDED.confidence,
                        valid_from = EXCLUDED.valid_from,
                        valid_to = EXCLUDED.valid_to,
                        metadata = entity_impacts.metadata || EXCLUDED.metadata,
                        updated_at = NOW()
                """, [
                    (
                        self._disruption_entity_id(e["source_feed"], e["external_event_id"]),
                        e.get("confidence"),
                        db_timestamp(e.get("valid_from")),
                        db_timestamp(e.get("valid_to")) if e.get("valid_to") else None,
                        json.dumps({"source_feed": e["source_feed"], "event_type": e["event_type"]}),
                        e["source_feed"],
                        e["external_event_id"],
                    )
                    for e in disruption_events
                ])

            if disruption_observations:
                await conn.executemany("""
                    INSERT INTO disruption_observations
                        (entity_id, source_domain, source_feed, external_event_id, track_id,
                         observed_at, observation_type, severity, confidence,
                         source_trust_score, geometry, centroid, raw_payload, metadata)
                    VALUES
                        ($1, $2, $3, $4, $5,
                         $6, $7, $8, $9,
                         $10,
                         CASE
                              WHEN $11::text IS NOT NULL
                              THEN ST_SetSRID(ST_GeomFromGeoJSON($11::text), 4326)
                              ELSE NULL::geometry(Geometry, 4326)
                         END,
                         CASE
                              WHEN $12::text IS NOT NULL
                              THEN ST_SetSRID(ST_GeomFromGeoJSON($12::text), 4326)
                              ELSE NULL::geometry(Point, 4326)
                         END,
                         $13::jsonb, $14::jsonb)
                """, [
                    (
                        self._disruption_entity_id(obs["source_feed"], obs["external_event_id"]),
                        obs["source_domain"], obs["source_feed"], obs["external_event_id"], obs["track_id"],
                        db_timestamp(obs["observed_at"]), obs["observation_type"], obs.get("severity"), obs.get("confidence"),
                        obs.get("source_trust_score"), obs.get("geometry_geojson"), obs.get("centroid_geojson"),
                        json.dumps(obs.get("raw_payload", {})), json.dumps(obs.get("metadata", {})),
                    )
                    for obs in disruption_observations
                ])

    async def _publish_to_redis(self, events: list[dict]):
        """Publish each event to Redis Stream for WebSocket fan-out."""
        pipe = self._redis.pipeline()
        for event in events:
            safe_event = _sanitize_json_value(event)
            pipe.xadd(
                STREAM_KEY,
                {"payload": json.dumps(safe_event, allow_nan=False)},
                maxlen=50_000,   # trim stream to ~50k most recent events
                approximate=True,
            )
        await pipe.execute()

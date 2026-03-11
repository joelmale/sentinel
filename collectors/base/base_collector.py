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
import time
from abc import ABC, abstractmethod
from datetime import datetime
from uuid import NAMESPACE_URL, uuid5

import asyncpg
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

STREAM_KEY = "sentinel:track_events"
CURRENT_STATE_PREFIX = "sentinel:state:"


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
            "lon": lon,
            "lat": lat,
            "altitude_m": altitude_m,
            "heading_deg": heading_deg % 360 if heading_deg is not None else None,
            "speed_mps": speed_mps,
            "timestamp": timestamp.isoformat() if isinstance(timestamp, datetime) else timestamp,
            "classification": classification,
            "metadata": metadata or {},
        }


class BaseCollector(ABC):
    DOMAIN: str = "Unknown"
    FEED_NAME: str = "Unknown"

    def __init__(self, db_url: str, redis_url: str, poll_interval: float = 10.0):
        self.db_url = db_url
        self.redis_url = redis_url
        self.poll_interval = poll_interval
        self._db: asyncpg.Pool | None = None
        self._redis: aioredis.Redis | None = None
        self._running = False

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
            if history_events:
                await conn.executemany("""
                    INSERT INTO track_events
                        (source_domain, source_feed, track_id, callsign,
                         position, altitude_m, heading_deg, speed_mps,
                         timestamp, metadata, classification)
                    VALUES
                        ($1, $2, $3, $4,
                         CASE
                              WHEN $5::double precision IS NOT NULL AND $6::double precision IS NOT NULL
                              THEN ST_SetSRID(ST_MakePoint($5::double precision, $6::double precision), 4326)
                              ELSE NULL::geometry(Point, 4326)
                         END,
                         $7, $8, $9, $10, $11::jsonb, $12)
                """, [
                    (
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
                    INSERT INTO asset_states
                        (source_domain, source_feed, track_id, callsign,
                         position, altitude_m, heading_deg, speed_mps,
                         last_seen, metadata, classification)
                    VALUES
                        ($1, $2, $3, $4,
                         CASE
                              WHEN $5::double precision IS NOT NULL AND $6::double precision IS NOT NULL
                              THEN ST_SetSRID(ST_MakePoint($5::double precision, $6::double precision), 4326)
                              ELSE NULL::geometry(Point, 4326)
                         END,
                         $7, $8, $9, $10, $11::jsonb, $12)
                    ON CONFLICT (source_domain, track_id) DO UPDATE SET
                        callsign       = EXCLUDED.callsign,
                        position       = EXCLUDED.position,
                        altitude_m     = EXCLUDED.altitude_m,
                        heading_deg    = EXCLUDED.heading_deg,
                        speed_mps      = EXCLUDED.speed_mps,
                        last_seen      = EXCLUDED.last_seen,
                        metadata       = EXCLUDED.metadata,
                        classification = EXCLUDED.classification
                """, [
                    (
                        e["source_domain"], e["source_feed"], e["track_id"],
                        e.get("callsign"),
                        e.get("lon"), e.get("lat"),
                        e.get("altitude_m"), e.get("heading_deg"), e.get("speed_mps"),
                        db_timestamp(e["timestamp"]),
                        json.dumps(_public_metadata(e.get("metadata"))),
                        e.get("classification"),
                    )
                    for e in current_state_events
                ])

            if disruption_events:
                await conn.executemany("""
                    INSERT INTO disruption_events
                        (source_domain, source_feed, external_event_id, track_id, callsign,
                         event_type, category, title, status, severity, confidence,
                         source_trust_score, first_seen, last_seen, start_time, end_time,
                         geometry, centroid, h3_cell, measurement_value, measurement_unit,
                         affected_assets_count, correlation_id, metadata, classification)
                    VALUES
                        ($1, $2, $3, $4, $5,
                         $6, $7, $8, $9, $10, $11,
                         $12, $13, $14, $15, $16,
                         CASE
                              WHEN $17::text IS NOT NULL
                              THEN ST_SetSRID(ST_GeomFromGeoJSON($17::text), 4326)
                              ELSE NULL::geometry(Geometry, 4326)
                         END,
                         CASE
                              WHEN $18::text IS NOT NULL
                              THEN ST_SetSRID(ST_GeomFromGeoJSON($18::text), 4326)
                              ELSE NULL::geometry(Point, 4326)
                         END,
                         $19, $20, $21,
                         0, $22::uuid, $23::jsonb, $24)
                    ON CONFLICT (source_feed, external_event_id) DO UPDATE SET
                        track_id = EXCLUDED.track_id,
                        callsign = COALESCE(EXCLUDED.callsign, disruption_events.callsign),
                        event_type = EXCLUDED.event_type,
                        category = EXCLUDED.category,
                        title = COALESCE(EXCLUDED.title, disruption_events.title),
                        status = EXCLUDED.status,
                        severity = EXCLUDED.severity,
                        confidence = EXCLUDED.confidence,
                        source_trust_score = EXCLUDED.source_trust_score,
                        last_seen = GREATEST(disruption_events.last_seen, EXCLUDED.last_seen),
                        first_seen = LEAST(disruption_events.first_seen, EXCLUDED.first_seen),
                        start_time = COALESCE(disruption_events.start_time, EXCLUDED.start_time),
                        end_time = COALESCE(EXCLUDED.end_time, disruption_events.end_time),
                        geometry = COALESCE(EXCLUDED.geometry, disruption_events.geometry),
                        centroid = COALESCE(EXCLUDED.centroid, disruption_events.centroid),
                        h3_cell = COALESCE(EXCLUDED.h3_cell, disruption_events.h3_cell),
                        measurement_value = COALESCE(EXCLUDED.measurement_value, disruption_events.measurement_value),
                        measurement_unit = COALESCE(EXCLUDED.measurement_unit, disruption_events.measurement_unit),
                        correlation_id = EXCLUDED.correlation_id,
                        metadata = disruption_events.metadata || EXCLUDED.metadata,
                        classification = COALESCE(EXCLUDED.classification, disruption_events.classification),
                        updated_at = NOW(),
                        affected_assets_count = CASE
                            WHEN COALESCE(EXCLUDED.geometry, disruption_events.geometry) IS NULL THEN disruption_events.affected_assets_count
                            ELSE (
                                SELECT COUNT(*)
                                FROM asset_states AS a
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
                        e["source_domain"], e["source_feed"], e["external_event_id"], e["track_id"], e.get("callsign"),
                        e["event_type"], e["category"], e.get("title"), e["status"], e.get("severity"), e.get("confidence"),
                        e.get("source_trust_score"), db_timestamp(e["first_seen"]), db_timestamp(e["last_seen"]),
                        db_timestamp(e["start_time"]), db_timestamp(e["end_time"]) if e.get("end_time") else None,
                        e.get("geometry_geojson"), e.get("centroid_geojson"), e.get("h3_cell"), e.get("measurement_value"),
                        e.get("measurement_unit"), e["correlation_id"], json.dumps(e.get("metadata", {})),
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
                            FROM asset_states AS a
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

            if disruption_observations:
                await conn.executemany("""
                    INSERT INTO disruption_observations
                        (source_domain, source_feed, external_event_id, track_id,
                         observed_at, observation_type, severity, confidence,
                         source_trust_score, geometry, centroid, raw_payload, metadata)
                    VALUES
                        ($1, $2, $3, $4,
                         $5, $6, $7, $8,
                         $9,
                         CASE
                              WHEN $10::text IS NOT NULL
                              THEN ST_SetSRID(ST_GeomFromGeoJSON($10::text), 4326)
                              ELSE NULL::geometry(Geometry, 4326)
                         END,
                         CASE
                              WHEN $11::text IS NOT NULL
                              THEN ST_SetSRID(ST_GeomFromGeoJSON($11::text), 4326)
                              ELSE NULL::geometry(Point, 4326)
                         END,
                         $12::jsonb, $13::jsonb)
                """, [
                    (
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
            pipe.xadd(
                STREAM_KEY,
                {"payload": json.dumps(event)},
                maxlen=50_000,   # trim stream to ~50k most recent events
                approximate=True,
            )
        await pipe.execute()

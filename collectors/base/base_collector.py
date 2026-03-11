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
from datetime import datetime, timezone

import asyncpg
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

STREAM_KEY = "sentinel:track_events"
CURRENT_STATE_PREFIX = "sentinel:state:"


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

        tasks = []
        if history_events or current_state_events:
            tasks.append(self._write_to_db(history_events, current_state_events))
        if publish_events:
            tasks.append(self._publish_to_redis(publish_events))
        if tasks:
            await asyncio.gather(*tasks)

    def _events_for_track_history(self, events: list[dict]) -> list[dict]:
        return events

    def _events_for_current_state(self, events: list[dict]) -> list[dict]:
        return events

    def _events_for_publish(self, events: list[dict]) -> list[dict]:
        return events

    async def _write_to_db(self, history_events: list[dict], current_state_events: list[dict]):
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
                        json.dumps(e.get("metadata", {})),
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
                        json.dumps(e.get("metadata", {})),
                        e.get("classification"),
                    )
                    for e in current_state_events
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

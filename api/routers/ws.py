"""
WebSocket gateway — real-time event fan-out.

Flow:
  1. Browser connects to /ws/live
  2. Gateway subscribes to Redis Stream consumer group
  3. As collectors write new events → Redis Stream, the gateway
     reads them and pushes delta JSON to all connected sessions.

This is the "live TV broadcast" layer: Redis is the studio feed,
and each WebSocket session is a viewer's TV set. The gateway is
the transmitter tower.
"""

import asyncio
import json
import logging
import math
import socket
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis.asyncio.client import PubSub

from redis_client import CONSUMER_GROUP, STREAM_KEY, get_redis

logger = logging.getLogger(__name__)
router = APIRouter(tags=["WebSocket"])
WS_BATCH_SIZE = 100
MAX_TRACK_STATE_CACHE = 50_000
MIN_DELTA_BYTES_SAVED = 24
WS_BROADCAST_CHANNEL = "sentinel:ws:broadcast"
WS_LEADER_KEY = "sentinel:ws:broadcast:leader"
WS_LEADER_TTL_SECONDS = 15
WS_PENDING_IDLE_MS = 30_000
WS_FAILOVER_PENDING_IDLE_MS = 5_000
WS_FAILOVER_RECLAIM_ROUNDS = 5
INSTANCE_ID = f"{socket.gethostname()}:{uuid.uuid4().hex[:8]}"

# Track active connections in-process
# In production with multiple API replicas, move this to Redis pub/sub
active_connections: set[WebSocket] = set()
stream_fanout_task: asyncio.Task[None] | None = None
pubsub_fanout_task: asyncio.Task[None] | None = None
last_sent_track_cache: dict[str, dict[str, Any]] = {}
ws_runtime_metrics: dict[str, Any] = {
    "published_messages": 0,
    "published_track_events": 0,
    "published_track_deltas": 0,
    "received_pubsub_messages": 0,
    "last_published_at": None,
    "last_pubsub_received_at": None,
    "last_pubsub_lag_ms": None,
    "last_leader_renewed_at": None,
    "last_failover_reclaim_at": None,
    "last_failover_reclaim_count": 0,
}


class ConnectionManager:
    def __init__(self):
        self.connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.connections.add(websocket)
        logger.info(f"WS connected. Total: {len(self.connections)}")

    def disconnect(self, websocket: WebSocket):
        self.connections.discard(websocket)
        logger.info(f"WS disconnected. Total: {len(self.connections)}")

    async def broadcast_local(self, message: dict[str, Any]):
        if not self.connections:
            return
        data = json.dumps(_sanitize_json_value(message), allow_nan=False)
        dead = set()
        for ws in self.connections:
            try:
                await ws.send_text(data)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()


def _sanitize_json_value(value):
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _sanitize_json_value(val) for key, val in value.items()}
    if isinstance(value, list):
        return [_sanitize_json_value(item) for item in value]
    return value


def _track_stream_key(event: dict[str, Any]) -> str | None:
    source_domain = event.get("source_domain")
    track_id = event.get("track_id")
    if not source_domain or not track_id:
        return None
    return f"{source_domain}:{track_id}"


def _build_track_delta(previous: dict[str, Any], current: dict[str, Any]) -> dict[str, Any] | None:
    delta: dict[str, Any] = {
        "source_domain": current["source_domain"],
        "track_id": current["track_id"],
        "timestamp": current.get("timestamp"),
    }

    changed = False
    for key, value in current.items():
        if key in {"source_domain", "track_id", "timestamp"}:
            continue
        if previous.get(key) != value:
            delta[key] = value
            changed = True

    return delta if changed else None


def _should_emit_delta(current: dict[str, Any], delta: dict[str, Any]) -> bool:
    full_size = len(json.dumps(current, separators=(",", ":"), sort_keys=True))
    delta_size = len(json.dumps(delta, separators=(",", ":"), sort_keys=True))
    return delta_size + MIN_DELTA_BYTES_SAVED < full_size


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _publish_ws_message(redis, message: dict[str, Any]) -> None:
    payload = {
        "origin": INSTANCE_ID,
        "published_at": _utc_now_iso(),
        "payload": message,
    }
    ws_runtime_metrics["published_messages"] += 1
    if message.get("type") == "track_events":
        ws_runtime_metrics["published_track_events"] += message.get("count", 0)
    elif message.get("type") == "track_deltas":
        ws_runtime_metrics["published_track_deltas"] += message.get("count", 0)
    ws_runtime_metrics["last_published_at"] = payload["published_at"]
    await manager.broadcast_local(message)
    await redis.publish(WS_BROADCAST_CHANNEL, json.dumps(payload, separators=(",", ":"), allow_nan=False))


async def _fanout_pubsub_loop() -> None:
    redis = await get_redis()
    pubsub: PubSub = redis.pubsub()
    await pubsub.subscribe(WS_BROADCAST_CHANNEL)
    try:
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message is None:
                await asyncio.sleep(0.05)
                continue
            raw = message.get("data")
            if not isinstance(raw, str):
                continue
            try:
                envelope = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(envelope, dict):
                continue
            if envelope.get("origin") == INSTANCE_ID:
                continue
            payload = envelope.get("payload")
            if isinstance(payload, dict):
                published_at = envelope.get("published_at")
                ws_runtime_metrics["received_pubsub_messages"] += 1
                ws_runtime_metrics["last_pubsub_received_at"] = _utc_now_iso()
                if isinstance(published_at, str):
                    published_ts = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                    ws_runtime_metrics["last_pubsub_lag_ms"] = max(
                        0,
                        round((datetime.now(timezone.utc) - published_ts).total_seconds() * 1000, 2),
                    )
                await manager.broadcast_local(_sanitize_json_value(payload))
    except asyncio.CancelledError:
        pass
    finally:
        await pubsub.unsubscribe(WS_BROADCAST_CHANNEL)
        await pubsub.aclose()


async def _maintain_leader(redis) -> bool:
    current = await redis.get(WS_LEADER_KEY)
    if current == INSTANCE_ID:
        await redis.expire(WS_LEADER_KEY, WS_LEADER_TTL_SECONDS)
        ws_runtime_metrics["last_leader_renewed_at"] = _utc_now_iso()
        return True
    acquired = await redis.set(WS_LEADER_KEY, INSTANCE_ID, ex=WS_LEADER_TTL_SECONDS, nx=True)
    if acquired:
        ws_runtime_metrics["last_leader_renewed_at"] = _utc_now_iso()
    return bool(acquired)


async def _claim_pending_entries(
    redis,
    *,
    min_idle_ms: int = WS_PENDING_IDLE_MS,
    max_rounds: int | None = None,
) -> int:
    next_start = "0-0"
    claimed_total = 0
    rounds = 0
    while True:
        if max_rounds is not None and rounds >= max_rounds:
            return claimed_total
        rounds += 1
        entries = await redis.xautoclaim(
            STREAM_KEY,
            CONSUMER_GROUP,
            INSTANCE_ID,
            min_idle_time=min_idle_ms,
            start_id=next_start,
            count=WS_BATCH_SIZE,
        )
        if not entries:
            return claimed_total
        next_start = entries[0] if isinstance(entries[0], str) else "0-0"
        claimed = entries[1] if len(entries) > 1 else []
        if not claimed:
            return claimed_total
        claimed_total += len(claimed)
        await _publish_stream_entries(redis, claimed)


async def _publish_stream_entries(redis, entries) -> None:
    events = []
    deltas = []
    entry_ids: list[str] = []
    for entry_id, fields in entries:
        entry_ids.append(entry_id)
        try:
            event_data = json.loads(fields.get("payload", "{}"))
        except json.JSONDecodeError:
            continue

        if isinstance(event_data, dict) and event_data.get("type") in {"alert", "anomaly", "incident"}:
            await _publish_ws_message(redis, _sanitize_json_value(event_data))
            continue
        if not isinstance(event_data, dict):
            events.append(_sanitize_json_value(event_data))
            continue

        sanitized_event = _sanitize_json_value(event_data)
        if not isinstance(sanitized_event, dict):
            events.append(sanitized_event)
            continue

        track_key = _track_stream_key(sanitized_event)
        if not track_key:
            events.append(sanitized_event)
            continue

        previous_event = last_sent_track_cache.get(track_key)
        if previous_event is None:
            events.append(sanitized_event)
        else:
            delta = _build_track_delta(previous_event, sanitized_event)
            if delta is not None:
                if _should_emit_delta(sanitized_event, delta):
                    deltas.append(delta)
                else:
                    events.append(sanitized_event)
        last_sent_track_cache.pop(track_key, None)
        last_sent_track_cache[track_key] = sanitized_event
        if len(last_sent_track_cache) > MAX_TRACK_STATE_CACHE:
            last_sent_track_cache.pop(next(iter(last_sent_track_cache)))

    if events:
        for i in range(0, len(events), WS_BATCH_SIZE):
            chunk = events[i:i + WS_BATCH_SIZE]
            await _publish_ws_message(redis, {
                "type": "track_events",
                "events": chunk,
                "count": len(chunk),
            })
    if deltas:
        for i in range(0, len(deltas), WS_BATCH_SIZE):
            chunk = deltas[i:i + WS_BATCH_SIZE]
            await _publish_ws_message(redis, {
                "type": "track_deltas",
                "deltas": chunk,
                "count": len(chunk),
            })

    if entry_ids:
        await redis.xack(STREAM_KEY, CONSUMER_GROUP, *entry_ids)

async def _stream_fanout_loop() -> None:
    redis = await get_redis()
    was_leader = False
    try:
        while True:
            if not await _maintain_leader(redis):
                was_leader = False
                await asyncio.sleep(1)
                continue

            if not was_leader:
                reclaimed = await _claim_pending_entries(
                    redis,
                    min_idle_ms=WS_FAILOVER_PENDING_IDLE_MS,
                    max_rounds=WS_FAILOVER_RECLAIM_ROUNDS,
                )
                ws_runtime_metrics["last_failover_reclaim_at"] = _utc_now_iso()
                ws_runtime_metrics["last_failover_reclaim_count"] = reclaimed

            await _claim_pending_entries(redis)
            was_leader = True
            messages = await redis.xreadgroup(
                groupname=CONSUMER_GROUP,
                consumername=INSTANCE_ID,
                streams={STREAM_KEY: ">"},
                count=WS_BATCH_SIZE,
                block=1000,
            )
            if not messages:
                continue

            for _, entries in messages:
                await _publish_stream_entries(redis, entries)
    except asyncio.CancelledError:
        pass


async def startup_ws_broadcast() -> None:
    global stream_fanout_task, pubsub_fanout_task
    if stream_fanout_task is None or stream_fanout_task.done():
        stream_fanout_task = asyncio.create_task(_stream_fanout_loop())
    if pubsub_fanout_task is None or pubsub_fanout_task.done():
        pubsub_fanout_task = asyncio.create_task(_fanout_pubsub_loop())


async def shutdown_ws_broadcast() -> None:
    global stream_fanout_task, pubsub_fanout_task
    for task in (stream_fanout_task, pubsub_fanout_task):
        if task is None:
            continue
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    stream_fanout_task = None
    pubsub_fanout_task = None


async def get_ws_broadcast_snapshot() -> dict[str, Any]:
    redis = await get_redis()
    leader_instance = await redis.get(WS_LEADER_KEY)
    stream_length = await redis.xlen(STREAM_KEY)
    group_pending = 0
    group_consumers = 0
    try:
        groups = await redis.xinfo_groups(STREAM_KEY)
    except Exception:
        groups = []
    for group in groups:
        if group.get("name") == CONSUMER_GROUP:
            group_pending = int(group.get("pending", 0) or 0)
            group_consumers = int(group.get("consumers", 0) or 0)
            break

    return {
        "generated_at": _utc_now_iso(),
        "instance_id": INSTANCE_ID,
        "leader_instance": leader_instance,
        "is_leader": leader_instance == INSTANCE_ID,
        "local_connections": len(manager.connections),
        "stream_fanout_active": stream_fanout_task is not None and not stream_fanout_task.done(),
        "pubsub_fanout_active": pubsub_fanout_task is not None and not pubsub_fanout_task.done(),
        "stream_length": stream_length,
        "group_pending": group_pending,
        "group_consumers": group_consumers,
        "runtime": dict(ws_runtime_metrics),
    }


@router.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    """
    Stream live track events to browser.
    Sends a batch of new events every ~1 second.
    """
    await manager.connect(websocket)

    try:
        await websocket.send_json({"type": "connected", "message": "SENTINEL live stream"})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)

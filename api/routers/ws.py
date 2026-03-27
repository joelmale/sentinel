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
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis_client import STREAM_KEY, get_redis

logger = logging.getLogger(__name__)
router = APIRouter(tags=["WebSocket"])
WS_BATCH_SIZE = 100

# Track active connections in-process
# In production with multiple API replicas, move this to Redis pub/sub
active_connections: set[WebSocket] = set()


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

    async def broadcast(self, message: dict[str, Any]):
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


@router.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    """
    Stream live track events to browser.
    Sends a batch of new events every ~1 second.
    """
    await manager.connect(websocket)
    redis = await get_redis()

    # Send initial snapshot of current state
    try:
        await websocket.send_json({"type": "connected", "message": "SENTINEL live stream"})

        # Poll Redis Stream for new events
        last_id = "$"  # only new messages from this point
        last_sent_tracks: dict[str, dict[str, Any]] = {}
        while True:
            try:
                # Block up to 1 second for new messages
                messages = await redis.xread(
                    {STREAM_KEY: last_id}, count=WS_BATCH_SIZE, block=1000
                )
                if messages:
                    events = []
                    deltas = []
                    for _, entries in messages:
                        for entry_id, fields in entries:
                            last_id = entry_id
                            try:
                                event_data = json.loads(fields.get("payload", "{}"))
                                if isinstance(event_data, dict) and event_data.get("type") in {"alert", "anomaly", "incident"}:
                                    await websocket.send_json(_sanitize_json_value(event_data))
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

                                previous_event = last_sent_tracks.get(track_key)
                                if previous_event is None:
                                    events.append(sanitized_event)
                                else:
                                    delta = _build_track_delta(previous_event, sanitized_event)
                                    if delta is not None:
                                        deltas.append(delta)
                                last_sent_tracks[track_key] = sanitized_event
                            except json.JSONDecodeError:
                                pass

                    if events:
                        for i in range(0, len(events), WS_BATCH_SIZE):
                            chunk = events[i:i + WS_BATCH_SIZE]
                            await websocket.send_json({
                                "type": "track_events",
                                "events": chunk,
                                "count": len(chunk),
                            })
                    if deltas:
                        for i in range(0, len(deltas), WS_BATCH_SIZE):
                            chunk = deltas[i:i + WS_BATCH_SIZE]
                            await websocket.send_json({
                                "type": "track_deltas",
                                "deltas": chunk,
                                "count": len(chunk),
                            })
            except asyncio.CancelledError:
                break

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)

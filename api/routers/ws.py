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
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis_client import CONSUMER_GROUP, STREAM_KEY, get_redis

logger = logging.getLogger(__name__)
router = APIRouter(tags=["WebSocket"])

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
        data = json.dumps(message)
        dead = set()
        for ws in self.connections:
            try:
                await ws.send_text(data)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()


@router.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    """
    Stream live track events to browser.
    Sends a batch of new events every ~1 second.
    """
    await manager.connect(websocket)
    redis = await get_redis()
    consumer_name = f"ws-{id(websocket)}"

    # Send initial snapshot of current state
    try:
        await websocket.send_json({"type": "connected", "message": "SENTINEL live stream"})

        # Poll Redis Stream for new events
        last_id = "$"  # only new messages from this point
        while True:
            try:
                # Block up to 1 second for new messages
                messages = await redis.xread(
                    {STREAM_KEY: last_id}, count=500, block=1000
                )
                if messages:
                    events = []
                    for _, entries in messages:
                        for entry_id, fields in entries:
                            last_id = entry_id
                            try:
                                event_data = json.loads(fields.get("payload", "{}"))
                                events.append(event_data)
                            except json.JSONDecodeError:
                                pass

                    if events:
                        await websocket.send_json({
                            "type": "track_events",
                            "events": events,
                            "count": len(events),
                        })
            except asyncio.CancelledError:
                break

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)

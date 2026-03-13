"""
Redis client — used for two purposes:
  1. Real-time pub/sub: collectors publish TrackEvents to a stream;
     the WebSocket gateway consumes and fans out to browser sessions.
  2. Current-state cache: latest known position/state per track_id,
     reducing DB load for the "show me everything live right now" query.

Architecture analogy: Redis Streams are like a shared whiteboard in
a newsroom. Collectors write headlines as they come in. The WebSocket
gateway sits at the whiteboard and relays each new headline to all
the journalists (browser sessions) watching it.
"""

import redis.asyncio as aioredis  # type: ignore[import]

from settings import Settings

settings = Settings()

# Stream key conventions
STREAM_KEY = "sentinel:track_events"       # all domains, one stream
CONSUMER_GROUP = "sentinel:ws_gateway"      # WebSocket consumers
CURRENT_STATE_PREFIX = "sentinel:state:"    # hash per track_id


class RedisPool:
    def __init__(self) -> None:
        self.client: aioredis.Redis | None = None

    async def startup(self) -> None:
        self.client = await aioredis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            max_connections=50,
        )
        # Ensure consumer group exists (idempotent)
        try:
            await self.client.xgroup_create(
                STREAM_KEY, CONSUMER_GROUP, id="$", mkstream=True
            )
        except aioredis.ResponseError as e:
            if "BUSYGROUP" not in str(e):
                raise

    async def shutdown(self) -> None:
        if self.client:
            await self.client.aclose()


redis_pool = RedisPool()


# FastAPI dependency
async def get_redis() -> aioredis.Redis:
    if redis_pool.client is None:
        raise RuntimeError("Redis client not initialized")
    return redis_pool.client

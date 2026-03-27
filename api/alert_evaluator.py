"""
Alert and anomaly evaluator.

Runs a simple but operationally useful event pipeline:
1. deterministic anomaly detection
2. lightweight incident correlation
3. alert generation + websocket fan-out
"""

import asyncio
import logging

import asyncpg

from event_pipeline import (
    correlate_incidents,
    create_alerts_for_anomalies,
    detect_anomalies,
    ensure_runtime_schema,
    upsert_anomalies,
)
from redis_client import redis_pool
from settings import Settings

log = logging.getLogger(__name__)

EVAL_INTERVAL = 30


async def _evaluate_once(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        await ensure_runtime_schema(conn)
        redis = redis_pool.client
        anomalies = await detect_anomalies(conn)
        upserted = await upsert_anomalies(conn, redis, anomalies)
        await correlate_incidents(conn, redis)
        await create_alerts_for_anomalies(conn, redis, upserted)


async def alert_evaluator_loop() -> None:
    settings = Settings()
    log.info("[EventPipeline] Starting (interval=%ds)", EVAL_INTERVAL)
    pool = None
    while True:
        try:
            if pool is None:
                database_url = settings.DATABASE_URL.replace("+asyncpg", "")
                pool = await asyncpg.create_pool(database_url, min_size=1, max_size=3)
            await _evaluate_once(pool)
        except Exception:
            log.exception("[EventPipeline] Evaluation error")
        await asyncio.sleep(EVAL_INTERVAL)

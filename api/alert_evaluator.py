"""
Alert Evaluator — background task that runs every 30 seconds.

Queries asset_states against active alert_rules and fires alert_events.
Publishes alerts to the Redis Stream for WebSocket delivery to browsers.

Rule evaluation logic:
  - domain: must match asset's source_domain
  - bbox: if set (JSON [min_lon, min_lat, max_lon, max_lat]), asset must be inside
  - classification: if set, must match asset's classification
"""
import asyncio
import json
import logging

import asyncpg

from settings import Settings

log = logging.getLogger(__name__)

EVAL_INTERVAL = 30  # seconds


async def _evaluate_once(pool: asyncpg.Pool) -> None:
    """Run one evaluation cycle against all active rules."""
    async with pool.acquire() as conn:
        # Load active rules
        rules = await conn.fetch(
            "SELECT id, domain, conditions FROM alert_rules WHERE is_active = true"
        )
        if not rules:
            return

        for rule in rules:
            rule_id = rule["id"]
            domain = rule["domain"]
            conditions = rule["conditions"] if isinstance(rule["conditions"], dict) else json.loads(rule["conditions"])

            # Build spatial filter
            bbox = conditions.get("bbox")  # [min_lon, min_lat, max_lon, max_lat]
            classification = conditions.get("classification")

            # Query matching assets
            query = "SELECT track_id, classification, lon, lat, last_seen FROM asset_states WHERE source_domain = $1"
            args = [domain]
            p = 2

            if bbox and len(bbox) == 4:
                query += f" AND position && ST_MakeEnvelope(${p}, ${p+1}, ${p+2}, ${p+3}, 4326)"
                args.extend(bbox)
                p += 4

            if classification:
                query += f" AND classification = ${p}"
                args.append(classification)
                p += 1

            assets = await conn.fetch(query, *args)
            if not assets:
                continue

            # For each matching asset, check if alert already open
            for asset in assets:
                track_id = asset["track_id"]
                existing = await conn.fetchrow(
                    """SELECT id FROM alert_events
                       WHERE rule_id = $1 AND track_id = $2 AND status = 'open'
                       ORDER BY triggered_at DESC LIMIT 1""",
                    rule_id, track_id
                )
                if existing:
                    continue  # already alerted, skip

                # Insert new alert event
                alert_id = await conn.fetchval(
                    """INSERT INTO alert_events (rule_id, track_id, status, triggered_at)
                       VALUES ($1, $2, 'open', now())
                       RETURNING id""",
                    rule_id, track_id
                )

                log.info(f"[ALERT] Rule {rule_id} triggered for {domain}:{track_id} (alert_id={alert_id})")


async def alert_evaluator_loop() -> None:
    """Long-running background task started by FastAPI on_event('startup')."""
    settings = Settings()
    log.info("[AlertEvaluator] Starting (interval=%ds)", EVAL_INTERVAL)
    pool = None
    while True:
        await asyncio.sleep(EVAL_INTERVAL)
        try:
            if pool is None:
                # Remove the +asyncpg part from the URL
                database_url = settings.DATABASE_URL.replace("+asyncpg", "")
                pool = await asyncpg.create_pool(
                    database_url,
                    min_size=1,
                    max_size=3,
                )
            await _evaluate_once(pool)
        except Exception as exc:
            log.error("[AlertEvaluator] Evaluation error: %s", exc)

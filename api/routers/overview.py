"""Bundled operational overview payload for the performance-first landing page."""

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db
from models.track_event import SourceDomain

router = APIRouter(prefix="/overview", tags=["Overview"])
OVERVIEW_CACHE_TTL = timedelta(seconds=20)
_overview_cache: dict[str, Any] | None = None
_overview_cache_expires_at: datetime | None = None


def _iso_or_none(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value)


def _empty_dashboard(now: datetime) -> dict[str, Any]:
    return {
        "header": {
            "generated_at": now.isoformat(),
            "connection": {
                "ws_connected": False,
                "api_ok": True,
                "reconnects": 0,
            },
            "alerts": {
                "active": 0,
                "investigating": 0,
                "critical": 0,
            },
            "ingest": {
                "degraded_sources": 0,
                "stale_sources": 0,
                "last_success_at": None,
            },
        },
        "summary": {
            "generated_at": now.isoformat(),
            "domains": [],
        },
        "alerts": {
            "generated_at": now.isoformat(),
            "items": [],
        },
        "ops": {
            "generated_at": now.isoformat(),
            "source_health": [],
            "watchlist": {
                "enabled": 0,
                "active_tracks": 0,
                "stale_entries": 0,
                "priority_items": 0,
            },
            "disruptions": [],
        },
        "activity": {
            "generated_at": now.isoformat(),
            "activity": [
                {"domain": domain.value, "buckets": []}
                for domain in SourceDomain
            ],
            "top_movers": [],
            "top_aois": [],
            "resume_session": None,
        },
    }


def _empty_core(now: datetime) -> dict[str, Any]:
    dashboard = _empty_dashboard(now)
    return {
        "header": dashboard["header"],
        "summary": dashboard["summary"],
        "alerts": dashboard["alerts"],
        "ops": dashboard["ops"],
    }


def _empty_pivots(now: datetime) -> dict[str, Any]:
    dashboard = _empty_dashboard(now)
    return {
        "activity": dashboard["activity"],
    }


async def _load_core(db: AsyncSession, now: datetime) -> dict[str, Any]:
    core = _empty_core(now)
    summary_sql = text("""
        WITH domain_windows AS (
            SELECT 'Air'::source_domain AS domain, NOW() - INTERVAL '30 minutes' AS cutoff, '30m' AS window_label
            UNION ALL SELECT 'Maritime'::source_domain, NOW() - INTERVAL '12 hours', '12h'
            UNION ALL SELECT 'Space'::source_domain, NOW() - INTERVAL '24 hours', '24h'
            UNION ALL SELECT 'GPS'::source_domain, NOW() - INTERVAL '20 minutes', '20m'
            UNION ALL SELECT 'Infra'::source_domain, NOW() - INTERVAL '24 hours', '24h'
        ),
        live_counts AS (
            SELECT
                dw.domain,
                dw.window_label,
                COUNT(DISTINCT te.track_id) AS live_count
            FROM domain_windows dw
            LEFT JOIN track_events te
              ON te.source_domain = dw.domain
             AND te.timestamp >= dw.cutoff
            GROUP BY dw.domain, dw.window_label
        ),
        stale_counts AS (
            SELECT
                dw.domain,
                COUNT(*) FILTER (WHERE acs.last_seen < dw.cutoff) AS stale_count
            FROM domain_windows dw
            LEFT JOIN asset_current_state acs
              ON acs.source_domain = dw.domain
            GROUP BY dw.domain
        ),
        alert_counts AS (
            SELECT
                ar.domain::source_domain AS domain,
                COUNT(*) FILTER (WHERE ae.status = 'open') AS active_alerts
            FROM alert_rules ar
            LEFT JOIN alert_events ae ON ae.rule_id = ar.id
            GROUP BY ar.domain
        ),
        degraded_counts AS (
            SELECT
                s.source_domain AS domain,
                COUNT(*) FILTER (
                    WHERE sr.run_id IS NULL
                       OR sr.status <> 'running'
                       OR sr.last_success_at IS NULL
                       OR sr.last_success_at < NOW() - INTERVAL '15 minutes'
                ) AS degraded_sources
            FROM sources s
            LEFT JOIN LATERAL (
                SELECT run_id, status, last_success_at
                FROM source_runs
                WHERE source_runs.source_feed = s.source_feed
                ORDER BY started_at DESC
                LIMIT 1
            ) sr ON TRUE
            GROUP BY s.source_domain
        ),
        recent_deltas AS (
            SELECT
                source_domain AS domain,
                COUNT(DISTINCT track_id) FILTER (WHERE timestamp >= NOW() - INTERVAL '15 minutes') AS count_15m,
                COUNT(DISTINCT track_id) FILTER (
                    WHERE timestamp >= NOW() - INTERVAL '30 minutes'
                      AND timestamp < NOW() - INTERVAL '15 minutes'
                ) AS prev_count_15m
            FROM track_events
            WHERE timestamp >= NOW() - INTERVAL '30 minutes'
            GROUP BY source_domain
        )
        SELECT
            lc.domain,
            lc.window_label,
            COALESCE(lc.live_count, 0) AS live_count,
            COALESCE(sc.stale_count, 0) AS stale_count,
            COALESCE(ac.active_alerts, 0) AS active_alerts,
            COALESCE(dc.degraded_sources, 0) AS degraded_sources,
            COALESCE(rd.count_15m, 0) AS count_15m,
            COALESCE(rd.prev_count_15m, 0) AS prev_count_15m
        FROM live_counts lc
        LEFT JOIN stale_counts sc ON sc.domain = lc.domain
        LEFT JOIN alert_counts ac ON ac.domain = lc.domain
        LEFT JOIN degraded_counts dc ON dc.domain = lc.domain
        LEFT JOIN recent_deltas rd ON rd.domain = lc.domain
        ORDER BY lc.domain
    """)
    alerts_sql = text("""
        WITH source_counts AS (
            SELECT entity_id, COUNT(*) AS source_count
            FROM asset_source_states
            GROUP BY entity_id
        )
        SELECT
            ae.id::text AS alert_id,
            ar.domain,
            ar.name AS title,
            ae.track_id,
            ae.triggered_at,
            ae.status,
            ae.payload,
            acs.entity_id::text AS entity_id,
            acs.state_confidence AS confidence,
            acs.classification,
            COALESCE(sc.source_count, 1) AS source_count
        FROM alert_events ae
        JOIN alert_rules ar ON ar.id = ae.rule_id
        LEFT JOIN asset_current_state acs
          ON acs.source_domain = ar.domain
         AND acs.track_id = ae.track_id
        LEFT JOIN source_counts sc ON sc.entity_id = acs.entity_id
        WHERE ae.triggered_at >= NOW() - INTERVAL '7 days'
        ORDER BY
            CASE ae.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
            ae.triggered_at DESC
        LIMIT 18
    """)
    ops_sql = text("""
        WITH latest_runs AS (
            SELECT DISTINCT ON (s.source_feed)
                s.source_feed,
                s.source_domain,
                sr.status,
                sr.last_success_at,
                sr.last_error,
                EXTRACT(EPOCH FROM (NOW() - sr.last_success_at)) / 60.0 AS lag_minutes
            FROM sources s
            LEFT JOIN source_runs sr ON sr.source_feed = s.source_feed
            ORDER BY s.source_feed, sr.started_at DESC
        )
        SELECT
            source_feed,
            source_domain,
            CASE
                WHEN status IS NULL THEN 'down'
                WHEN status <> 'running' THEN 'degraded'
                WHEN last_success_at IS NULL THEN 'stale'
                WHEN last_success_at < NOW() - INTERVAL '15 minutes' THEN 'stale'
                ELSE 'healthy'
            END AS health,
            lag_minutes,
            last_success_at,
            last_error
        FROM latest_runs
        ORDER BY
            CASE
                WHEN status IS NULL THEN 0
                WHEN status <> 'running' THEN 1
                WHEN last_success_at IS NULL THEN 2
                WHEN last_success_at < NOW() - INTERVAL '15 minutes' THEN 3
                ELSE 4
            END,
            lag_minutes DESC NULLS LAST,
            source_feed
        LIMIT 10
    """)
    watchlist_sql = text("""
        SELECT
            COUNT(*) FILTER (WHERE enabled) AS enabled_count,
            COUNT(*) FILTER (WHERE active_track) AS active_track_count,
            COUNT(*) FILTER (WHERE health_status IN ('stale', 'missing', 'degraded')) AS stale_count,
            COUNT(*) FILTER (WHERE priority IN ('critical', 'high')) AS priority_count
        FROM space_watchlist_status
    """)
    disruptions_sql = text("""
        SELECT
            source_domain,
            COUNT(*) FILTER (WHERE status = 'active') AS active_events,
            COUNT(*) FILTER (WHERE status = 'active' AND COALESCE(severity, 0) >= 50) AS high_severity,
            COALESCE(SUM(affected_assets_count) FILTER (WHERE status = 'active'), 0) AS impacted_assets
        FROM disruption_events
        WHERE source_domain IN ('GPS', 'Infra')
          AND last_seen >= NOW() - INTERVAL '72 hours'
        GROUP BY source_domain
        ORDER BY source_domain
    """)

    try:
        summary_rows = (await db.execute(summary_sql)).mappings().all()
    except Exception:
        summary_rows = []
    try:
        alert_rows = (await db.execute(alerts_sql)).mappings().all()
    except Exception:
        alert_rows = []
    try:
        ops_rows = (await db.execute(ops_sql)).mappings().all()
    except Exception:
        ops_rows = []
    try:
        watchlist_row = (await db.execute(watchlist_sql)).mappings().first()
    except Exception:
        watchlist_row = None
    try:
        disruption_rows = (await db.execute(disruptions_sql)).mappings().all()
    except Exception:
        disruption_rows = []

    domains: list[dict[str, Any]] = []
    for row in summary_rows:
        delta = int((row["count_15m"] or 0) - (row["prev_count_15m"] or 0))
        domains.append({
            "domain": row["domain"],
            "live_count": int(row["live_count"] or 0),
            "stale_count": int(row["stale_count"] or 0),
            "active_alerts": int(row["active_alerts"] or 0),
            "degraded_sources": int(row["degraded_sources"] or 0),
            "freshness_window": row["window_label"],
            "top_change": {
                "label": "Recent movement",
                "delta": abs(delta),
                "direction": "up" if delta > 0 else "down" if delta < 0 else "flat",
            } if delta != 0 else None,
        })

    items: list[dict[str, Any]] = []
    active_alerts = 0
    investigating_alerts = 0
    critical_alerts = 0
    for row in alert_rows:
        payload = row["payload"] or {}
        status = row["status"] or "open"
        severity = "critical" if "military" in (row["title"] or "").lower() or row["domain"] == "GPS" else "high" if status == "open" else "medium"
        if status == "open":
            active_alerts += 1
        if status == "acknowledged":
            investigating_alerts += 1
        if severity == "critical":
            critical_alerts += 1
        items.append({
            "alert_id": row["alert_id"],
            "domain": row["domain"],
            "severity": severity,
            "title": row["title"] or row["track_id"] or "Alert",
            "subtitle": row["track_id"],
            "triggered_at": _iso_or_none(row["triggered_at"]),
            "confidence": row["confidence"],
            "why": [f"Status: {status}", f"Sources: {int(row['source_count'] or 1)}"],
            "entity_id": row["entity_id"],
            "track_id": row["track_id"],
            "bbox": payload.get("bbox"),
            "source_count": int(row["source_count"] or 1),
            "investigation_ready": bool(row["track_id"]),
        })

    source_health = [{
        "source_feed": row["source_feed"],
        "domain": row["source_domain"],
        "health": row["health"],
        "lag_minutes": round(float(row["lag_minutes"]), 1) if row["lag_minutes"] is not None else None,
        "last_success_at": _iso_or_none(row["last_success_at"]),
        "error_rate": None,
        "last_error": row["last_error"],
    } for row in ops_rows]

    stale_sources = sum(1 for row in source_health if row["health"] in {"stale", "degraded", "down"})
    degraded_sources = sum(1 for row in source_health if row["health"] in {"degraded", "down"})
    latest_success = next((row["last_success_at"] for row in source_health if row["last_success_at"]), None)
    watchlist = dict(watchlist_row) if watchlist_row is not None else {}
    disruptions = [{
        "domain": row["source_domain"],
        "active_events": int(row["active_events"] or 0),
        "high_severity": int(row["high_severity"] or 0),
        "impacted_assets": int(row["impacted_assets"] or 0),
    } for row in disruption_rows]

    core["header"]["alerts"] = {
        "active": active_alerts,
        "investigating": investigating_alerts,
        "critical": critical_alerts,
    }
    core["header"]["ingest"] = {
        "degraded_sources": degraded_sources,
        "stale_sources": stale_sources,
        "last_success_at": latest_success,
    }
    core["summary"]["domains"] = domains
    core["alerts"]["items"] = items
    core["ops"]["source_health"] = source_health
    core["ops"]["watchlist"] = {
        "enabled": int(watchlist.get("enabled_count") or 0),
        "active_tracks": int(watchlist.get("active_track_count") or 0),
        "stale_entries": int(watchlist.get("stale_count") or 0),
        "priority_items": int(watchlist.get("priority_count") or 0),
    }
    core["ops"]["disruptions"] = disruptions
    return core


async def _load_pivots(db: AsyncSession, now: datetime) -> dict[str, Any]:
    pivots = _empty_pivots(now)
    activity_sql = text("""
        SELECT
            source_domain,
            bucket,
            asset_count
        FROM track_events_1min
        WHERE bucket >= NOW() - INTERVAL '60 minutes'
        ORDER BY source_domain, bucket ASC
    """)
    movers_sql = text("""
        WITH current_window AS (
            SELECT source_domain, classification, COUNT(DISTINCT track_id) AS count_now
            FROM track_events
            WHERE timestamp >= NOW() - INTERVAL '15 minutes'
            GROUP BY source_domain, classification
        ),
        previous_window AS (
            SELECT source_domain, classification, COUNT(DISTINCT track_id) AS count_prev
            FROM track_events
            WHERE timestamp >= NOW() - INTERVAL '30 minutes'
              AND timestamp < NOW() - INTERVAL '15 minutes'
            GROUP BY source_domain, classification
        )
        SELECT
            COALESCE(c.source_domain, p.source_domain) AS source_domain,
            COALESCE(c.classification, p.classification, 'Unknown') AS classification,
            COALESCE(c.count_now, 0) - COALESCE(p.count_prev, 0) AS delta
        FROM current_window c
        FULL OUTER JOIN previous_window p
          ON c.source_domain = p.source_domain
         AND COALESCE(c.classification, 'Unknown') = COALESCE(p.classification, 'Unknown')
        ORDER BY ABS(COALESCE(c.count_now, 0) - COALESCE(p.count_prev, 0)) DESC
        LIMIT 6
    """)

    try:
        activity_rows = (await db.execute(activity_sql)).mappings().all()
    except Exception:
        activity_rows = []
    try:
        mover_rows = (await db.execute(movers_sql)).mappings().all()
    except Exception:
        mover_rows = []

    activity_by_domain: dict[str, list[dict[str, Any]]] = {domain.value: [] for domain in SourceDomain}
    for row in activity_rows:
        activity_by_domain[row["source_domain"]].append({
            "ts": _iso_or_none(row["bucket"]),
            "count": int(row["asset_count"] or 0),
        })
    pivots["activity"]["activity"] = [
        {"domain": domain, "buckets": buckets}
        for domain, buckets in activity_by_domain.items()
    ]
    pivots["activity"]["top_movers"] = [{
        "label": row["classification"] or "Unknown",
        "domain": row["source_domain"],
        "delta": int(row["delta"] or 0),
        "reason": "15-minute distinct-track delta",
    } for row in mover_rows]
    return pivots


@router.get("/core", summary="Primary landing overview payload")
async def get_overview_core(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    global _overview_cache, _overview_cache_expires_at
    now = datetime.now(timezone.utc)
    if _overview_cache is not None and _overview_cache_expires_at is not None and now < _overview_cache_expires_at:
        return _overview_cache["core"]
    core = await _load_core(db, now)
    pivots = await _load_pivots(db, now)
    _overview_cache = {
        "core": core,
        "pivots": pivots,
        "dashboard": {**core, **pivots},
    }
    _overview_cache_expires_at = now + OVERVIEW_CACHE_TTL
    return core


@router.get("/pivots", summary="Secondary overview pivot payload")
async def get_overview_pivots(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    global _overview_cache, _overview_cache_expires_at
    now = datetime.now(timezone.utc)
    if _overview_cache is not None and _overview_cache_expires_at is not None and now < _overview_cache_expires_at:
        return _overview_cache["pivots"]
    core = await _load_core(db, now)
    pivots = await _load_pivots(db, now)
    _overview_cache = {
        "core": core,
        "pivots": pivots,
        "dashboard": {**core, **pivots},
    }
    _overview_cache_expires_at = now + OVERVIEW_CACHE_TTL
    return pivots


@router.get("/dashboard", summary="Bundled overview payload for compatibility")
async def get_overview_dashboard(db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    global _overview_cache, _overview_cache_expires_at
    now = datetime.now(timezone.utc)
    if _overview_cache is not None and _overview_cache_expires_at is not None and now < _overview_cache_expires_at:
        return _overview_cache["dashboard"]
    core = await _load_core(db, now)
    pivots = await _load_pivots(db, now)
    dashboard = {**core, **pivots}
    _overview_cache = {
        "core": core,
        "pivots": pivots,
        "dashboard": dashboard,
    }
    _overview_cache_expires_at = now + OVERVIEW_CACHE_TTL
    return dashboard

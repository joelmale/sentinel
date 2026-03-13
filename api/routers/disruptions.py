"""Normalized disruption events and source status API."""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db
from models.track_event import SourceDomain

router = APIRouter(prefix="/disruptions", tags=["Disruptions"])


@router.get("/events", summary="Query normalized disruption events")
async def list_disruption_events(
    t_start: datetime | None = Query(None, description="Start time (ISO8601 UTC)"),
    t_end: datetime | None = Query(None, description="End time (ISO8601 UTC)"),
    domain: SourceDomain | None = Query(None),
    event_type: str | None = Query(None),
    category: str | None = Query(None),
    status: str | None = Query(None),
    bbox: str | None = Query(None, description="min_lon,min_lat,max_lon,max_lat"),
    limit: int = Query(500, le=5000),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    end = t_end or datetime.now(timezone.utc)
    start = t_start or (end - timedelta(days=7))

    conditions = [
        "last_seen >= :t_start",
        "first_seen <= :t_end",
    ]
    params: dict[str, Any] = {"t_start": start, "t_end": end, "limit": limit}

    if domain:
        conditions.append("source_domain = :domain")
        params["domain"] = domain.value
    if event_type:
        conditions.append("event_type = :event_type")
        params["event_type"] = event_type
    if category:
        conditions.append("category = :category")
        params["category"] = category
    if status:
        conditions.append("status = :status")
        params["status"] = status
    if bbox:
        min_lon, min_lat, max_lon, max_lat = [float(part) for part in bbox.split(",")]
        conditions.append("""
            (
                geometry IS NOT NULL
                AND ST_Intersects(geometry, ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326))
            ) OR (
                geometry IS NULL
                AND centroid IS NOT NULL
                AND ST_Within(centroid, ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326))
            )
        """)
        params.update(min_lon=min_lon, min_lat=min_lat, max_lon=max_lon, max_lat=max_lat)

    sql = text(f"""
        SELECT
            id::text,
            entity_id::text,
            source_domain,
            source_feed,
            external_event_id,
            track_id,
            callsign,
            event_type,
            category,
            title,
            status,
            severity,
            confidence,
            source_trust_score,
            first_seen,
            last_seen,
            start_time,
            end_time,
            h3_cell,
            measurement_value,
            measurement_unit,
            affected_assets_count,
            correlation_id::text,
            classification,
            metadata,
            ST_AsGeoJSON(geometry)::jsonb AS geometry,
            ST_AsGeoJSON(centroid)::jsonb AS centroid
        FROM disruption_events
        WHERE {" AND ".join(conditions)}
        ORDER BY last_seen DESC
        LIMIT :limit
    """)
    result = await db.execute(sql, params)
    rows = [dict(row) for row in result.mappings().all()]
    return {
        "count": len(rows),
        "items": rows,
        "window": {"t_start": start.isoformat(), "t_end": end.isoformat()},
    }


@router.get("/sources/status", summary="Summarize disruption source freshness and posture")
async def get_disruption_source_status(
    hours: int = Query(24, ge=1, le=168),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    sql = text("""
        SELECT
            source_feed,
            source_domain,
            COUNT(*) AS event_count,
            COUNT(*) FILTER (WHERE status = 'active') AS active_count,
            MAX(last_seen) AS latest_seen,
            AVG(source_trust_score) AS avg_trust,
            AVG(severity) AS avg_severity
        FROM disruption_events
        WHERE last_seen >= :since
        GROUP BY source_feed, source_domain
        ORDER BY latest_seen DESC
    """)
    result = await db.execute(sql, {"since": since})
    rows = []
    for row in result.mappings().all():
        latest_seen = row["latest_seen"]
        age_minutes = None
        if latest_seen is not None:
            age_minutes = round((datetime.now(timezone.utc) - latest_seen).total_seconds() / 60.0, 1)
        rows.append({
            "source_feed": row["source_feed"],
            "source_domain": row["source_domain"],
            "event_count": int(row["event_count"]),
            "active_count": int(row["active_count"]),
            "latest_seen": latest_seen.isoformat() if latest_seen else None,
            "age_minutes": age_minutes,
            "avg_trust": round(float(row["avg_trust"]), 3) if row["avg_trust"] is not None else None,
            "avg_severity": round(float(row["avg_severity"]), 2) if row["avg_severity"] is not None else None,
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "hours": hours,
        "sources": rows,
    }


@router.get("/dashboard", summary="Dashboard payload for disruption operations")
async def get_disruption_dashboard(
    domain: SourceDomain = Query(..., description="GPS or Infra"),
    hours: int = Query(72, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if domain.value not in {"GPS", "Infra"}:
        return {
            "domain": domain.value,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "summary": {},
            "sources": [],
            "recent_events": [],
            "categories": [],
        }

    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    summary_sql = text("""
        SELECT
            COUNT(*) AS total_events,
            COUNT(*) FILTER (WHERE status = 'active') AS active_events,
            COUNT(*) FILTER (WHERE status = 'resolved') AS resolved_events,
            AVG(source_trust_score) AS avg_trust,
            AVG(confidence) AS avg_confidence,
            AVG(severity) AS avg_severity,
            MAX(last_seen) AS latest_seen,
            SUM(affected_assets_count) FILTER (WHERE status = 'active') AS impacted_assets
        FROM disruption_events
        WHERE source_domain = :domain
          AND last_seen >= :since
    """)
    source_sql = text("""
        SELECT
            source_feed,
            COUNT(*) AS total_events,
            COUNT(*) FILTER (WHERE status = 'active') AS active_events,
            AVG(source_trust_score) AS avg_trust,
            AVG(confidence) AS avg_confidence,
            AVG(severity) AS avg_severity,
            MAX(last_seen) AS latest_seen
        FROM disruption_events
        WHERE source_domain = :domain
          AND last_seen >= :since
        GROUP BY source_feed
        ORDER BY latest_seen DESC
    """)
    category_sql = text("""
        SELECT
            category,
            COUNT(*) AS count
        FROM disruption_events
        WHERE source_domain = :domain
          AND last_seen >= :since
        GROUP BY category
        ORDER BY count DESC
    """)
    recent_sql = text("""
        SELECT
            id::text,
            source_feed,
            external_event_id,
            track_id,
            title,
            event_type,
            category,
            status,
            severity,
            confidence,
            source_trust_score,
            affected_assets_count,
            first_seen,
            last_seen,
            metadata
        FROM disruption_events
        WHERE source_domain = :domain
          AND last_seen >= :since
        ORDER BY last_seen DESC
        LIMIT 18
    """)

    # Run all four queries concurrently.  Each is wrapped individually so a
    # single failing query degrades gracefully rather than aborting the whole
    # dashboard response.  The gather collects results in order; exceptions are
    # captured as sentinel values and treated as empty result sets below.
    results = await asyncio.gather(
        db.execute(summary_sql, {"domain": domain.value, "since": since}),
        db.execute(source_sql, {"domain": domain.value, "since": since}),
        db.execute(category_sql, {"domain": domain.value, "since": since}),
        db.execute(recent_sql, {"domain": domain.value, "since": since}),
        return_exceptions=True,
    )

    import logging as _log
    _logger = _log.getLogger(__name__)

    def _safe_mappings(result: Any, label: str) -> list:
        if isinstance(result, BaseException):
            _logger.warning("[disruption-dashboard] %s query failed: %s", label, result)
            return []
        try:
            return result.mappings().all()
        except Exception as exc:
            _logger.warning("[disruption-dashboard] %s result processing failed: %s", label, exc)
            return []

    summary_rows   = _safe_mappings(results[0], "summary")
    source_rows    = _safe_mappings(results[1], "sources")
    category_rows  = _safe_mappings(results[2], "categories")
    recent_rows    = _safe_mappings(results[3], "recent_events")

    summary_row = summary_rows[0] if summary_rows else None

    now = datetime.now(timezone.utc)
    sources = []
    for row in source_rows:
        latest_seen = row["latest_seen"]
        # Guard against timezone-naive datetimes from some DB driver configs
        if latest_seen is not None and latest_seen.tzinfo is None:
            latest_seen = latest_seen.replace(tzinfo=timezone.utc)
        age_minutes = round((now - latest_seen).total_seconds() / 60.0, 1) if latest_seen else None
        sources.append({
            "source_feed": row["source_feed"],
            "total_events": int(row["total_events"] or 0),
            "active_events": int(row["active_events"] or 0),
            "avg_trust": round(float(row["avg_trust"]), 3) if row["avg_trust"] is not None else None,
            "avg_confidence": round(float(row["avg_confidence"]), 3) if row["avg_confidence"] is not None else None,
            "avg_severity": round(float(row["avg_severity"]), 2) if row["avg_severity"] is not None else None,
            "latest_seen": latest_seen.isoformat() if latest_seen else None,
            "age_minutes": age_minutes,
        })

    def _ts(dt: Any) -> str | None:
        if dt is None:
            return None
        if hasattr(dt, "tzinfo") and dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()

    return {
        "domain": domain.value,
        "generated_at": now.isoformat(),
        "hours": hours,
        "summary": {
            "total_events": int(summary_row["total_events"] or 0) if summary_row else 0,
            "active_events": int(summary_row["active_events"] or 0) if summary_row else 0,
            "resolved_events": int(summary_row["resolved_events"] or 0) if summary_row else 0,
            "avg_trust": round(float(summary_row["avg_trust"]), 3) if summary_row and summary_row["avg_trust"] is not None else None,
            "avg_confidence": round(float(summary_row["avg_confidence"]), 3) if summary_row and summary_row["avg_confidence"] is not None else None,
            "avg_severity": round(float(summary_row["avg_severity"]), 2) if summary_row and summary_row["avg_severity"] is not None else None,
            "latest_seen": _ts(summary_row["latest_seen"]) if summary_row else None,
            "impacted_assets": int(summary_row["impacted_assets"] or 0) if summary_row else 0,
        },
        "sources": sources,
        "categories": [
            {"label": row["category"], "count": int(row["count"])}
            for row in category_rows
        ],
        "recent_events": [dict(row) for row in recent_rows],
    }

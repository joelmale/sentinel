"""Anomaly events REST API."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db

router = APIRouter(prefix="/anomalies", tags=["anomalies"])


@router.get("/events")
async def list_anomaly_events(
    status: str = Query("open"),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
):
    sql = text(
        """
        SELECT
            id::text,
            detector_key,
            dedupe_key,
            source_domain::text AS source_domain,
            title,
            severity,
            confidence,
            status,
            track_id,
            entity_id::text,
            occurred_at,
            first_seen,
            last_seen,
            resolved_at,
            bbox,
            metrics,
            evidence,
            metadata
        FROM anomaly_events
        WHERE (:status = 'all' OR status = :status)
        ORDER BY last_seen DESC
        LIMIT :limit
        """
    )
    result = await db.execute(sql, {"status": status, "limit": limit})
    return [dict(row) for row in result.mappings().all()]

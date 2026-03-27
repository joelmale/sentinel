"""Incident cases REST API."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db

router = APIRouter(prefix="/incidents", tags=["incidents"])


@router.get("")
async def list_incidents(
    status: str = Query("open"),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
):
    sql = text(
        """
        SELECT
            ic.id::text,
            ic.case_key,
            ic.title,
            ic.summary,
            ic.severity,
            ic.confidence,
            ic.status,
            ic.started_at,
            ic.last_seen,
            ic.resolved_at,
            ic.domains,
            ic.bbox,
            ic.evidence,
            COALESCE(
                json_agg(
                    json_build_object(
                        'member_type', icm.member_type,
                        'member_id', icm.member_id
                    )
                ) FILTER (WHERE icm.member_id IS NOT NULL),
                '[]'::json
            ) AS members
        FROM incident_cases ic
        LEFT JOIN incident_case_members icm ON icm.case_id = ic.id
        WHERE (:status = 'all' OR ic.status = :status)
        GROUP BY ic.id
        ORDER BY ic.last_seen DESC
        LIMIT :limit
        """
    )
    result = await db.execute(sql, {"status": status, "limit": limit})
    return [dict(row) for row in result.mappings().all()]

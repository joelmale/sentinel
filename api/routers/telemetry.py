"""Unified telemetry dashboard API for operational source panels."""

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db
from models.track_event import SourceDomain
from routers.disruptions import get_disruption_dashboard
from routers.tracks import get_domain_status

router = APIRouter(prefix="/telemetry", tags=["Telemetry"])


@router.get("/dashboard", summary="Unified telemetry dashboard payload")
async def get_telemetry_dashboard(
    domain: SourceDomain = Query(..., description="Air | Maritime | GPS | Infra"),
    hours: int = Query(72, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if domain.value in {"Air", "Maritime"}:
        return await get_domain_status(domain=domain, db=db)
    if domain.value in {"GPS", "Infra"}:
        return await get_disruption_dashboard(domain=domain, hours=hours, db=db)

    return {
        "domain": domain.value,
        "generated_at": None,
        "summary": {},
        "sources": [],
        "recent_events": [],
        "categories": [],
    }

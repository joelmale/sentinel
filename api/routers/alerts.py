"""Alert rules and alert events REST API."""
import json

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db

router = APIRouter(prefix="/alerts", tags=["alerts"])


class AlertRuleCreate(BaseModel):
    name: str
    domain: str
    conditions: dict  # {"bbox": [min_lon, min_lat, max_lon, max_lat], "classification": "Military"}
    notification_channels: list[str] = ["websocket"]


@router.get("/rules")
async def list_rules(db: AsyncSession = Depends(get_db)):
    """List all alert rules."""
    sql = text(
        "SELECT id, name, domain, conditions, enabled, created_at FROM alert_rules ORDER BY created_at DESC"
    )
    result = await db.execute(sql)
    rows = result.mappings().all()
    return [dict(r) for r in rows]


@router.post("/rules")
async def create_rule(body: AlertRuleCreate, db: AsyncSession = Depends(get_db)):
    """Create a new alert rule."""
    sql = text(
        """INSERT INTO alert_rules (name, domain, conditions, notification_channels, enabled)
           VALUES (:name, :domain, :conditions, :channels, true) RETURNING id, name, domain, enabled"""
    )
    result = await db.execute(
        sql,
        {
            "name": body.name,
            "domain": body.domain,
            "conditions": json.dumps(body.conditions),
            "channels": json.dumps(body.notification_channels),
        },
    )
    await db.commit()
    row = result.mappings().first()
    return dict(row) if row else None


@router.delete("/rules/{rule_id}")
async def delete_rule(rule_id: str, db: AsyncSession = Depends(get_db)):
    """Delete an alert rule."""
    sql = text("DELETE FROM alert_rules WHERE id = :rule_id")
    await db.execute(sql, {"rule_id": rule_id})
    await db.commit()
    return {"deleted": rule_id}


@router.get("/events")
async def list_alert_events(
    limit: int = Query(50, le=200), db: AsyncSession = Depends(get_db)
):
    """List recent alert events."""
    sql = text(
        """SELECT ae.id, ae.rule_id, ae.track_id, ae.domain, ae.status, ae.triggered_at,
                  ar.name as rule_name
           FROM alert_events ae
           JOIN alert_rules ar ON ar.id = ae.rule_id
           ORDER BY ae.triggered_at DESC
           LIMIT :limit"""
    )
    result = await db.execute(sql, {"limit": limit})
    rows = result.mappings().all()
    return [dict(r) for r in rows]


@router.patch("/events/{event_id}/acknowledge")
async def acknowledge_event(event_id: str, db: AsyncSession = Depends(get_db)):
    """Mark an alert event as acknowledged."""
    sql = text("UPDATE alert_events SET status = 'acknowledged' WHERE id = :event_id")
    await db.execute(sql, {"event_id": event_id})
    await db.commit()
    return {"acknowledged": event_id}

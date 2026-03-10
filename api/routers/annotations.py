from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db

router = APIRouter(tags=["Annotations"])


class AnnotationCreate(BaseModel):
    lon: float = Field(..., ge=-180, le=180)
    lat: float = Field(..., ge=-90, le=90)
    label: str = Field(..., max_length=200)
    body: str | None = None
    linked_track_id: str | None = None
    linked_domain: str | None = None
    linked_at: datetime | None = None
    tags: list[str] = Field(default_factory=list)
    color: str = "#FF6B35"
    created_by: str = "analyst"  # TODO: replace with JWT subject


@router.get("/annotations", summary="List all annotations")
async def list_annotations(
    bbox: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    conditions = ["TRUE"]
    params: dict[str, Any] = {}

    if bbox:
        try:
            min_lon, min_lat, max_lon, max_lat = [float(x) for x in bbox.split(",")]
            conditions.append(
                "ST_Within(position, ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326))"
            )
            params.update(min_lon=min_lon, min_lat=min_lat, max_lon=max_lon, max_lat=max_lat)
        except ValueError:
            pass

    sql = text(f"""
        SELECT id::text, created_by, created_at, ST_X(position) AS lon,
               ST_Y(position) AS lat, label, body, linked_track_id,
               linked_domain, linked_at, tags, color
        FROM annotations WHERE {" AND ".join(conditions)}
        ORDER BY created_at DESC
    """)
    result = await db.execute(sql, params)
    rows = result.mappings().all()

    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
            "properties": {k: v for k, v in r.items() if k not in ("lon", "lat")},
        }
        for r in rows
    ]
    return {"type": "FeatureCollection", "features": features}


@router.post("/annotations", summary="Create annotation", status_code=201)
async def create_annotation(
    body: AnnotationCreate,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    sql = text("""
        INSERT INTO annotations
            (position, label, body, linked_track_id, linked_domain,
             linked_at, tags, color, created_by)
        VALUES
            (ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), :label, :body,
             :linked_track_id, :linked_domain, :linked_at, :tags, :color, :created_by)
        RETURNING id::text, created_at
    """)
    result = await db.execute(sql, {
        "lon": body.lon, "lat": body.lat,
        "label": body.label, "body": body.body,
        "linked_track_id": body.linked_track_id,
        "linked_domain": body.linked_domain,
        "linked_at": body.linked_at,
        "tags": body.tags,
        "color": body.color,
        "created_by": body.created_by,
    })
    await db.commit()
    row = result.mappings().one()
    return {"id": row["id"], "created_at": row["created_at"].isoformat()}


@router.delete("/annotations/{annotation_id}", summary="Delete annotation")
async def delete_annotation(
    annotation_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    result = await db.execute(
        text("DELETE FROM annotations WHERE id = :id RETURNING id"),
        {"id": str(annotation_id)},
    )
    await db.commit()
    if not result.rowcount:
        raise HTTPException(status_code=404, detail="Annotation not found")
    return {"status": "deleted"}

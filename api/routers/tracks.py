"""
Tracks router — historical query endpoint.

The key query pattern is:
  "Give me all events in domain D, inside bounding box B,
   between time T1 and T2, paginated."

TimescaleDB's hypertable partitioning means this query skips
all chunks outside [T1, T2] entirely, making it O(time_range)
rather than O(total_data).
"""

from datetime import datetime
from typing import Any

import orjson
from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db
from models.track_event import SourceDomain

router = APIRouter(tags=["Tracks"])


@router.get("/tracks/history", summary="Query historical track events")
async def get_track_history(
    t_start: datetime = Query(..., description="Start time (ISO8601 UTC)"),
    t_end: datetime = Query(..., description="End time (ISO8601 UTC)"),
    domain: SourceDomain | None = Query(None),
    track_id: str | None = Query(None, max_length=64),
    # bbox as comma-separated: min_lon,min_lat,max_lon,max_lat
    bbox: str | None = Query(None, description="min_lon,min_lat,max_lon,max_lat"),
    limit: int = Query(default=10_000, le=100_000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:

    # Build query dynamically — avoid N+1 by using raw SQL for PostGIS functions
    conditions = [
        "timestamp >= :t_start",
        "timestamp <= :t_end",
    ]
    params: dict[str, Any] = {"t_start": t_start, "t_end": t_end}

    if domain:
        conditions.append("source_domain = :domain")
        params["domain"] = domain.value

    if track_id:
        conditions.append("track_id = :track_id")
        params["track_id"] = track_id

    if bbox:
        try:
            min_lon, min_lat, max_lon, max_lat = [float(x) for x in bbox.split(",")]
            conditions.append(
                "ST_Within(position, ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326))"
            )
            params.update(min_lon=min_lon, min_lat=min_lat, max_lon=max_lon, max_lat=max_lat)
        except ValueError:
            pass  # ignore malformed bbox

    where_clause = " AND ".join(conditions)
    sql = text(f"""
        SELECT
            event_id::text,
            source_domain,
            source_feed,
            track_id,
            callsign,
            ST_X(position) AS lon,
            ST_Y(position) AS lat,
            altitude_m,
            heading_deg,
            speed_mps,
            timestamp,
            metadata,
            classification
        FROM track_events
        WHERE {where_clause}
        ORDER BY timestamp ASC
        LIMIT :limit OFFSET :offset
    """)
    params["limit"] = limit
    params["offset"] = offset

    result = await db.execute(sql, params)
    rows = result.mappings().all()

    features = []
    for row in rows:
        geometry = None
        if row["lon"] is not None and row["lat"] is not None:
            geometry = {"type": "Point", "coordinates": [row["lon"], row["lat"]]}

        features.append({
            "type": "Feature",
            "geometry": geometry,
            "properties": {
                "event_id": row["event_id"],
                "source_domain": row["source_domain"],
                "source_feed": row["source_feed"],
                "track_id": row["track_id"],
                "callsign": row["callsign"],
                "altitude_m": row["altitude_m"],
                "heading_deg": row["heading_deg"],
                "speed_mps": row["speed_mps"],
                "timestamp": row["timestamp"].isoformat(),
                "classification": row["classification"],
                **(row["metadata"] or {}),
            },
        })

    return {
        "type": "FeatureCollection",
        "features": features,
        "meta": {
            "count": len(features),
            "limit": limit,
            "offset": offset,
            "t_start": t_start.isoformat(),
            "t_end": t_end.isoformat(),
        },
    }


@router.get("/tracks/live", summary="Current state of all tracked assets")
async def get_live_assets(
    domain: SourceDomain | None = Query(None),
    bbox: str | None = Query(None, description="min_lon,min_lat,max_lon,max_lat"),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """
    Returns the latest known state of all assets from asset_states table.
    Much faster than querying track_events for live view — one row per asset.
    """
    conditions = ["TRUE"]
    params: dict[str, Any] = {}

    if domain:
        conditions.append("source_domain = :domain")
        params["domain"] = domain.value

    if bbox:
        try:
            min_lon, min_lat, max_lon, max_lat = [float(x) for x in bbox.split(",")]
            conditions.append(
                "ST_Within(position, ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326))"
            )
            params.update(min_lon=min_lon, min_lat=min_lat, max_lon=max_lon, max_lat=max_lat)
        except ValueError:
            pass

    where_clause = " AND ".join(conditions)
    sql = text(f"""
        SELECT
            source_domain, source_feed, track_id, callsign,
            ST_X(position) AS lon, ST_Y(position) AS lat,
            altitude_m, heading_deg, speed_mps, last_seen,
            metadata, classification
        FROM asset_states
        WHERE {where_clause}
        ORDER BY last_seen DESC
    """)

    result = await db.execute(sql, params)
    rows = result.mappings().all()

    features = []
    for row in rows:
        geometry = None
        if row["lon"] is not None and row["lat"] is not None:
            geometry = {"type": "Point", "coordinates": [row["lon"], row["lat"]]}
        features.append({
            "type": "Feature",
            "geometry": geometry,
            "properties": {
                "source_domain": row["source_domain"],
                "track_id": row["track_id"],
                "callsign": row["callsign"],
                "altitude_m": row["altitude_m"],
                "heading_deg": row["heading_deg"],
                "speed_mps": row["speed_mps"],
                "last_seen": row["last_seen"].isoformat(),
                "classification": row["classification"],
                **(row["metadata"] or {}),
            },
        })

    return {"type": "FeatureCollection", "features": features}

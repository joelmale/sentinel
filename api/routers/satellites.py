"""
Satellites router — satellite catalog enrichment data.

Serves metadata from the satellite_catalog table, which is populated by
the Space collector during each TLE refresh from Space-Track SATCAT.

This data powers the "baseball card" detail panel for Space domain assets:
  - Country of origin, launch date, international designator
  - Orbit class (LEO/MEO/GEO/HEO/SSO), apogee/perigee
  - RCS size (radar cross section: SMALL / MEDIUM / LARGE)
  - Operator, purpose, contractor (when available from enrichment)

Architecture analogy: if asset_states is the live "scoreboard" and
track_events is the play-by-play history, satellite_catalog is the
player roster / stats card — biographic data that rarely changes.
"""

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db

router = APIRouter(tags=["Satellites"])


def _iso_or_none(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value)


def _satellite_enrichment_status(row: dict[str, Any]) -> dict[str, Any]:
    sources = list(row["sources"] or [])
    source_set = set(sources)

    field_status = {
        "identity": "authoritative" if row["intl_designator"] or row["country_code"] or row["launch_date"] else "missing",
        "orbit": "derived" if row["orbit_class"] or row["period_min"] or row["inclination_deg"] else "missing",
        "operator": "inferred" if row["operator"] and "satnogs" in source_set else "curated" if row["operator"] else "missing",
        "purpose": "curated" if row["purpose"] else "missing",
        "contractor": "curated" if row["contractor"] else "missing",
        "launch": "authoritative" if row["launch_site"] and "spacetrack" in source_set else "inferred" if row["launch_site"] else "missing",
    }

    total_fields = len(field_status)
    populated_fields = sum(1 for value in field_status.values() if value != "missing")
    completeness_pct = round((populated_fields / total_fields) * 100) if total_fields else 0

    if "spacetrack" in source_set and completeness_pct >= 65:
        confidence = "high"
    elif "spacetrack" in source_set or completeness_pct >= 35:
        confidence = "medium"
    else:
        confidence = "low"

    tle_epoch = row["tle_epoch"]
    if tle_epoch and isinstance(tle_epoch, datetime) and tle_epoch.tzinfo is None:
        tle_epoch = tle_epoch.replace(tzinfo=timezone.utc)
    tle_age_minutes = None
    if isinstance(tle_epoch, datetime):
        tle_age_minutes = max(0, int((datetime.now(timezone.utc) - tle_epoch).total_seconds() // 60))

    return {
        "sources": sources,
        "last_updated": _iso_or_none(row["last_updated"]),
        "tle_epoch": _iso_or_none(tle_epoch),
        "tle_source": row["tle_source"],
        "tle_age_minutes": tle_age_minutes,
        "completeness_pct": completeness_pct,
        "confidence": confidence,
        "field_status": field_status,
    }


@router.get("/satellites/watchlist/status", summary="Get curated space watchlist dashboard status")
async def get_space_watchlist_status(
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    sql = text("""
        SELECT
            watch_id,
            label,
            priority,
            enabled,
            norad_id,
            satnogs_sat_id,
            desired_sources,
            notes,
            current_name,
            in_catalog,
            active_track,
            current_tle_source,
            tle_epoch,
            tle_age_minutes,
            last_track_seen,
            health_status,
            source_status,
            metadata,
            updated_at
        FROM space_watchlist_status
        ORDER BY
            CASE priority
                WHEN 'critical' THEN 0
                WHEN 'high' THEN 1
                WHEN 'medium' THEN 2
                WHEN 'low' THEN 3
                ELSE 4
            END,
            label ASC
    """)
    result = await db.execute(sql)
    rows = result.mappings().all()

    items = []
    health_counts = {"healthy": 0, "tracking": 0, "degraded": 0, "stale": 0, "missing": 0, "idle": 0}
    due_sources = 0

    for row in rows:
        health = row["health_status"] or "idle"
        health_counts[health] = health_counts.get(health, 0) + 1
        source_status = row["source_status"] or {}
        due_sources += sum(1 for source in source_status.values() if source.get("due"))
        items.append({
            "watch_id": row["watch_id"],
            "label": row["label"],
            "priority": row["priority"],
            "enabled": row["enabled"],
            "norad_id": row["norad_id"],
            "satnogs_sat_id": row["satnogs_sat_id"],
            "desired_sources": list(row["desired_sources"] or []),
            "notes": row["notes"],
            "current_name": row["current_name"],
            "in_catalog": row["in_catalog"],
            "active_track": row["active_track"],
            "current_tle_source": row["current_tle_source"],
            "tle_epoch": row["tle_epoch"].isoformat() if row["tle_epoch"] else None,
            "tle_age_minutes": row["tle_age_minutes"],
            "last_track_seen": row["last_track_seen"].isoformat() if row["last_track_seen"] else None,
            "health_status": health,
            "source_status": source_status,
            "metadata": row["metadata"] or {},
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        })

    return {
        "summary": {
            "count": len(items),
            "healthy": health_counts["healthy"],
            "tracking": health_counts["tracking"],
            "degraded": health_counts["degraded"],
            "stale": health_counts["stale"],
            "missing": health_counts["missing"],
            "idle": health_counts["idle"],
            "due_sources": due_sources,
        },
        "items": items,
    }


@router.get("/satellites/{norad_id}", summary="Get satellite catalog entry by NORAD ID")
async def get_satellite(
    norad_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """
    Return the satellite_catalog row for a given NORAD catalog number.

    The NORAD ID is the canonical identifier used across all space
    tracking systems — the equivalent of a ship's MMSI or aircraft's
    ICAO hex code.

    Returns 404 if the satellite has not yet been catalogued (e.g. the
    Space collector hasn't run a TLE refresh cycle since startup).
    """
    sql = text("""
        SELECT
            norad_id,
            object_name,
            intl_designator,
            object_type,
            country_code,
            launch_date,
            decay_date,
            period_min,
            inclination_deg,
            apogee_km,
            perigee_km,
            rcs_size,
            orbit_class,
            operator,
            purpose,
            contractor,
            launch_site,
            sources,
            last_updated,
            metadata,
            latest_tle.epoch AS tle_epoch,
            latest_tle.source AS tle_source
        FROM satellite_catalog
        LEFT JOIN LATERAL (
            SELECT epoch, source
            FROM satellite_tles
            WHERE satellite_tles.norad_id = satellite_catalog.norad_id
            ORDER BY epoch DESC
            LIMIT 1
        ) AS latest_tle ON TRUE
        WHERE satellite_catalog.norad_id = :norad_id
    """)
    result = await db.execute(sql, {"norad_id": norad_id})
    row = result.mappings().first()

    if not row:
        raise HTTPException(
            status_code=404,
            detail=f"No catalog entry found for NORAD ID {norad_id}. "
                   "The Space collector may not have completed a TLE refresh yet.",
        )

    # Build response — convert date objects to ISO strings for JSON serialisation
    return {
        "norad_id":        row["norad_id"],
        "object_name":     row["object_name"],
        "intl_designator": row["intl_designator"],
        "object_type":     row["object_type"],
        "country_code":    row["country_code"],
        "launch_date":     row["launch_date"].isoformat() if row["launch_date"] else None,
        "decay_date":      row["decay_date"].isoformat() if row["decay_date"] else None,
        "period_min":      row["period_min"],
        "inclination_deg": row["inclination_deg"],
        "apogee_km":       row["apogee_km"],
        "perigee_km":      row["perigee_km"],
        "rcs_size":        row["rcs_size"],
        "orbit_class":     row["orbit_class"],
        "operator":        row["operator"],
        "purpose":         row["purpose"],
        "contractor":      row["contractor"],
        "launch_site":     row["launch_site"],
        "sources":         list(row["sources"] or []),
        "last_updated":    row["last_updated"].isoformat() if row["last_updated"] else None,
        "metadata":        row["metadata"] or {},
        "enrichment_status": _satellite_enrichment_status(row),
    }


@router.get("/satellites", summary="Search satellite catalog")
async def search_satellites(
    country_code: str | None = Query(None, description="Filter by country code (e.g. US, PRC)"),
    orbit_class: str | None = Query(None, description="Filter by orbit class: LEO | MEO | GEO | HEO | SSO"),
    object_type: str | None = Query(None, description="Filter by object type: PAYLOAD | ROCKET BODY | DEBRIS"),
    q: str | None = Query(None, description="Name search (partial match)", max_length=64),
    limit: int = Query(default=100, le=1000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """
    Search / list the satellite catalog with optional filters.

    Useful for building dropdown selectors, country-based filtering,
    and orbital regime analysis views.
    """
    conditions = ["TRUE"]
    params: dict[str, Any] = {}

    if country_code:
        conditions.append("country_code = :country_code")
        params["country_code"] = country_code.upper()

    if orbit_class:
        conditions.append("orbit_class = :orbit_class")
        params["orbit_class"] = orbit_class.upper()

    if object_type:
        conditions.append("object_type ILIKE :object_type")
        params["object_type"] = object_type

    if q:
        conditions.append("object_name ILIKE :q")
        params["q"] = f"%{q}%"

    where = " AND ".join(conditions)
    sql = text(f"""
        SELECT
            norad_id, object_name, intl_designator, object_type,
            country_code, launch_date, orbit_class,
            apogee_km, perigee_km, inclination_deg,
            rcs_size, operator, purpose, sources
        FROM satellite_catalog
        WHERE {where}
        ORDER BY norad_id ASC
        LIMIT :limit OFFSET :offset
    """)
    params["limit"] = limit
    params["offset"] = offset

    result = await db.execute(sql, params)
    rows = result.mappings().all()

    return {
        "satellites": [
            {
                "norad_id":        r["norad_id"],
                "object_name":     r["object_name"],
                "intl_designator": r["intl_designator"],
                "object_type":     r["object_type"],
                "country_code":    r["country_code"],
                "launch_date":     r["launch_date"].isoformat() if r["launch_date"] else None,
                "orbit_class":     r["orbit_class"],
                "apogee_km":       r["apogee_km"],
                "perigee_km":      r["perigee_km"],
                "inclination_deg": r["inclination_deg"],
                "rcs_size":        r["rcs_size"],
                "operator":        r["operator"],
                "purpose":         r["purpose"],
                "sources":         list(r["sources"] or []),
            }
            for r in rows
        ],
        "meta": {
            "count":  len(rows),
            "limit":  limit,
            "offset": offset,
        },
    }


@router.get(
    "/satellites/{norad_id}/tles",
    summary="Get historical TLE snapshots for a satellite",
)
async def get_satellite_tles(
    norad_id: int,
    limit: int = Query(default=30, le=500, description="Number of most-recent TLE epochs to return"),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """
    Return historical TLE snapshots for a satellite, ordered most-recent first.

    These snapshots are written every TLE_REFRESH_INTERVAL_SEC (default 2 hrs)
    and enable retroactive orbital projection: to reconstruct where a satellite
    WAS at historical time T, pick the snapshot whose epoch is closest to T,
    then propagate forward or backward using SGP4.

    Think of each TLE as a keyframe in an animation — SGP4 interpolates
    between keyframes at any arbitrary time.
    """
    sql = text("""
        SELECT norad_id, epoch, tle_line1, tle_line2, source, ingested_at
        FROM satellite_tles
        WHERE norad_id = :norad_id
        ORDER BY epoch DESC
        LIMIT :limit
    """)
    result = await db.execute(sql, {"norad_id": norad_id, "limit": limit})
    rows = result.mappings().all()

    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No TLE history found for NORAD ID {norad_id}.",
        )

    return {
        "norad_id": norad_id,
        "count": len(rows),
        "tles": [
            {
                "epoch":      r["epoch"].isoformat(),
                "tle_line1":  r["tle_line1"],
                "tle_line2":  r["tle_line2"],
                "source":     r["source"],
                "ingested_at": r["ingested_at"].isoformat() if r["ingested_at"] else None,
            }
            for r in rows
        ],
    }

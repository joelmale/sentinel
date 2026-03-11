"""
Tracks router — historical query endpoint.

The key query pattern is:
  "Give me all events in domain D, inside bounding box B,
   between time T1 and T2, paginated."

TimescaleDB's hypertable partitioning means this query skips
all chunks outside [T1, T2] entirely, making it O(time_range)
rather than O(total_data).
"""

import asyncio
import csv
import io
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import orjson
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db
from models.track_event import SourceDomain

router = APIRouter(tags=["Tracks"])
logger = logging.getLogger(__name__)


@router.get("/tracks/domain-status", summary="Operational status summary for a domain")
async def get_domain_status(
    domain: SourceDomain = Query(..., description="Domain to summarize"),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if domain.value not in {"Air", "Maritime"}:
        raise HTTPException(status_code=400, detail="Domain status currently supports Air and Maritime only.")

    now = datetime.now(timezone.utc)
    stale_cutoff = now - timedelta(minutes=15)
    active_cutoff = now - timedelta(hours=1)
    day_cutoff = now - timedelta(hours=24)

    asset_sql = text("""
        SELECT
            source_feed,
            track_id,
            callsign,
            altitude_m,
            speed_mps,
            last_seen,
            classification
        FROM asset_states
        WHERE source_domain = :domain
        ORDER BY last_seen DESC
    """)
    event_sql = text("""
        SELECT
            source_feed,
            COUNT(*) FILTER (WHERE timestamp >= :active_cutoff) AS events_1h,
            COUNT(*) FILTER (WHERE timestamp >= :day_cutoff) AS events_24h,
            COUNT(DISTINCT track_id) FILTER (WHERE timestamp >= :active_cutoff) AS active_tracks_1h
        FROM track_events
        WHERE source_domain = :domain
          AND timestamp >= :day_cutoff
        GROUP BY source_feed
    """)

    assets: list[Any] = []
    feed_events: dict[str, Any] = {}

    try:
        asset_result = await db.execute(asset_sql, {"domain": domain.value})
        assets = asset_result.mappings().all()
    except Exception:
        logger.exception("[tracks.domain-status] asset_states query failed for %s", domain.value)

    try:
        event_result = await db.execute(
            event_sql,
            {"domain": domain.value, "active_cutoff": active_cutoff, "day_cutoff": day_cutoff},
        )
        feed_events = {row["source_feed"]: row for row in event_result.mappings().all()}
    except Exception:
        logger.exception("[tracks.domain-status] track_events query failed for %s", domain.value)

    classification_counts: dict[str, int] = {}
    feed_summary: dict[str, dict[str, Any]] = {}
    stale_assets = 0
    fresh_assets = 0
    speeds: list[float] = []
    altitudes: list[float] = []
    latest_seen: datetime | None = None

    for feed, event_row in feed_events.items():
        feed_summary.setdefault(feed, {
            "feed": feed,
            "asset_count": 0,
            "fresh_assets": 0,
            "stale_assets": 0,
            "latest_seen": None,
            "classifications": {},
            "events_1h": int(event_row["events_1h"] or 0),
            "events_24h": int(event_row["events_24h"] or 0),
            "active_tracks_1h": int(event_row["active_tracks_1h"] or 0),
        })

    for row in assets:
        classification = row["classification"] or "Unknown"
        classification_counts[classification] = classification_counts.get(classification, 0) + 1

        last_seen = row["last_seen"]
        if last_seen is None:
            continue
        latest_seen = last_seen if latest_seen is None or last_seen > latest_seen else latest_seen
        if last_seen >= stale_cutoff:
            fresh_assets += 1
        else:
            stale_assets += 1

        feed = row["source_feed"]
        summary = feed_summary.setdefault(feed, {
            "feed": feed,
            "asset_count": 0,
            "fresh_assets": 0,
            "stale_assets": 0,
            "latest_seen": None,
            "classifications": {},
            "events_1h": 0,
            "events_24h": 0,
            "active_tracks_1h": 0,
        })
        summary["asset_count"] += 1
        if last_seen >= stale_cutoff:
            summary["fresh_assets"] += 1
        else:
            summary["stale_assets"] += 1
        if summary["latest_seen"] is None or last_seen > summary["latest_seen"]:
            summary["latest_seen"] = last_seen
        summary["classifications"][classification] = summary["classifications"].get(classification, 0) + 1

        speed = row["speed_mps"]
        altitude = row["altitude_m"]
        if speed is not None:
            speeds.append(float(speed))
        if altitude is not None:
            altitudes.append(float(altitude))

    feeds = []
    due_feeds = 0
    for feed, summary in feed_summary.items():
        latest = summary["latest_seen"]
        age_minutes = ((now - latest).total_seconds() / 60) if latest else None
        health = "healthy"
        if latest is None:
            health = "missing"
        elif latest < stale_cutoff:
            health = "stale"
            due_feeds += 1
        feeds.append({
            "feed": feed,
            "asset_count": summary["asset_count"],
            "fresh_assets": summary["fresh_assets"],
            "stale_assets": summary["stale_assets"],
            "latest_seen": latest.isoformat() if latest else None,
            "age_minutes": age_minutes,
            "events_1h": int(summary["events_1h"]),
            "events_24h": int(summary["events_24h"]),
            "active_tracks_1h": int(summary["active_tracks_1h"]),
            "health": health,
            "classifications": summary["classifications"],
        })

    feeds.sort(key=lambda feed: (-feed["asset_count"], feed["feed"]))
    classifications = [
        {"label": label, "count": count}
        for label, count in sorted(classification_counts.items(), key=lambda item: (-item[1], item[0]))
    ]

    return {
        "domain": domain.value,
        "generated_at": now.isoformat(),
        "summary": {
            "tracked": len(assets),
            "fresh": fresh_assets,
            "stale": stale_assets,
            "feeds": len(feeds),
            "due_feeds": due_feeds,
            "latest_seen": latest_seen.isoformat() if latest_seen else None,
            "avg_speed_mps": round(sum(speeds) / len(speeds), 1) if speeds else None,
            "avg_altitude_m": round(sum(altitudes) / len(altitudes), 1) if altitudes else None,
            "events_1h": int(sum(feed["events_1h"] for feed in feeds)),
            "events_24h": int(sum(feed["events_24h"] for feed in feeds)),
        },
        "feeds": feeds,
        "classifications": classifications[:8],
    }


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


@router.get("/tracks/activity", summary="Bucketed track activity density by domain")
async def get_track_activity(
    t_start: datetime = Query(..., description="Start time (ISO8601 UTC)"),
    t_end: datetime = Query(..., description="End time (ISO8601 UTC)"),
    bucket_minutes: int = Query(default=5, ge=1, le=120, description="Bucket width in minutes"),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """
    Returns per-domain bucketed distinct track counts for a time window.
    Drives the timeline density strip — analysts see at a glance when each
    domain was busiest before scrubbing into the data.

    Think of it like a spectrogram: time on the X axis, domains on Y,
    brightness = how many distinct tracks were active in that bucket.
    """
    sql = text("""
        SELECT
            source_domain,
            time_bucket(make_interval(mins => :bucket_minutes), timestamp) AS bucket,
            COUNT(DISTINCT track_id) AS track_count
        FROM track_events
        WHERE timestamp >= :t_start
          AND timestamp <= :t_end
        GROUP BY source_domain, bucket
        ORDER BY source_domain, bucket ASC
    """)
    result = await db.execute(sql, {
        "t_start": t_start,
        "t_end": t_end,
        "bucket_minutes": bucket_minutes,
    })
    rows = result.mappings().all()

    by_domain: dict[str, list] = {}
    for row in rows:
        d = row["source_domain"]
        by_domain.setdefault(d, []).append({
            "bucket": row["bucket"].isoformat(),
            "count": int(row["track_count"]),
        })

    return {
        "t_start": t_start.isoformat(),
        "t_end": t_end.isoformat(),
        "bucket_minutes": bucket_minutes,
        "domains": by_domain,
    }


@router.get("/tracks/export", summary="Export track history as GeoJSON or CSV")
async def export_tracks(
    t_start: datetime = Query(..., description="Start time (ISO8601 UTC)"),
    t_end: datetime = Query(..., description="End time (ISO8601 UTC)"),
    domain: SourceDomain | None = Query(None),
    track_id: str | None = Query(None, max_length=64),
    bbox: str | None = Query(None, description="min_lon,min_lat,max_lon,max_lat"),
    format: str = Query("geojson", description="geojson | csv"),
    limit: int = Query(default=50_000, le=200_000),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Export track history as GeoJSON FeatureCollection or CSV download."""
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
            pass

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
        LIMIT :limit
    """)
    params["limit"] = limit

    result = await db.execute(sql, params)
    rows = result.mappings().all()

    if format == "csv":
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(
            ["event_id", "domain", "feed", "track_id", "callsign", "timestamp",
             "lon", "lat", "altitude_m", "heading_deg", "speed_mps", "classification"]
        )
        for r in rows:
            writer.writerow([
                r["event_id"],
                r["source_domain"],
                r["source_feed"],
                r["track_id"],
                r["callsign"],
                r["timestamp"],
                r["lon"],
                r["lat"],
                r["altitude_m"],
                r["heading_deg"],
                r["speed_mps"],
                r["classification"],
            ])
        output.seek(0)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="sentinel_export_{t_start.date()}.csv"'},
        )

    # GeoJSON
    features = []
    for r in rows:
        feat = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]} if r["lon"] is not None else None,
            "properties": {
                "event_id": str(r["event_id"]),
                "domain": r["source_domain"],
                "feed": r["source_feed"],
                "track_id": r["track_id"],
                "callsign": r["callsign"],
                "timestamp": r["timestamp"].isoformat() if r["timestamp"] else None,
                "altitude_m": r["altitude_m"],
                "heading_deg": r["heading_deg"],
                "speed_mps": r["speed_mps"],
                "classification": r["classification"],
            },
        }
        features.append(feat)

    geojson_str = orjson.dumps({
        "type": "FeatureCollection",
        "features": features,
        "meta": {"count": len(features)},
    }).decode("utf-8")
    return StreamingResponse(
        iter([geojson_str]),
        media_type="application/geo+json",
        headers={"Content-Disposition": f'attachment; filename="sentinel_export_{t_start.date()}.geojson"'},
    )


@router.get("/tracks/orbital", summary="Predict orbital ground track for a Space asset")
async def get_orbital_track(
    track_id: str = Query(..., max_length=64, description="NORAD catalogue number or track_id"),
    duration: str = Query(
        default="1h",
        description="Track duration: '1h' | '24h' | 'orbit' (one orbital period)",
    ),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """
    Propagate a satellite's TLE forward using SGP4 (skyfield) and return
    a predicted ground-track as a list of {lon, lat, alt_km, timestamp} points.

    The TLE is read from the most recent asset_states row for this track_id.
    Propagation is done in a thread-pool executor so it doesn't block the event loop.

    Duration options:
      '1h'    — next 60 minutes, sampled every ~2 minutes  (~30 points)
      '24h'   — next 24 hours,   sampled every ~8 minutes  (~180 points)
      'orbit' — one full orbital period, sampled every ~1 minute

    Note: orbital tracks are best visualised in Globe View — in flat (Mercator)
    projection a polar orbit will appear to zig-zag across the antimeridian.
    """
    # ── Fetch TLE from asset_states ─────────────────────────────
    sql = text("""
        SELECT metadata
        FROM asset_states
        WHERE track_id = :track_id
          AND source_domain = 'Space'
        ORDER BY last_seen DESC
        LIMIT 1
    """)
    result = await db.execute(sql, {"track_id": track_id})
    row = result.mappings().first()

    if not row or not row["metadata"]:
        raise HTTPException(
            status_code=404,
            detail=f"No orbital data found for track_id '{track_id}'. "
                   "Ensure the Space collector is running and the satellite has been seen.",
        )

    metadata = row["metadata"]
    tle_line1: str | None = metadata.get("tle_line1")
    tle_line2: str | None = metadata.get("tle_line2")

    if not tle_line1 or not tle_line2:
        raise HTTPException(
            status_code=422,
            detail=f"TLE data missing in metadata for track_id '{track_id}'.",
        )

    period_min: float = float(metadata.get("orbital_period_min", 90.0))

    # ── Determine propagation window ─────────────────────────────
    if duration == "orbit":
        # One complete orbital period — how long before the sat returns to the
        # same point above Earth. For LEO: ~90 min; GEO: 1440 min.
        duration_min = period_min
        sample_min = max(0.5, period_min / 180)     # ~180 sample points
    elif duration == "24h":
        duration_min = 1440.0
        sample_min = 8.0                             # ~180 points
    else:  # "1h"
        duration_min = 60.0
        sample_min = 2.0                             # ~30 points

    # ── Propagate in thread-pool (skyfield is synchronous) ───────
    def _propagate() -> list[dict]:
        try:
            from skyfield.api import EarthSatellite, wgs84, Loader
        except ImportError as exc:
            raise RuntimeError(f"skyfield not installed: {exc}") from exc

        # Use a local Loader so we can build a fresh timescale.
        # We don't need the cached TLE file here — we already have the lines.
        loader = Loader('/tmp/skyfield_data')
        ts = loader.timescale()

        sat = EarthSatellite(tle_line1, tle_line2, track_id, ts)

        now_utc = datetime.now(timezone.utc)
        points = []
        step = sample_min

        # Walk forward in time, computing subpoint at each step
        minutes = 0.0
        while minutes <= duration_min:
            t_utc = now_utc + timedelta(minutes=minutes)
            t = ts.from_datetime(t_utc)
            try:
                geocentric = sat.at(t)
                subpoint = wgs84.subpoint_of(geocentric)
                points.append({
                    "lon": round(subpoint.longitude.degrees, 5),
                    "lat": round(subpoint.latitude.degrees, 5),
                    "alt_km": round(subpoint.elevation.km, 1),
                    "timestamp": t_utc.isoformat(),
                })
            except Exception:
                pass  # skip degenerate propagation steps
            minutes += step

        return points

    loop = asyncio.get_event_loop()
    try:
        points = await loop.run_in_executor(None, _propagate)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return {
        "track_id": track_id,
        "duration": duration,
        "period_min": round(period_min, 2),
        "sample_interval_min": sample_min,
        "point_count": len(points),
        "points": points,
    }

"""
GPS Jamming Collector — GPSJam.org

This collector ingests GPSJam H3 cell measurements and writes them as:
- lightweight GPS track_events for map/timeline integration
- normalized disruption_events/disruption_observations via BaseCollector
"""

import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import h3

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector, TrackEventDict

GPSJAM_BASE = "https://gpsjam.org"


class GPSJamCollector(BaseCollector):
    DOMAIN = "GPS"
    FEED_NAME = "GPSJam"

    def __init__(self):
        super().__init__(
            db_url=os.environ["DATABASE_URL"],
            redis_url=os.environ["REDIS_URL"],
            poll_interval=float(os.environ.get("POLL_INTERVAL_SEC", 3600)),
        )
        self._enabled = os.environ.get("GPSJAM_ENABLED", "true").lower() != "false"
        self._previous_snapshot: dict[str, float] = {}
        self._first_seen: dict[str, datetime] = {}
        self._url_template = os.environ.get(
            "GPSJAM_DATA_URL_TEMPLATE",
            f"{GPSJAM_BASE}/data/{{date}}.json",
        )
        self._date_format = os.environ.get("GPSJAM_DATE_FORMAT", "%Y-%m-%d")
        self._date_offset_days = int(os.environ.get("GPSJAM_DATE_OFFSET_DAYS", "0"))
        self._timeout_sec = float(os.environ.get("GPSJAM_TIMEOUT_SEC", "30"))
        self._min_score = float(os.environ.get("GPSJAM_MIN_SCORE", "0.05"))

    async def fetch(self) -> list[dict]:
        if not self._enabled:
            return []
        observed_at = datetime.now(timezone.utc)
        target_date = (observed_at + timedelta(days=self._date_offset_days)).strftime(self._date_format)
        url = self._url_template.format(date=target_date)

        async with httpx.AsyncClient(timeout=self._timeout_sec, follow_redirects=True) as client:
            response = await client.get(url, headers={"User-Agent": "Sentinel/0.1"})
            response.raise_for_status()

        payload = self._decode_payload(response.text)
        snapshot = self._extract_snapshot(payload)
        if not snapshot:
            raise RuntimeError(f"GPSJam payload from {url} did not contain any H3 cells")

        events = self._build_events(snapshot, observed_at, url)
        await self._enrich_with_adsb_thinning(events)
        self._previous_snapshot = snapshot
        return events

    def _decode_payload(self, body: str) -> Any:
        text = body.strip()
        if text.startswith("{") or text.startswith("["):
            return json.loads(text)

        first_json = min(
            [idx for idx in (text.find("{"), text.find("[")) if idx >= 0],
            default=-1,
        )
        if first_json >= 0:
            trailing = text[first_json:]
            if trailing.endswith(";"):
                trailing = trailing[:-1]
            return json.loads(trailing)
        raise ValueError("Unable to locate JSON payload in GPSJam response")

    def _extract_snapshot(self, payload: Any) -> dict[str, float]:
        entries: list[tuple[str, float]] = []

        if isinstance(payload, dict):
            if payload and all(isinstance(v, (int, float)) for v in payload.values()):
                entries.extend((str(cell), float(score)) for cell, score in payload.items())
            for key in ("cells", "data", "features", "hexes"):
                nested = payload.get(key)
                if nested is not None:
                    entries.extend(self._extract_entries(nested))
        elif isinstance(payload, list):
            entries.extend(self._extract_entries(payload))

        snapshot: dict[str, float] = {}
        for cell, raw_score in entries:
            normalized = self._normalize_score(raw_score)
            if normalized is None or normalized < self._min_score:
                continue
            if h3.is_valid_cell(cell):
                snapshot[cell] = normalized
        return snapshot

    def _extract_entries(self, data: Any) -> list[tuple[str, float]]:
        entries: list[tuple[str, float]] = []
        if isinstance(data, dict):
            for cell_key in ("h3", "cell", "cell_id", "hex", "hex_id", "id"):
                if cell_key in data:
                    score = self._first_value(
                        data,
                        "score",
                        "value",
                        "probability",
                        "interference",
                        "jam_score",
                        "jamming_score",
                        "percent",
                    )
                    if score is not None:
                        entries.append((str(data[cell_key]), float(score)))
                    return entries
            for nested in data.values():
                entries.extend(self._extract_entries(nested))
            return entries

        if isinstance(data, list):
            for item in data:
                entries.extend(self._extract_entries(item))
        return entries

    def _first_value(self, mapping: dict[str, Any], *keys: str) -> Any:
        for key in keys:
            if key in mapping and mapping[key] not in (None, ""):
                return mapping[key]
        properties = mapping.get("properties")
        if isinstance(properties, dict):
            for key in keys:
                if key in properties and properties[key] not in (None, ""):
                    return properties[key]
        return None

    def _normalize_score(self, raw_score: float | int | str | None) -> float | None:
        if raw_score in (None, ""):
            return None
        score = float(raw_score)
        if score > 1:
            score = score / 100.0
        return max(0.0, min(score, 1.0))

    def _build_events(self, snapshot: dict[str, float], observed_at: datetime, source_url: str) -> list[dict]:
        events: list[dict] = []
        changed_cells = set(snapshot) | set(self._previous_snapshot)

        for cell in sorted(changed_cells):
            old_score = self._previous_snapshot.get(cell)
            new_score = snapshot.get(cell)
            if old_score == new_score:
                continue

            if new_score is not None:
                self._first_seen.setdefault(cell, observed_at)
                active_score = new_score
                status = "active"
                end_time = None
            else:
                active_score = old_score
                status = "resolved"
                end_time = observed_at
                self._first_seen.setdefault(cell, observed_at)

            if active_score is None:
                continue

            lat, lon = h3.cell_to_latlng(cell)
            boundary = h3.cell_to_boundary(cell)
            polygon = {
                "type": "Polygon",
                "coordinates": [[
                    [lng, lat_] for lat_, lng in boundary
                ] + [[boundary[0][1], boundary[0][0]]]],
            }
            severity_pct = round(active_score * 100.0, 2)

            events.append(TrackEventDict.create(
                source_domain=self.DOMAIN,
                source_feed=self.FEED_NAME,
                track_id=cell,
                callsign=f"GPSJam {cell}",
                lon=lon,
                lat=lat,
                timestamp=observed_at,
                classification="Hazard",
                metadata={
                    "h3_cell": cell,
                    "h3_resolution": h3.get_resolution(cell),
                    "gpsjam_score": active_score,
                    "gpsjam_percent": severity_pct,
                    "source_url": source_url,
                    "_disruption": {
                        "external_event_id": cell,
                        "event_type": "gps_interference",
                        "category": "gnss",
                        "title": f"GPS interference cell {cell}",
                        "status": status,
                        "severity": severity_pct,
                        "confidence": round(min(0.95, 0.35 + active_score * 0.6), 3),
                        "source_trust_score": 0.58,
                        "first_seen": self._first_seen[cell],
                        "last_seen": observed_at,
                        "start_time": self._first_seen[cell],
                        "end_time": end_time,
                        "geometry_geojson": json.dumps(polygon),
                        "h3_cell": cell,
                        "measurement_value": severity_pct,
                        "measurement_unit": "percent",
                        "observation_type": "grid_measurement",
                        "raw_payload": {
                            "cell": cell,
                            "score": active_score,
                            "source_url": source_url,
                        },
                        "event_metadata": {
                            "grid_system": "h3",
                            "resolution": h3.get_resolution(cell),
                        },
                    },
                },
            ))
        return events

    async def _enrich_with_adsb_thinning(self, events: list[dict]) -> None:
        if not self._db:
            return

        async with self._db.acquire() as conn:
            for event in events:
                disruption = (event.get("metadata") or {}).get("_disruption")
                if not isinstance(disruption, dict) or disruption.get("status") != "active":
                    continue
                geometry_geojson = disruption.get("geometry_geojson")
                if not geometry_geojson:
                    continue

                thinning = await conn.fetchrow("""
                    WITH cell AS (
                        SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326) AS geom
                    ),
                    baseline AS (
                        SELECT AVG(bucket_count) AS avg_tracks
                        FROM (
                            SELECT
                                time_bucket('15 minutes', timestamp) AS bucket,
                                COUNT(DISTINCT track_id) AS bucket_count
                            FROM track_events, cell
                            WHERE source_domain = 'Air'
                              AND timestamp >= NOW() - INTERVAL '24 hours'
                              AND timestamp < NOW() - INTERVAL '15 minutes'
                              AND position IS NOT NULL
                              AND ST_Intersects(position, cell.geom)
                            GROUP BY bucket
                        ) sampled
                    )
                    SELECT
                        (
                            SELECT COUNT(*)
                            FROM asset_states, cell
                            WHERE source_domain = 'Air'
                              AND last_seen >= NOW() - INTERVAL '20 minutes'
                              AND position IS NOT NULL
                              AND ST_Intersects(position, cell.geom)
                        ) AS current_tracks,
                        COALESCE((SELECT avg_tracks FROM baseline), 0) AS baseline_tracks
                """, geometry_geojson)

                current_tracks = float(thinning["current_tracks"] or 0) if thinning else 0.0
                baseline_tracks = float(thinning["baseline_tracks"] or 0) if thinning else 0.0
                ratio = (current_tracks / baseline_tracks) if baseline_tracks > 0 else None
                thinning_score = 0.0
                if ratio is not None:
                    thinning_score = max(0.0, min(1.0, 1.0 - ratio))

                base_confidence = float(disruption.get("confidence") or 0.0)
                boosted_confidence = base_confidence
                if baseline_tracks >= 4:
                    boosted_confidence = min(0.99, base_confidence + (thinning_score * 0.25))

                disruption["confidence"] = round(boosted_confidence, 3)
                disruption.setdefault("event_metadata", {}).update({
                    "adsb_current_tracks": round(current_tracks, 2),
                    "adsb_baseline_tracks": round(baseline_tracks, 2),
                    "adsb_thinning_ratio": round(ratio, 3) if ratio is not None else None,
                    "adsb_thinning_score": round(thinning_score, 3),
                })
                event["metadata"]["adsb_current_tracks"] = round(current_tracks, 2)
                event["metadata"]["adsb_baseline_tracks"] = round(baseline_tracks, 2)
                event["metadata"]["adsb_thinning_ratio"] = round(ratio, 3) if ratio is not None else None
                event["metadata"]["adsb_thinning_score"] = round(thinning_score, 3)


if __name__ == "__main__":
    collector = GPSJamCollector()
    asyncio.run(collector.run())

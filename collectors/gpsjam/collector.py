"""
GPS Jamming Collector — GPSJam.org

This collector ingests GPSJam H3 cell measurements and writes them as:
- lightweight GPS track_events for map/timeline integration
- normalized disruption_events/disruption_observations via BaseCollector
"""

import asyncio
import csv
import json
import logging
import os
from io import StringIO
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx
import h3

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector, DEFAULT_DATABASE_URL, DEFAULT_REDIS_URL, TrackEventDict

GPSJAM_BASE = "https://gpsjam.org"
logger = logging.getLogger(__name__)


class GPSJamCollector(BaseCollector):
    DOMAIN = "GPS"
    FEED_NAME = "GPSJam"

    def __init__(self):
        super().__init__(
            db_url=os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL),
            redis_url=os.environ.get("REDIS_URL", DEFAULT_REDIS_URL),
            poll_interval=float(os.environ.get("POLL_INTERVAL_SEC", 3600)),
        )
        self._enabled = os.environ.get("GPSJAM_ENABLED", "true").lower() != "false"
        self._previous_snapshot: dict[str, float] = {}
        self._first_seen: dict[str, datetime] = {}
        self._url_template = os.environ.get(
            "GPSJAM_DATA_URL_TEMPLATE",
            f"{GPSJAM_BASE}/data/{{date}}-h3_{{resolution}}.csv",
        )
        self._h3_resolution = int(os.environ.get("GPSJAM_H3_RESOLUTION", "4"))
        self._date_format = os.environ.get("GPSJAM_DATE_FORMAT", "%Y-%m-%d")
        self._date_offset_days = int(os.environ.get("GPSJAM_DATE_OFFSET_DAYS", "0"))
        self._timeout_sec = float(os.environ.get("GPSJAM_TIMEOUT_SEC", "30"))
        self._min_score = float(os.environ.get("GPSJAM_MIN_SCORE", "0.05"))
        self._max_days_back = int(os.environ.get("GPSJAM_MAX_DAYS_BACK", "2"))
        self._backfill_days = int(os.environ.get("GPSJAM_BACKFILL_DAYS", "180"))
        self._backfill_batch_days = int(os.environ.get("GPSJAM_BACKFILL_BATCH_DAYS", "7"))
        self._startup_logged = False
        self._disabled_logged = False

    async def fetch(self) -> list[dict]:
        if not self._enabled:
            if not self._disabled_logged:
                logger.info("[GPSJam] Collector disabled via GPSJAM_ENABLED=false")
                self._disabled_logged = True
            return []
        if not self._startup_logged:
            logger.info(
                "[GPSJam] Config url_template=%s h3_resolution=%s date_format=%s date_offset_days=%s "
                "max_days_back=%s backfill_days=%s backfill_batch_days=%s min_score=%s",
                self._url_template,
                self._h3_resolution,
                self._date_format,
                self._date_offset_days,
                self._max_days_back,
                self._backfill_days,
                self._backfill_batch_days,
                self._min_score,
            )
            self._startup_logged = True
        observed_at = datetime.now(timezone.utc)
        target_days = await self._target_dates(observed_at.date())
        all_events: list[dict] = []
        latest_snapshot: dict[str, float] | None = None
        latest_url: str | None = None

        async with httpx.AsyncClient(timeout=self._timeout_sec, follow_redirects=True) as client:
            for target_day in target_days:
                snapshot, source_url = await self._fetch_snapshot_for_date(client, target_day)
                if not snapshot or not source_url:
                    continue
                event_time = datetime.combine(target_day, datetime.min.time(), tzinfo=timezone.utc)
                events = self._build_events(snapshot, event_time, source_url)
                all_events.extend(events)
                latest_snapshot = snapshot
                latest_url = source_url

        if latest_snapshot is None or latest_url is None:
            raise RuntimeError("GPSJam could not find a usable daily dataset in the configured backfill window")

        await self._enrich_with_adsb_thinning(all_events)
        self._previous_snapshot = latest_snapshot
        logger.info(
            "[GPSJam] Processed %s day(s); latest snapshot had %s active cells and total produced %s events",
            len(target_days),
            len(latest_snapshot),
            len(all_events),
        )
        return all_events

    async def _target_dates(self, latest_day: date) -> list[date]:
        target_days: list[date] = [latest_day]
        if not self._db or self._backfill_days <= 0 or self._backfill_batch_days <= 0:
            return target_days

        range_start = latest_day - timedelta(days=self._backfill_days - 1)
        existing_days = await self._existing_days(range_start, latest_day)
        missing_days = [
            candidate
            for candidate in self._date_range(range_start, latest_day)
            if candidate not in existing_days and candidate != latest_day
        ]
        if missing_days:
            target_days.extend(missing_days[: self._backfill_batch_days])
            logger.info(
                "[GPSJam] Backfilling %s missing day(s) out of %s over the last %s days",
                min(len(missing_days), self._backfill_batch_days),
                len(missing_days),
                self._backfill_days,
            )
        return sorted(set(target_days))

    async def _existing_days(self, start_day: date, end_day: date) -> set[date]:
        if not self._db:
            return set()
        async with self._db.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT DISTINCT DATE(timezone('UTC', timestamp)) AS day
                FROM track_events
                WHERE source_feed = 'GPSJam'
                  AND timestamp >= $1
                  AND timestamp < $2
                """,
                datetime.combine(start_day, datetime.min.time(), tzinfo=timezone.utc),
                datetime.combine(end_day + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc),
            )
        return {row["day"] for row in rows if row["day"] is not None}

    def _date_range(self, start_day: date, end_day: date) -> list[date]:
        days: list[date] = []
        cursor = start_day
        while cursor <= end_day:
            days.append(cursor)
            cursor += timedelta(days=1)
        return days

    async def _fetch_snapshot_for_date(
        self,
        client: httpx.AsyncClient,
        target_day: date,
    ) -> tuple[dict[str, float], str | None]:
        for days_back in range(self._max_days_back + 1):
            candidate_day = target_day - timedelta(days=days_back)
            target_date = candidate_day.strftime(self._date_format)
            candidate_url = self._url_template.format(
                date=target_date,
                resolution=self._h3_resolution,
            )
            response = await client.get(candidate_url, headers={"User-Agent": "Sentinel/0.1"})
            if response.status_code == 404:
                if days_back == 0:
                    logger.info("[GPSJam] No dataset at %s", candidate_url)
                continue
            response.raise_for_status()
            snapshot = self._extract_snapshot(response.text)
            if snapshot:
                if candidate_day != target_day:
                    logger.info(
                        "[GPSJam] Using fallback dataset %s for target day %s",
                        candidate_day.isoformat(),
                        target_day.isoformat(),
                    )
                return snapshot, candidate_url
            logger.info("[GPSJam] Dataset at %s contained no usable H3 cells", candidate_url)
        return {}, None

    def _extract_snapshot(self, payload_text: str) -> dict[str, float]:
        snapshot: dict[str, float] = {}
        reader = csv.DictReader(StringIO(payload_text))
        for row in reader:
            cell = str(row.get("hex") or "").strip()
            if not cell or not h3.is_valid_cell(cell):
                continue
            normalized = self._row_score(row)
            if normalized is None or normalized < self._min_score:
                continue
            snapshot[cell] = normalized
        return snapshot

    def _row_score(self, row: dict[str, Any]) -> float | None:
        bad_raw = row.get("count_bad_aircraft")
        good_raw = row.get("count_good_aircraft")
        if bad_raw in (None, "") or good_raw in (None, ""):
            return None
        bad = float(bad_raw)
        good = float(good_raw)
        total = bad + good
        if total <= 0:
            return None
        # GPSJam's own client uses (bad - 1) / total to damp single-aircraft noise.
        score = (bad - 1.0) / total
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
                            FROM asset_current_state, cell
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

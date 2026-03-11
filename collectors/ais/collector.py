"""
AIS Collector

Supports:
  - AISStream live websocket ingestion
  - AccessAIS historical CSV/ZIP import (manual NOAA/MarineCadastre downloads)
  - Global Fishing Watch AIS vessel presence ingestion (hourly, delayed)

AISHub config is intentionally left in the environment/docs for future use, but
the runtime path is disabled by default because free access requires a
reciprocal feed.
"""

import asyncio
import csv
import io
import json
import logging
import os
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import websockets

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector, TrackEventDict

logger = logging.getLogger(__name__)
LIVE_AIS_FEEDS = {"AISStream", "AccessAIS"}

# Vessel type codes -> classification
VESSEL_TYPE_MAP = {
    range(20, 30): "Wing in Ground",
    range(30, 40): "Fishing",
    range(35, 36): "Military",
    range(40, 50): "High Speed Craft",
    range(50, 60): "Special Craft",
    range(60, 70): "Passenger",
    range(70, 80): "Cargo",
    range(80, 90): "Tanker",
    range(90, 100): "Other",
}


def classify_vessel(vessel_type: int | None) -> str:
    if vessel_type == 35:
        return "Military"
    if vessel_type is not None:
        for code_range, classification in VESSEL_TYPE_MAP.items():
            if vessel_type in code_range:
                return classification
    return "Unknown"


def parse_float(value: object) -> float | None:
    if value in (None, "", "None"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_int(value: object) -> int | None:
    if value in (None, "", "None"):
        return None
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
        return None


def parse_timestamp(value: object) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    if value in (None, ""):
        return datetime.now(timezone.utc)

    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        pass

    for fmt in ("%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue

    return datetime.now(timezone.utc)


def first_present(mapping: dict, keys: tuple[str, ...]) -> object:
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return None


class AISCollector(BaseCollector):
    DOMAIN = "Maritime"
    FEED_NAME = "AIS"
    AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"
    GFW_REPORT_URL = "https://gateway.api.globalfishingwatch.org/v3/4wings/report"

    def __init__(self):
        self.mode = os.environ.get("AIS_MODE", "aisstream").strip().lower()
        self.import_completed = False

        super().__init__(
            db_url=os.environ["DATABASE_URL"],
            redis_url=os.environ["REDIS_URL"],
            poll_interval=float(os.environ.get("POLL_INTERVAL_SEC", 30)),
        )

        self.aisstream_api_key = os.environ.get("AISSTREAM_API_KEY", "").strip()
        self.aisstream_bounding_boxes = json.loads(
            os.environ.get("AISSTREAM_BOUNDING_BOXES", '[[[24.0,-125.0],[50.0,-66.0]]]')
        )
        self.aisstream_message_types = json.loads(
            os.environ.get(
                "AISSTREAM_MESSAGE_TYPES",
                '["PositionReport","StandardClassBPositionReport","ShipStaticData"]',
            )
        )
        self.aisstream_filters_ship_mmsi = json.loads(
            os.environ.get("AISSTREAM_FILTERS_SHIP_MMSI", "[]")
        )
        self.aisstream_max_messages = int(os.environ.get("AISSTREAM_MAX_MESSAGES", 250))
        self.aisstream_window_sec = float(os.environ.get("AISSTREAM_WINDOW_SEC", 20))

        self.accessais_import_path = os.environ.get("ACCESSAIS_IMPORT_PATH", "").strip()
        self.accessais_archive_dir = Path(os.environ.get("ACCESSAIS_ARCHIVE_DIR", "/tmp/accessais-archive"))
        self.gfw_api_token = os.environ.get("GFW_API_TOKEN", "").strip()
        self.gfw_dataset = os.environ.get("GFW_DATASET", "public-global-presence:latest").strip()
        self.gfw_bounding_box = json.loads(
            os.environ.get("GFW_BOUNDING_BOX", "[[-90,-180],[90,180]]")
        )
        self.gfw_filters = json.loads(os.environ.get("GFW_FILTERS", "[]"))
        self.gfw_temporal_resolution = os.environ.get("GFW_TEMPORAL_RESOLUTION", "HOURLY").strip().upper()
        self.gfw_spatial_resolution = os.environ.get("GFW_SPATIAL_RESOLUTION", "HIGH").strip().upper()
        self.gfw_lag_hours = int(os.environ.get("GFW_LAG_HOURS", 96))
        self.gfw_window_hours = int(os.environ.get("GFW_WINDOW_HOURS", 1))
        self.gfw_max_rows = int(os.environ.get("GFW_MAX_ROWS", 5000))
        self.gfw_enrich_only = os.environ.get("GFW_ENRICH_ONLY", "true").strip().lower() not in {"0", "false", "no"}
        self.gfw_publish_live = os.environ.get("GFW_PUBLISH_LIVE", "false").strip().lower() in {"1", "true", "yes"}
        self.gfw_state_eligible = os.environ.get("GFW_STATE_ELIGIBLE", "false").strip().lower() in {"1", "true", "yes"}
        self.gfw_suppress_if_live_seen_hours = int(os.environ.get("GFW_SUPPRESS_IF_LIVE_SEEN_HOURS", 24))
        self.ais_merge_sources = json.loads(os.environ.get("AIS_MERGE_SOURCES", '["aisstream","gfw"]'))
        self._gfw_last_bucket_end: datetime | None = None
        self._recent_live_seen_at: dict[str, datetime] = {}

    async def fetch(self) -> list[dict]:
        if self.mode == "aisstream":
            return await self._fetch_aisstream()
        if self.mode == "accessais":
            return await self._fetch_accessais()
        if self.mode in {"gfw", "globalfishingwatch"}:
            return await self._fetch_global_fishing_watch()
        if self.mode in {"merge", "hybrid"}:
            return await self._fetch_merge()
        if self.mode == "aishub":
            raise NotImplementedError(
                "AISHub mode is intentionally disabled. Configure AIS_MODE=aisstream, accessais, gfw, or merge."
            )
        raise ValueError(f"Unsupported AIS_MODE: {self.mode}")

    async def run(self):
        await self.startup()
        self._running = True
        consecutive_errors = 0

        while self._running:
            t0 = asyncio.get_running_loop().time()
            try:
                events = await self.fetch()
                if events:
                    await self._write_batch(events)
                    logger.info("[%s] Wrote %s events", self.FEED_NAME, len(events))
                if self.mode == "accessais" and self.import_completed:
                    self._running = False
                    continue
                consecutive_errors = 0
            except asyncio.CancelledError:
                break
            except Exception as exc:
                consecutive_errors += 1
                backoff = min(60, 2 ** consecutive_errors)
                logger.error("[%s] Fetch error (%s): %r. Backing off %ss",
                             self.FEED_NAME, consecutive_errors, exc, backoff)
                await asyncio.sleep(backoff)
                continue

            elapsed = asyncio.get_running_loop().time() - t0
            await asyncio.sleep(max(0, self.poll_interval - elapsed))

        await self.shutdown()

    async def _fetch_aisstream(self) -> list[dict]:
        if not self.aisstream_api_key:
            raise ValueError("AISSTREAM_API_KEY is required for AIS_MODE=aisstream")

        subscribe_message = {
            "APIKey": self.aisstream_api_key,
            "BoundingBoxes": self.aisstream_bounding_boxes,
        }
        if self.aisstream_filters_ship_mmsi:
            subscribe_message["FiltersShipMMSI"] = self.aisstream_filters_ship_mmsi
        if self.aisstream_message_types:
            subscribe_message["FilterMessageTypes"] = self.aisstream_message_types

        events: list[dict] = []
        vessel_metadata: dict[str, dict] = {}
        deadline = asyncio.get_running_loop().time() + self.aisstream_window_sec

        try:
            async with websockets.connect(self.AISSTREAM_URL, max_size=4 * 1024 * 1024) as websocket:
                await websocket.send(json.dumps(subscribe_message))

                while len(events) < self.aisstream_max_messages:
                    timeout = deadline - asyncio.get_running_loop().time()
                    if timeout <= 0:
                        break
                    try:
                        raw_message = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                    except asyncio.TimeoutError:
                        break

                    payload = json.loads(raw_message)
                    event = self._event_from_aisstream_message(payload, vessel_metadata)
                    if event:
                        events.append(event)
        except Exception as exc:
            raise RuntimeError(
                f"AISStream fetch failed (api_key_set={bool(self.aisstream_api_key)}, "
                f"window_sec={self.aisstream_window_sec}, bbox={self.aisstream_bounding_boxes!r}, "
                f"filters_ship_mmsi={self.aisstream_filters_ship_mmsi!r}, "
                f"message_types={self.aisstream_message_types!r}): {exc!r}"
            ) from exc

        return events

    def _event_from_aisstream_message(self, payload: dict, vessel_metadata: dict[str, dict]) -> dict | None:
        message_type = payload.get("MessageType", "Unknown")
        message_wrapper = payload.get("Message") or {}
        metadata = payload.get("Metadata") or {}

        if not isinstance(message_wrapper, dict) or not message_wrapper:
            return None

        body = next(iter(message_wrapper.values()))
        if not isinstance(body, dict):
            return None

        user_id = first_present(body, ("UserID", "MMSI", "MessageID"))
        if user_id is None:
            return None
        track_id = str(user_id)

        previous = vessel_metadata.get(track_id, {})
        merged = {**previous, **metadata, **body}
        vessel_metadata[track_id] = merged

        if message_type == "ShipStaticData":
            return None

        lon = parse_float(first_present(merged, ("Longitude", "lon", "LON")))
        lat = parse_float(first_present(merged, ("Latitude", "lat", "LAT")))
        if lon is None or lat is None:
            return None

        speed_knots = parse_float(first_present(merged, ("Sog", "SOG", "Speed")))
        heading = parse_float(first_present(merged, ("Cog", "COG", "TrueHeading", "Heading")))
        vessel_type = parse_int(first_present(merged, ("Type", "ShipType", "VesselType")))
        callsign = first_present(merged, ("CallSign", "Callsign", "VesselName", "Name"))

        timestamp = parse_timestamp(first_present(
            merged,
            ("time_utc", "Timestamp", "BaseDateTime", "MessageTime", "time"),
        ))

        return TrackEventDict.create(
            source_domain=self.DOMAIN,
            source_feed="AISStream",
            track_id=track_id,
            timestamp=timestamp,
            lon=lon,
            lat=lat,
            callsign=str(callsign).strip() if callsign else None,
            heading_deg=heading,
            speed_mps=(speed_knots * 0.514444) if speed_knots is not None else None,
            classification=classify_vessel(vessel_type),
            metadata={
                "provider": "AISStream",
                "source_priority": 100,
                "analysis_role": "live",
                "current_state_eligible": True,
                "publish_live": True,
                "message_type": message_type,
                "mmsi": track_id,
                "vessel_name": first_present(merged, ("VesselName", "Name")),
                "imo": first_present(merged, ("ImoNumber", "IMO")),
                "ship_type": vessel_type,
                "nav_status": first_present(merged, ("NavigationalStatus", "NavStatus")),
                "destination": first_present(merged, ("Destination",)),
            },
        )

    async def _fetch_accessais(self) -> list[dict]:
        if self.import_completed:
            return []
        if not self.accessais_import_path:
            raise ValueError("ACCESSAIS_IMPORT_PATH is required for AIS_MODE=accessais")

        path = Path(self.accessais_import_path)
        if not path.exists():
            raise FileNotFoundError(f"AccessAIS import file not found: {path}")

        rows = await asyncio.to_thread(self._load_accessais_rows, path)
        self.import_completed = True
        return rows

    async def _fetch_global_fishing_watch(self) -> list[dict]:
        if not self.gfw_api_token:
            raise ValueError("GFW_API_TOKEN is required for AIS_MODE=gfw")

        bucket_end = self._gfw_bucket_end()
        if self._gfw_last_bucket_end is not None and bucket_end <= self._gfw_last_bucket_end:
            return []

        start = bucket_end - timedelta(hours=self.gfw_window_hours)
        params: list[tuple[str, str]] = [
            ("spatial-aggregation", "true"),
            ("spatial-resolution", self.gfw_spatial_resolution),
            ("temporal-resolution", self.gfw_temporal_resolution),
            ("group-by", "MMSI"),
            ("format", "JSON"),
            ("date-range", f"{self._to_gfw_iso(start)},{self._to_gfw_iso(bucket_end)}"),
            ("datasets[0]", self.gfw_dataset),
        ]
        for index, filter_value in enumerate(self.gfw_filters):
            params.append((f"filters[{index}]", str(filter_value)))

        payload = {"geojson": self._bbox_geojson(self.gfw_bounding_box)}
        headers = {"Authorization": f"Bearer {self.gfw_api_token}"}

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(self.GFW_REPORT_URL, params=params, json=payload, headers=headers)

        if response.status_code == 429:
            logger.warning("[AIS] Global Fishing Watch rate/concurrency limit hit: %s", response.text[:300])
            return []
        response.raise_for_status()

        data = response.json()
        if isinstance(data, dict) and data.get("status") == "running":
            logger.info(
                "[AIS] Global Fishing Watch report still running for bucket ending %s",
                bucket_end.isoformat(),
            )
            return []

        entries = self._extract_gfw_entries(data)
        if not entries:
            self._gfw_last_bucket_end = bucket_end
            return []

        events: list[dict] = []
        for row in entries[: self.gfw_max_rows]:
            event = self._event_from_gfw_row(row, bucket_end=bucket_end)
            if event:
                events.append(event)

        self._gfw_last_bucket_end = bucket_end
        return events

    async def _fetch_merge(self) -> list[dict]:
        sources = [str(source).strip().lower() for source in self.ais_merge_sources if str(source).strip()]
        if not sources:
            raise ValueError("AIS_MERGE_SOURCES must include at least one source")

        tasks: list[tuple[str, asyncio.Task[list[dict]]]] = []
        for source in sources:
            if source == "aisstream":
                tasks.append((source, asyncio.create_task(self._fetch_aisstream())))
            elif source == "accessais":
                tasks.append((source, asyncio.create_task(self._fetch_accessais())))
            elif source in {"gfw", "globalfishingwatch"}:
                tasks.append((source, asyncio.create_task(self._fetch_global_fishing_watch())))
            else:
                raise ValueError(f"Unsupported AIS merge source: {source}")

        merged: list[dict] = []
        for source, task in tasks:
            try:
                merged.extend(await task)
            except Exception as exc:
                logger.error("[AIS] Merge source %s failed: %r", source, exc)

        self._remember_live_events(merged)
        return self._prioritize_merged_events(merged)

    def _load_accessais_rows(self, path: Path) -> list[dict]:
        suffixes = [suffix.lower() for suffix in path.suffixes]
        if suffixes[-2:] == [".csv", ".zip"]:
            return self._load_accessais_zip(path)
        if path.suffix.lower() == ".zip":
            return self._load_accessais_zip(path)
        if path.suffix.lower() == ".csv":
            with path.open("r", newline="", encoding="utf-8-sig") as handle:
                return self._parse_accessais_csv(handle)
        raise ValueError(f"Unsupported AccessAIS file type: {path.name}")

    def _load_accessais_zip(self, path: Path) -> list[dict]:
        with zipfile.ZipFile(path) as archive:
            csv_names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
            if not csv_names:
                raise ValueError(f"No CSV files found inside {path.name}")
            with archive.open(csv_names[0], "r") as zipped:
                text_stream = io.TextIOWrapper(zipped, encoding="utf-8-sig", newline="")
                return self._parse_accessais_csv(text_stream)

    def _parse_accessais_csv(self, handle: io.TextIOBase) -> list[dict]:
        reader = csv.DictReader(handle)
        events: list[dict] = []

        for row in reader:
            mmsi = first_present(row, ("MMSI", "mmsi"))
            lon = parse_float(first_present(row, ("LON", "Longitude", "lon")))
            lat = parse_float(first_present(row, ("LAT", "Latitude", "lat")))

            if not mmsi or lon is None or lat is None:
                continue

            vessel_type = parse_int(first_present(row, ("VesselType", "ShipType", "ship_type")))
            speed_knots = parse_float(first_present(row, ("SOG", "sog")))
            heading = parse_float(first_present(row, ("COG", "Heading", "heading")))

            events.append(TrackEventDict.create(
                source_domain=self.DOMAIN,
                source_feed="AccessAIS",
                track_id=str(mmsi),
                timestamp=parse_timestamp(first_present(row, ("BaseDateTime", "base_datetime", "Timestamp"))),
                lon=lon,
                lat=lat,
                callsign=first_present(row, ("CallSign", "VesselName", "vessel_name")),
                heading_deg=heading,
                speed_mps=(speed_knots * 0.514444) if speed_knots is not None else None,
                classification=classify_vessel(vessel_type),
                metadata={
                    "provider": "AccessAIS",
                    "source_priority": 80,
                    "analysis_role": "historical_import",
                    "current_state_eligible": True,
                    "publish_live": False,
                    "mmsi": str(mmsi),
                    "vessel_name": first_present(row, ("VesselName", "vessel_name")),
                    "imo": first_present(row, ("IMO", "imo")),
                    "ship_type": vessel_type,
                    "status": first_present(row, ("Status", "status")),
                    "cargo": first_present(row, ("Cargo", "cargo")),
                },
            ))

        return events

    def _gfw_bucket_end(self) -> datetime:
        delayed_now = datetime.now(timezone.utc) - timedelta(hours=self.gfw_lag_hours)
        return delayed_now.replace(minute=0, second=0, microsecond=0)

    def _to_gfw_iso(self, dt: datetime) -> str:
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _bbox_geojson(self, bbox: list[list[float]]) -> dict:
        if (
            not isinstance(bbox, list)
            or len(bbox) != 2
            or any(not isinstance(pair, list) or len(pair) != 2 for pair in bbox)
        ):
            raise ValueError("GFW_BOUNDING_BOX must be [[min_lat,min_lon],[max_lat,max_lon]]")

        min_lat, min_lon = bbox[0]
        max_lat, max_lon = bbox[1]
        return {
            "type": "Polygon",
            "coordinates": [[
                [min_lon, min_lat],
                [max_lon, min_lat],
                [max_lon, max_lat],
                [min_lon, max_lat],
                [min_lon, min_lat],
            ]],
        }

    def _extract_gfw_entries(self, payload: object) -> list[dict]:
        if not isinstance(payload, dict):
            return []
        raw_entries = payload.get("entries")
        if not isinstance(raw_entries, list):
            return []

        flattened: list[dict] = []
        for entry in raw_entries:
            if not isinstance(entry, dict):
                continue
            for dataset_entries in entry.values():
                if isinstance(dataset_entries, list):
                    flattened.extend(item for item in dataset_entries if isinstance(item, dict))
        return flattened

    def _event_from_gfw_row(self, row: dict, bucket_end: datetime) -> dict | None:
        lon = parse_float(row.get("lon"))
        lat = parse_float(row.get("lat"))
        if lon is None or lat is None:
            return None

        mmsi = first_present(row, ("mmsi",))
        vessel_id = first_present(row, ("vessel_id",))
        track_id = str(mmsi or vessel_id or "").strip()
        if not track_id:
            return None

        vessel_type = row.get("vessel_type")
        ship_name = first_present(row, ("shipName", "ship_name"))
        callsign = first_present(row, ("callsign", "callSign", "shipName"))
        timestamp = parse_timestamp(first_present(row, ("date", "entryTimestamp", "exitTimestamp")) or bucket_end)

        return TrackEventDict.create(
            source_domain=self.DOMAIN,
            source_feed="GlobalFishingWatch",
            track_id=track_id,
            timestamp=timestamp,
            lon=lon,
            lat=lat,
            callsign=str(callsign).strip() if callsign else None,
            heading_deg=None,
            speed_mps=None,
            classification=self._classify_gfw_vessel_type(vessel_type),
            metadata={
                "provider": "GlobalFishingWatch",
                "source_priority": 40,
                "analysis_role": "historical_enrichment" if self.gfw_enrich_only else "supplemental_live",
                "current_state_eligible": self.gfw_state_eligible and not self.gfw_enrich_only,
                "publish_live": self.gfw_publish_live and not self.gfw_enrich_only,
                "mmsi": str(mmsi).strip() if mmsi else None,
                "gfw_vessel_id": str(vessel_id).strip() if vessel_id else None,
                "vessel_name": ship_name,
                "callsign": first_present(row, ("callsign", "callSign")),
                "imo": first_present(row, ("imo",)),
                "flag": first_present(row, ("flag",)),
                "hours": parse_float(row.get("hours")),
                "vessel_type": vessel_type,
                "geartype": first_present(row, ("geartype",)),
                "first_transmission_date": first_present(row, ("firstTransmissionDate",)),
                "last_transmission_date": first_present(row, ("lastTransmissionDate",)),
                "dataset": first_present(row, ("dataset",)),
            },
        )

    def _classify_gfw_vessel_type(self, vessel_type: object) -> str:
        if vessel_type is None:
            return "Unknown"
        value = str(vessel_type).strip()
        if not value:
            return "Unknown"
        return " ".join(part.capitalize() for part in value.replace("_", " ").split())

    def _remember_live_events(self, events: list[dict]) -> None:
        for event in events:
            if event.get("source_feed") not in LIVE_AIS_FEEDS:
                continue
            self._recent_live_seen_at[event["track_id"]] = parse_timestamp(event.get("timestamp"))

        cutoff = datetime.now(timezone.utc) - timedelta(hours=max(self.gfw_suppress_if_live_seen_hours, 1) * 2)
        stale_track_ids = [track_id for track_id, seen_at in self._recent_live_seen_at.items() if seen_at < cutoff]
        for track_id in stale_track_ids:
            self._recent_live_seen_at.pop(track_id, None)

    def _prioritize_merged_events(self, events: list[dict]) -> list[dict]:
        prioritized: list[dict] = []
        live_cutoff = datetime.now(timezone.utc) - timedelta(hours=self.gfw_suppress_if_live_seen_hours)

        for event in events:
            metadata = dict(event.get("metadata") or {})
            if event.get("source_feed") == "GlobalFishingWatch":
                last_live_seen = self._recent_live_seen_at.get(event.get("track_id", ""))
                if last_live_seen and last_live_seen >= live_cutoff:
                    metadata["current_state_eligible"] = False
                    metadata["publish_live"] = False
                    metadata["suppressed_by_live_source"] = True
                    metadata["suppressed_by_feed"] = "AISStream"
            event["metadata"] = metadata
            prioritized.append(event)

        return prioritized

    def _events_for_current_state(self, events: list[dict]) -> list[dict]:
        return [
            event
            for event in events
            if bool((event.get("metadata") or {}).get("current_state_eligible", True))
        ]

    def _events_for_publish(self, events: list[dict]) -> list[dict]:
        return [
            event
            for event in events
            if bool((event.get("metadata") or {}).get("publish_live", True))
        ]


if __name__ == "__main__":
    collector = AISCollector()
    asyncio.run(collector.run())

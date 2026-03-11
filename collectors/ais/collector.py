"""
AIS Collector

Supports:
  - AISStream live websocket ingestion
  - AccessAIS historical CSV/ZIP import (manual NOAA/MarineCadastre downloads)

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
from datetime import datetime, timezone
from pathlib import Path

import websockets

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector, TrackEventDict

logger = logging.getLogger(__name__)

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

    async def fetch(self) -> list[dict]:
        if self.mode == "aisstream":
            return await self._fetch_aisstream()
        if self.mode == "accessais":
            return await self._fetch_accessais()
        if self.mode == "aishub":
            raise NotImplementedError(
                "AISHub mode is intentionally disabled. Configure AIS_MODE=aisstream or accessais."
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
                    "mmsi": str(mmsi),
                    "vessel_name": first_present(row, ("VesselName", "vessel_name")),
                    "imo": first_present(row, ("IMO", "imo")),
                    "ship_type": vessel_type,
                    "status": first_present(row, ("Status", "status")),
                    "cargo": first_present(row, ("Cargo", "cargo")),
                },
            ))

        return events


if __name__ == "__main__":
    collector = AISCollector()
    asyncio.run(collector.run())

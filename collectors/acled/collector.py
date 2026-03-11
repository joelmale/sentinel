"""
ACLED conflict event collector.

Ingests ACLED event records into normalized disruption tables and emits
point-based track events for the existing map/timeline pipeline.
"""

import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector, TrackEventDict

ACLED_API = "https://api.acleddata.com/acled/read"


class ACLEDCollector(BaseCollector):
    DOMAIN = "Infra"
    FEED_NAME = "ACLED"

    def __init__(self):
        super().__init__(
            db_url=os.environ["DATABASE_URL"],
            redis_url=os.environ["REDIS_URL"],
            poll_interval=float(os.environ.get("POLL_INTERVAL_SEC", 1800)),
        )
        self._enabled = os.environ.get("ACLED_ENABLED", "true").lower() != "false"
        self._email = os.environ.get("ACLED_EMAIL", "").strip()
        self._access_key = os.environ.get("ACLED_ACCESS_KEY", "").strip()
        self._timeout_sec = float(os.environ.get("ACLED_TIMEOUT_SEC", "45"))
        self._lookback_days = int(os.environ.get("ACLED_LOOKBACK_DAYS", "7"))
        self._limit = int(os.environ.get("ACLED_LIMIT", "500"))
        self._countries = self._split_csv(os.environ.get("ACLED_COUNTRIES", ""))
        self._event_types = self._split_csv(os.environ.get("ACLED_EVENT_TYPES", ""))

    async def fetch(self) -> list[dict]:
        if not self._enabled:
            return []
        if not self._email or not self._access_key:
            return []

        cutoff = datetime.now(timezone.utc) - timedelta(days=self._lookback_days)
        params: list[tuple[str, str]] = [
            ("email", self._email),
            ("key", self._access_key),
            ("limit", str(self._limit)),
            ("event_date_where", ">="),
            ("event_date", cutoff.date().isoformat()),
        ]
        for country in self._countries:
            params.append(("country", country))
        for event_type in self._event_types:
            params.append(("event_type", event_type))

        async with httpx.AsyncClient(timeout=self._timeout_sec, follow_redirects=True) as client:
            response = await client.get(
                ACLED_API,
                params=params,
                headers={"User-Agent": "Sentinel/0.1"},
            )
            response.raise_for_status()

        payload = response.json()
        rows = payload.get("data", []) if isinstance(payload, dict) else []
        events: list[dict] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            lon = self._coerce_float(row.get("longitude"))
            lat = self._coerce_float(row.get("latitude"))
            if lon is None or lat is None:
                continue
            event_id = str(row.get("event_id_cnty") or row.get("event_id_no_cnty") or row.get("data_id") or "")
            if not event_id:
                continue
            observed_at = self._coerce_dt(row.get("event_date")) or datetime.now(timezone.utc)
            event_type = str(row.get("sub_event_type") or row.get("event_type") or "conflict_event")
            country = str(row.get("country") or "")
            location = str(row.get("location") or "")
            title = " / ".join(part for part in [event_type, location or country] if part)
            fatalities = self._coerce_float(row.get("fatalities")) or 0.0
            severity = min(100.0, 20.0 + fatalities * 10.0)
            confidence = 0.91

            events.append(TrackEventDict.create(
                source_domain=self.DOMAIN,
                source_feed=self.FEED_NAME,
                track_id=event_id,
                callsign=title or event_id,
                lon=lon,
                lat=lat,
                timestamp=observed_at,
                classification="Conflict",
                metadata={
                    "country": country,
                    "admin1": row.get("admin1"),
                    "admin2": row.get("admin2"),
                    "location": location,
                    "event_type": row.get("event_type"),
                    "sub_event_type": row.get("sub_event_type"),
                    "actor1": row.get("actor1"),
                    "actor2": row.get("actor2"),
                    "fatalities": fatalities,
                    "notes": row.get("notes"),
                    "acled_event": row,
                    "_disruption": {
                        "external_event_id": event_id,
                        "event_type": "conflict_event",
                        "category": "conflict",
                        "title": title or f"ACLED event {event_id}",
                        "status": "active",
                        "severity": severity,
                        "confidence": confidence,
                        "source_trust_score": 0.93,
                        "first_seen": observed_at,
                        "last_seen": observed_at,
                        "start_time": observed_at,
                        "measurement_value": fatalities,
                        "measurement_unit": "fatalities",
                        "observation_type": "incident_report",
                        "raw_payload": row,
                        "event_metadata": {
                            "country": country,
                            "location": location,
                            "sub_event_type": row.get("sub_event_type"),
                            "event_type": row.get("event_type"),
                            "actor1": row.get("actor1"),
                            "actor2": row.get("actor2"),
                            "provider": "ACLED",
                        },
                    },
                },
            ))
        return events

    def _split_csv(self, value: str) -> list[str]:
        return [part.strip() for part in value.split(",") if part.strip()]

    def _coerce_float(self, value: Any) -> float | None:
        if value in (None, "", "N/A"):
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _coerce_dt(self, value: Any) -> datetime | None:
        if value is None:
            return None
        if isinstance(value, str):
            text = value.strip().replace("Z", "+00:00")
            try:
                dt = datetime.fromisoformat(text)
                if dt.tzinfo is None:
                    return dt.replace(tzinfo=timezone.utc)
                return dt
            except ValueError:
                for fmt in ("%Y-%m-%d", "%d %B %Y"):
                    try:
                        return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
                    except ValueError:
                        continue
        return None


if __name__ == "__main__":
    collector = ACLEDCollector()
    asyncio.run(collector.run())

"""
Infrastructure disruption collector.

Implemented sources:
- IODA internet outage alerts
- PowerOutage.us regional utility outage summaries
- Cloudflare Radar outage annotations
- EIA balancing authority demand / forecast stress
"""

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector, TrackEventDict

IODA_API = "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts"
POWEROUTAGE_API = "https://api.poweroutage.us/api/v1/states"
CLOUDFLARE_RADAR_API = "https://api.cloudflare.com/client/v4/radar/annotations/outages"
logger = logging.getLogger(__name__)

US_STATE_CENTROIDS: dict[str, tuple[float, float]] = {
    "AL": (32.806671, -86.79113), "AK": (61.370716, -152.404419), "AZ": (33.729759, -111.431221),
    "AR": (34.969704, -92.373123), "CA": (36.116203, -119.681564), "CO": (39.059811, -105.311104),
    "CT": (41.597782, -72.755371), "DE": (39.318523, -75.507141), "FL": (27.766279, -81.686783),
    "GA": (33.040619, -83.643074), "HI": (21.094318, -157.498337), "ID": (44.240459, -114.478828),
    "IL": (40.349457, -88.986137), "IN": (39.849426, -86.258278), "IA": (42.011539, -93.210526),
    "KS": (38.5266, -96.726486), "KY": (37.66814, -84.670067), "LA": (31.169546, -91.867805),
    "ME": (44.693947, -69.381927), "MD": (39.063946, -76.802101), "MA": (42.230171, -71.530106),
    "MI": (43.326618, -84.536095), "MN": (45.694454, -93.900192), "MS": (32.741646, -89.678696),
    "MO": (38.456085, -92.288368), "MT": (46.921925, -110.454353), "NE": (41.12537, -98.268082),
    "NV": (38.313515, -117.055374), "NH": (43.452492, -71.563896), "NJ": (40.298904, -74.521011),
    "NM": (34.840515, -106.248482), "NY": (42.165726, -74.948051), "NC": (35.630066, -79.806419),
    "ND": (47.528912, -99.784012), "OH": (40.388783, -82.764915), "OK": (35.565342, -96.928917),
    "OR": (44.572021, -122.070938), "PA": (40.590752, -77.209755), "RI": (41.680893, -71.51178),
    "SC": (33.856892, -80.945007), "SD": (44.299782, -99.438828), "TN": (35.747845, -86.692345),
    "TX": (31.054487, -97.563461), "UT": (40.150032, -111.862434), "VT": (44.045876, -72.710686),
    "VA": (37.769337, -78.169968), "WA": (47.400902, -121.490494), "WV": (38.491226, -80.954453),
    "WI": (44.268543, -89.616508), "WY": (42.755966, -107.30249), "DC": (38.9072, -77.0369),
}


class InfraCollector(BaseCollector):
    DOMAIN = "Infra"
    FEED_NAME = "IODA+PowerOutage+Cloudflare+EIA"

    def __init__(self):
        super().__init__(
            db_url=os.environ["DATABASE_URL"],
            redis_url=os.environ["REDIS_URL"],
            poll_interval=float(os.environ.get("POLL_INTERVAL_SEC", 300)),
        )
        self._timeout_sec = float(os.environ.get("INFRA_TIMEOUT_SEC", "30"))
        self._ioda_enabled = os.environ.get("IODA_ENABLED", "true").lower() != "false"
        self._ioda_api_url = os.environ.get("IODA_API_URL", IODA_API).strip() or IODA_API
        self._powerout_enabled = os.environ.get("POWEROUTAGE_ENABLED", "true").lower() != "false"
        self._powerout_api_key = os.environ.get("POWEROUTAGE_API_KEY", "").strip()
        self._ioda_lookback_minutes = int(os.environ.get("IODA_LOOKBACK_MINUTES", "30"))
        self._powerout_threshold_pct = float(os.environ.get("POWEROUTAGE_MIN_PERCENT", "1.0"))
        self._cloudflare_enabled = os.environ.get("CLOUDFLARE_RADAR_ENABLED", "false").lower() == "true"
        self._cloudflare_token = os.environ.get("CLOUDFLARE_RADAR_API_TOKEN", "").strip()
        self._cloudflare_date_range = os.environ.get("CLOUDFLARE_RADAR_DATE_RANGE", "1d")
        self._cloudflare_limit = int(os.environ.get("CLOUDFLARE_RADAR_LIMIT", "100"))
        self._eia_enabled = os.environ.get("EIA_ENABLED", "false").lower() == "true"
        self._eia_api_key = os.environ.get("EIA_API_KEY", "").strip()
        self._eia_url = os.environ.get(
            "EIA_RTO_URL",
            "https://api.eia.gov/v2/electricity/rto/region-data/data/",
        ).strip()
        self._eia_limit = int(os.environ.get("EIA_LIMIT", "500"))
        self._eia_stress_delta_pct = float(os.environ.get("EIA_STRESS_DELTA_PCT", "10"))
        self._startup_logged = False

    async def fetch(self) -> list[dict]:
        if not self._startup_logged:
            logger.info(
                "[Infra] Config ioda=%s poweroutage=%s cloudflare=%s eia=%s",
                self._ioda_enabled,
                self._powerout_enabled,
                self._cloudflare_enabled and bool(self._cloudflare_token),
                self._eia_enabled and bool(self._eia_api_key),
            )
            self._startup_logged = True
        async with httpx.AsyncClient(timeout=self._timeout_sec, follow_redirects=True) as client:
            tasks: list[tuple[str, asyncio.Future | Any]] = []
            if self._ioda_enabled:
                tasks.append(("IODA", self._fetch_ioda(client)))
            if self._powerout_enabled:
                tasks.append(("PowerOutage.us", self._fetch_poweroutage(client)))
            if self._cloudflare_enabled and self._cloudflare_token:
                tasks.append(("Cloudflare Radar", self._fetch_cloudflare_radar(client)))
            if self._eia_enabled and self._eia_api_key:
                tasks.append(("EIA", self._fetch_eia_grid(client)))
            if not tasks:
                logger.warning("[Infra] No source tasks enabled. Check IODA/CLOUDFLARE/EIA/POWEROUTAGE env vars")
                return []
            results = await asyncio.gather(*(task for _, task in tasks), return_exceptions=True)

        events: list[dict] = []
        for (source_name, _), result in zip(tasks, results, strict=False):
            if isinstance(result, Exception):
                logger.error(
                    "[Infra] %s fetch failed: %r",
                    source_name,
                    result,
                    exc_info=(type(result), result, result.__traceback__),
                )
                continue
            events.extend(result)
        logger.info("[Infra] Produced %s events across enabled sources", len(events))
        return events

    async def _fetch_ioda(self, client: httpx.AsyncClient) -> list[dict]:
        now = datetime.now(timezone.utc)
        start = now - timedelta(minutes=self._ioda_lookback_minutes)
        response = await client.get(
            self._ioda_api_url,
            params={"from": int(start.timestamp()), "until": int(now.timestamp())},
            headers={"User-Agent": "Sentinel/0.1"},
        )
        response.raise_for_status()
        payload = response.json()
        alerts = payload if isinstance(payload, list) else payload.get("alerts", [])

        events: list[dict] = []
        for alert in alerts:
            if not isinstance(alert, dict):
                continue
            entity = alert.get("entity") or {}
            entity_code = str(entity.get("code") or entity.get("name") or "unknown")
            entity_type = str(entity.get("type") or "entity")
            entity_name = str(entity.get("name") or entity_code)
            observed_at = self._coerce_dt(alert.get("time")) or now
            score = self._coerce_float(alert.get("score")) or self._coerce_float(alert.get("level")) or 0.0
            severity = max(0.0, min(score, 100.0))

            events.append(TrackEventDict.create(
                source_domain=self.DOMAIN,
                source_feed="IODA",
                track_id=f"{entity_type}:{entity_code}",
                callsign=entity_name,
                timestamp=observed_at,
                classification="Disruption",
                metadata={
                    "entity_type": entity_type,
                    "entity_code": entity_code,
                    "entity_name": entity_name,
                    "ioda_score": severity,
                    "ioda_level": alert.get("level"),
                    "ioda_alert": alert,
                    "_disruption": {
                        "external_event_id": f"ioda:{entity_type}:{entity_code}",
                        "event_type": "internet_outage",
                        "category": "connectivity",
                        "title": f"IODA outage alert for {entity_name}",
                        "status": "active",
                        "severity": severity,
                        "confidence": round(min(0.98, 0.45 + severity / 200.0), 3),
                        "source_trust_score": 0.84,
                        "first_seen": observed_at,
                        "last_seen": observed_at,
                        "start_time": observed_at,
                        "measurement_value": severity,
                        "measurement_unit": "score",
                        "observation_type": "alert",
                        "raw_payload": alert,
                        "event_metadata": {
                            "entity_type": entity_type,
                            "entity_code": entity_code,
                            "provider": "IODA",
                        },
                    },
                },
            ))
        return events

    async def _fetch_poweroutage(self, client: httpx.AsyncClient) -> list[dict]:
        headers = {"User-Agent": "Sentinel/0.1"}
        if self._powerout_api_key:
            headers["Authorization"] = f"Bearer {self._powerout_api_key}"

        response = await client.get(POWEROUTAGE_API, headers=headers)
        response.raise_for_status()
        payload = response.json()
        rows = payload if isinstance(payload, list) else payload.get("states", [])
        observed_at = datetime.now(timezone.utc)
        events: list[dict] = []

        for row in rows:
            if not isinstance(row, dict):
                continue
            state = str(row.get("state") or row.get("state_abbr") or row.get("code") or "").upper()
            if not state or state not in US_STATE_CENTROIDS:
                continue
            percent_out = self._coerce_float(
                row.get("percent_out") or row.get("percentOut") or row.get("customers_out_percent")
            )
            if percent_out is None or percent_out < self._powerout_threshold_pct:
                continue
            customers_out = self._coerce_float(row.get("customers_out") or row.get("customersOut"))
            tracked = self._coerce_float(row.get("customers_tracked") or row.get("customersTracked"))
            lat, lon = US_STATE_CENTROIDS[state]

            events.append(TrackEventDict.create(
                source_domain=self.DOMAIN,
                source_feed="PowerOutage.us",
                track_id=state,
                callsign=f"{state} Power Outage",
                lon=lon,
                lat=lat,
                timestamp=observed_at,
                classification="Disruption",
                metadata={
                    "state": state,
                    "customers_out": customers_out,
                    "customers_tracked": tracked,
                    "percent_out": percent_out,
                    "poweroutage_row": row,
                    "_disruption": {
                        "external_event_id": f"poweroutage:{state}",
                        "event_type": "power_outage",
                        "category": "power",
                        "title": f"Power outage in {state}",
                        "status": "active",
                        "severity": round(percent_out, 2),
                        "confidence": round(min(0.95, 0.40 + percent_out / 100.0), 3),
                        "source_trust_score": 0.68,
                        "first_seen": observed_at,
                        "last_seen": observed_at,
                        "start_time": observed_at,
                        "measurement_value": round(percent_out, 2),
                        "measurement_unit": "percent",
                        "observation_type": "state_summary",
                        "raw_payload": row,
                        "event_metadata": {
                            "state": state,
                            "provider": "PowerOutage.us",
                        },
                    },
                },
            ))
        return events

    async def _fetch_cloudflare_radar(self, client: httpx.AsyncClient) -> list[dict]:
        response = await client.get(
            CLOUDFLARE_RADAR_API,
            params={
                "dateRange": self._cloudflare_date_range,
                "limit": self._cloudflare_limit,
            },
            headers={
                "User-Agent": "Sentinel/0.1",
                "Authorization": f"Bearer {self._cloudflare_token}",
            },
        )
        response.raise_for_status()
        payload = response.json()
        result = payload.get("result", {}) if isinstance(payload, dict) else {}
        annotations = result.get("annotations") or result.get("events") or []
        observed_at = datetime.now(timezone.utc)
        events: list[dict] = []

        for annotation in annotations:
            if not isinstance(annotation, dict):
                continue
            annotation_id = str(annotation.get("id") or annotation.get("uuid") or "")
            if not annotation_id:
                continue
            started_at = self._coerce_dt(annotation.get("startTime") or annotation.get("started_at")) or observed_at
            ended_at = self._coerce_dt(annotation.get("endTime") or annotation.get("ended_at"))
            location = annotation.get("location") or {}
            if not isinstance(location, dict):
                location = {}
            location_code = str(
                location.get("alpha2")
                or location.get("code")
                or annotation.get("locationAlpha2")
                or annotation.get("country")
                or "unknown"
            )
            location_name = str(
                location.get("name")
                or annotation.get("locationName")
                or annotation.get("title")
                or location_code
            )
            severity = self._coerce_float(
                annotation.get("severity")
                or annotation.get("impact")
                or annotation.get("score")
            ) or 50.0
            status = "resolved" if ended_at else "active"

            events.append(TrackEventDict.create(
                source_domain=self.DOMAIN,
                source_feed="Cloudflare Radar",
                track_id=f"radar:{location_code}",
                callsign=f"Cloudflare outage {location_name}",
                timestamp=started_at,
                classification="Disruption",
                metadata={
                    "location_code": location_code,
                    "location_name": location_name,
                    "cloudflare_annotation": annotation,
                    "_disruption": {
                        "external_event_id": f"cloudflare:{annotation_id}",
                        "event_type": "internet_outage",
                        "category": "connectivity",
                        "title": f"Cloudflare outage event for {location_name}",
                        "status": status,
                        "severity": severity,
                        "confidence": 0.82,
                        "source_trust_score": 0.76,
                        "first_seen": started_at,
                        "last_seen": observed_at,
                        "start_time": started_at,
                        "end_time": ended_at,
                        "measurement_value": severity,
                        "measurement_unit": "score",
                        "observation_type": "annotation",
                        "raw_payload": annotation,
                        "event_metadata": {
                            "location_code": location_code,
                            "location_name": location_name,
                            "provider": "Cloudflare Radar",
                        },
                    },
                },
            ))
        return events

    async def _fetch_eia_grid(self, client: httpx.AsyncClient) -> list[dict]:
        params: list[tuple[str, str]] = [
            ("api_key", self._eia_api_key),
            ("frequency", "hourly"),
            ("data[0]", "value"),
            ("facets[type][]", "D"),
            ("facets[type][]", "DF"),
            ("sort[0][column]", "period"),
            ("sort[0][direction]", "desc"),
            ("length", str(self._eia_limit)),
        ]
        response = await client.get(
            self._eia_url,
            params=params,
            headers={"User-Agent": "Sentinel/0.1"},
        )
        response.raise_for_status()
        payload = response.json()
        rows = []
        if isinstance(payload, dict):
            rows = payload.get("response", {}).get("data", []) or payload.get("data", [])

        grouped: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            respondent = str(row.get("respondent") or row.get("respondent-name") or row.get("region") or "")
            period = str(row.get("period") or row.get("timestamp") or "")
            type_code = str(row.get("type") or row.get("type-name") or "")
            if not respondent or not period or not type_code:
                continue
            grouped.setdefault((respondent, period), {"row": row})[type_code] = row

        events: list[dict] = []
        for (respondent, period), bundle in grouped.items():
            demand_row = bundle.get("D")
            forecast_row = bundle.get("DF")
            if not isinstance(demand_row, dict) or not isinstance(forecast_row, dict):
                continue
            demand = self._coerce_float(demand_row.get("value"))
            forecast = self._coerce_float(forecast_row.get("value"))
            if demand is None or forecast is None or forecast <= 0:
                continue
            delta_pct = abs(demand - forecast) / forecast * 100.0
            if delta_pct < self._eia_stress_delta_pct:
                continue

            observed_at = self._coerce_dt(period) or datetime.now(timezone.utc)
            name = str(demand_row.get("respondent-name") or respondent)

            events.append(TrackEventDict.create(
                source_domain=self.DOMAIN,
                source_feed="EIA",
                track_id=f"eia:{respondent}",
                callsign=f"{name} Grid Stress",
                timestamp=observed_at,
                classification="Telemetry",
                metadata={
                    "respondent": respondent,
                    "respondent_name": name,
                    "demand_mw": demand,
                    "forecast_mw": forecast,
                    "delta_pct": round(delta_pct, 2),
                    "demand_row": demand_row,
                    "forecast_row": forecast_row,
                    "_disruption": {
                        "external_event_id": f"eia:{respondent}:{period}",
                        "event_type": "power_grid_stress",
                        "category": "power",
                        "title": f"{name} grid stress",
                        "status": "active",
                        "severity": round(min(100.0, delta_pct), 2),
                        "confidence": 0.79,
                        "source_trust_score": 0.88,
                        "first_seen": observed_at,
                        "last_seen": observed_at,
                        "start_time": observed_at,
                        "measurement_value": round(delta_pct, 2),
                        "measurement_unit": "percent_delta",
                        "observation_type": "telemetry",
                        "raw_payload": {
                            "demand": demand_row,
                            "forecast": forecast_row,
                        },
                        "event_metadata": {
                            "respondent": respondent,
                            "respondent_name": name,
                            "provider": "EIA",
                        },
                    },
                },
            ))
        return events

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
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        if isinstance(value, str):
            text = value.strip().replace("Z", "+00:00")
            try:
                return datetime.fromisoformat(text)
            except ValueError:
                try:
                    return datetime.fromtimestamp(float(value), tz=timezone.utc)
                except ValueError:
                    return None
        return None


if __name__ == "__main__":
    collector = InfraCollector()
    asyncio.run(collector.run())

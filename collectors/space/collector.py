"""
Space / Satellite Collector — Space-Track GP+SATCAT + skyfield SGP4

Architecture:
  CelesTrak and Space-Track both publish Two-Line Element (TLE) sets for
  tracked objects.  A TLE encodes Keplerian orbital elements at a reference
  epoch.  The SGP4 model propagates them forward — it's the satellite
  equivalent of "given initial position + velocity, integrate the equations
  of motion accounting for drag and Earth's oblateness."

  Think of a TLE as a recipe: you don't store the cake; you store the
  instructions and bake on demand.

Data sources (in priority order):
  1. Space-Track.org GP+SATCAT — operated by USSPACECOM, the authoritative
     primary source.  Provides ~5,000 active payloads with full SATCAT
     metadata (country, launch date, RCS size, orbit class).
     Requires free registration at https://www.space-track.org/
     Set SPACETRACK_USER and SPACETRACK_PASS in .env to enable.

  2. CelesTrak (fallback) — no auth required, ~100 brightest/notable objects.
     Used automatically when Space-Track credentials are absent or API fails.

Key design decision — TLE line storage:
  skyfield's EarthSatellite stores *parsed* orbital parameters in its .model
  (sgp4 Satrec), but NOT the original text lines.  To let the API endpoint
  later re-propagate the orbit, we fetch the raw TLE text ourselves, parse
  out (line1, line2) per NORAD ID, and store them explicitly in TrackEvent
  metadata AND in the satellite_tles history table.

This collector:
  1. Authenticates with Space-Track (or falls back to CelesTrak)
  2. Fetches GP (TLE) data for active payloads; also fetches SATCAT metadata
  3. Parses TLE text → dict keyed by NORAD ID
  4. Upserts satellite_catalog rows with SATCAT enrichment
  5. Inserts new TLE snapshots into satellite_tles (for historical replay)
  6. Builds skyfield EarthSatellite objects
  7. Every POSITION_INTERVAL_SEC: propagates current ground-track positions
  8. Writes TrackEvents + upserts asset_states (both with TLE lines in metadata)
  9. Refreshes TLE data every TLE_REFRESH_INTERVAL_SEC (default 2 hrs)
"""

import asyncio
import json
import logging
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector, TrackEventDict

logger = logging.getLogger(__name__)

# ── CelesTrak fallback URLs (unauthenticated, public) ─────────────
CELESTRAK_TLE_URLS = [
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle",  # ISS, Tiangong, CSS
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle",    # Top ~100 brightest
]

# ── Space-Track API ────────────────────────────────────────────────
SPACETRACK_BASE    = "https://www.space-track.org"
SPACETRACK_LOGIN   = f"{SPACETRACK_BASE}/ajaxauth/login"
# GP class: active payloads with TLE lines — JSON format
# DECAY filter: NULL means still in orbit; OBJECT_TYPE: PAYLOAD only
SPACETRACK_GP_URL  = (
    f"{SPACETRACK_BASE}/basicspacedata/query/class/gp"
    "/DECAY_DATE/null-val"      # still in orbit for GP class
    "/OBJECT_TYPE/PAYLOAD"      # payloads only (no debris, rocket bodies)
    "/orderby/NORAD_CAT_ID asc"
    "/format/tle"               # returns raw 3-line TLE text
    "/emptyresult/show"
)
# SATCAT class: catalog metadata for all objects
SPACETRACK_SATCAT_URL = (
    f"{SPACETRACK_BASE}/basicspacedata/query/class/satcat"
    "/DECAY/null-val"
    "/OBJECT_TYPE/PAYLOAD"
    "/orderby/NORAD_CAT_ID asc"
    "/format/json"
    "/emptyresult/show"
)

# ── N2YO API (optional supplemental source) ───────────────────────
# Good fit for small curated lists and observer-centric features (passes,
# radio footprints, etc.), but not as the primary full-catalog source due to
# transaction limits on tle/positions endpoints.
N2YO_BASE = "https://api.n2yo.com/rest/v1/satellite"
SATNOGS_BASE = "https://db.satnogs.org/api"

# High-value NORAD IDs → (display name, operator, classification)
KNOWN_SATS: dict[int, tuple[str, str, str]] = {
    25544: ("ISS",          "NASA/Roscosmos", "Government"),
    48274: ("Tiangong",     "CNSA",           "Government"),
    54216: ("CSS (WENTIAN)","CNSA",           "Government"),
    40115: ("WorldView-3",  "Maxar",          "Commercial"),
    49260: ("WV Legion 1",  "Maxar",          "Commercial"),
    53867: ("Capella-8",    "Capella Space",  "Commercial"),
    57266: ("GaoFen-3 03",  "CASC",           "Government"),
}

# Map SATCAT country codes → classification hint
_GOV_COUNTRY_CODES = {
    "US", "PRC", "CIS", "ESA", "IND", "JPN", "ISR", "SPN",
    "FRAN", "UK", "AUS", "CAN", "KOR", "NATO", "AB", "EUTE",
}

POSITION_INTERVAL_SEC   = 30
TLE_REFRESH_INTERVAL_SEC = 7_200
_SOURCE_PRIORITY = {
    "spacetrack": 0,
    "satnogs": 1,
    "n2yo": 2,
    "celestrak": 3,
}


def _parse_norad_list(raw: str) -> list[int]:
    """Parse a comma-separated NORAD ID list, ignoring invalid tokens."""
    norad_ids: list[int] = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            norad_ids.append(int(token))
        except ValueError:
            logger.warning(f"[SpaceCollector] Ignoring invalid NORAD id: {token}")
    return norad_ids


def _parse_string_list(raw: str) -> list[str]:
    """Parse a comma-separated string list, preserving order and uniqueness."""
    values: list[str] = []
    seen: set[str] = set()
    for token in raw.split(","):
        value = token.strip()
        if not value or value in seen:
            continue
        seen.add(value)
        values.append(value)
    return values


def _sorted_sources(values: set[str]) -> list[str]:
    return sorted(values, key=lambda value: (_SOURCE_PRIORITY.get(value, 99), value))


def _load_watchlist_config(path: str) -> tuple[dict, list[dict]]:
    """
    Load a small curated watchlist from JSON.
    The file is intentionally simple to keep it editable without adding a YAML dependency.
    """
    try:
        payload = json.loads(Path(path).read_text())
    except FileNotFoundError:
        logger.warning(f"[SpaceCollector] Watchlist file not found: {path}")
        return {}, []
    except Exception as exc:
        logger.warning(f"[SpaceCollector] Watchlist load failed from {path}: {exc}")
        return {}, []

    defaults = payload.get("defaults") or {}
    entries = []
    for raw in payload.get("entries") or []:
        if not raw.get("id") or not raw.get("label"):
            continue
        entries.append({
            "id": str(raw["id"]),
            "label": str(raw["label"]),
            "priority": str(raw.get("priority") or "medium").lower(),
            "enabled": bool(raw.get("enabled", True)),
            "norad_id": raw.get("norad_id"),
            "satnogs_sat_id": raw.get("satnogs_sat_id"),
            "sources": [str(source).lower() for source in raw.get("sources") or []],
            "notes": str(raw.get("notes") or "").strip() or None,
            "n2yo_refresh_hours": int(raw.get("n2yo_refresh_hours") or defaults.get("n2yo_refresh_hours") or 12),
            "satnogs_refresh_hours": int(raw.get("satnogs_refresh_hours") or defaults.get("satnogs_refresh_hours") or 24),
        })
    return defaults, entries

# Orbit class helper: derived from apogee/perigee
def _classify_orbit(apogee_km: Optional[float], perigee_km: Optional[float],
                    inclination_deg: Optional[float]) -> str:
    """
    Classify orbit based on altitude and inclination.
    LEO < 2000 km, MEO 2000-35000, GEO ~35786 km, HEO highly elliptical.
    SSO is a near-polar (inclination ~97-100°) sun-synchronous LEO used
    heavily by Earth observation satellites.
    """
    if apogee_km is None:
        return "LEO"
    if apogee_km > 35_000:
        if apogee_km > 30_000 and perigee_km and perigee_km > 30_000:
            return "GEO"
        return "HEO"
    if apogee_km > 2_000:
        return "MEO"
    # LEO — check for SSO (sun-synchronous: ~97-100° inclination)
    if inclination_deg and 96 <= inclination_deg <= 101:
        return "SSO"
    return "LEO"


def orbital_period_min(mean_motion_revs_per_day: float) -> float:
    """Orbital period from mean motion (rev/day → minutes). ISS ≈ 90 min."""
    return 1440.0 / mean_motion_revs_per_day if mean_motion_revs_per_day > 0 else 90.0


def parse_tle_text(text: str) -> dict[int, tuple[str, str, str]]:
    """
    Parse raw TLE catalog text into {norad_id: (name, line1, line2)}.

    CelesTrak and Space-Track both use the 3-line format:
        NAME            ← satellite name (optional in 2-line catalogs)
        1 NNNNNC ...   ← TLE line 1 (starts with '1 ')
        2 NNNNN ...    ← TLE line 2 (starts with '2 ')

    The NORAD catalog number occupies columns 3–7 (1-indexed) of both
    line 1 and line 2, i.e. chars [2:7] in Python 0-indexed.
    """
    result: dict[int, tuple[str, str, str]] = {}
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    i = 0
    while i < len(lines):
        current_line = lines[i]
        if current_line.startswith("1 ") and len(current_line) >= 69:
            line1 = current_line
            if i + 1 < len(lines) and lines[i + 1].startswith("2 "):
                line2 = lines[i + 1]
                name = ""
                if i > 0 and not lines[i - 1].startswith(("1 ", "2 ")):
                    name = lines[i - 1].strip()
                try:
                    norad_id = int(line1[2:7])
                    result[norad_id] = (name, line1, line2)
                except ValueError:
                    pass
                i += 2
                continue
        i += 1
    return result


def _parse_tle_epoch(line1: str) -> Optional[datetime]:
    """
    Parse the epoch from TLE line 1 (columns 19-32, chars [18:32]).
    Format: YYDDD.DDDDDDDD  (2-digit year, day of year, fractional day)
    Returns UTC datetime or None on parse failure.
    """
    try:
        raw = line1[18:32].strip()
        yy = int(raw[:2])
        # Y2K handling: 57-99 → 1957-1999, 00-56 → 2000-2056
        year = (2000 + yy) if yy < 57 else (1900 + yy)
        day_frac = float(raw[2:])
        day_of_year = int(day_frac)
        frac = day_frac - day_of_year
        base = datetime(year, 1, 1, tzinfo=timezone.utc)
        from datetime import timedelta
        epoch_dt = base + timedelta(days=day_of_year - 1) + timedelta(days=frac)
        return epoch_dt
    except Exception:
        return None


class SpaceCollector(BaseCollector):
    DOMAIN = "Space"
    FEED_NAME = "SpaceTrack/Skyfield"

    def __init__(self):
        super().__init__(
            db_url=os.environ["DATABASE_URL"],
            redis_url=os.environ["REDIS_URL"],
            poll_interval=float(os.environ.get("POSITION_INTERVAL_SEC", POSITION_INTERVAL_SEC)),
        )
        self._tle_refresh_interval = float(
            os.environ.get("TLE_REFRESH_INTERVAL_SEC", TLE_REFRESH_INTERVAL_SEC)
        )
        self._spacetrack_user = os.environ.get("SPACETRACK_USER", "").strip()
        self._spacetrack_pass = os.environ.get("SPACETRACK_PASS", "").strip()
        self._use_spacetrack  = bool(self._spacetrack_user and self._spacetrack_pass)
        self._n2yo_api_key = os.environ.get("N2YO_API_KEY", "").strip()
        raw_n2yo_ids = os.environ.get("N2YO_NORAD_IDS", "").strip()
        self._n2yo_norad_ids = (
            _parse_norad_list(raw_n2yo_ids) if raw_n2yo_ids else list(KNOWN_SATS.keys())
        )
        raw_satnogs_norad_ids = os.environ.get("SATNOGS_NORAD_IDS", "").strip()
        raw_satnogs_sat_ids = os.environ.get("SATNOGS_SAT_IDS", "").strip()
        self._satnogs_norad_ids = _parse_norad_list(raw_satnogs_norad_ids) if raw_satnogs_norad_ids else []
        self._satnogs_sat_ids = _parse_string_list(raw_satnogs_sat_ids) if raw_satnogs_sat_ids else []
        self._use_satnogs = bool(self._satnogs_norad_ids or self._satnogs_sat_ids)
        self._watchlist_path = os.environ.get("SPACE_WATCHLIST_PATH", "/app/watchlist.json")
        _, self._watchlist_entries = _load_watchlist_config(self._watchlist_path)
        self._watchlist_runtime: dict[str, dict[str, dict[str, object]]] = {}
        for entry in self._watchlist_entries:
            self._watchlist_runtime[entry["id"]] = {
                "n2yo": {"last_attempt": None, "last_success": None, "last_error": None},
                "satnogs": {"last_attempt": None, "last_success": None, "last_error": None},
            }

        # {norad_id: (name, line1, line2)} — populated by _refresh_tles()
        self._tle_catalog: dict[int, tuple[str, str, str]] = {}
        # {norad_id: satcat_row_dict} — populated from Space-Track SATCAT
        self._satcat: dict[int, dict] = {}
        # skyfield satellite objects
        self._satellites: list = []
        self._ts = None
        self._last_tle_refresh: float = 0.0

        if self._use_spacetrack:
            self.FEED_NAME = "SpaceTrack/Skyfield"
            logger.info("[SpaceCollector] Space-Track credentials present — will use authoritative catalog")
        else:
            self.FEED_NAME = "CelesTrak/Skyfield"
            logger.info("[SpaceCollector] No Space-Track credentials — falling back to CelesTrak")

        if self._n2yo_api_key:
            logger.info(
                f"[SpaceCollector] N2YO API key present — will supplement up to "
                f"{len(self._n2yo_norad_ids)} curated NORAD ids when needed"
            )
        if self._use_satnogs:
            logger.info(
                f"[SpaceCollector] SatNOGS configured — will query "
                f"{len(self._satnogs_norad_ids)} NORAD ids and {len(self._satnogs_sat_ids)} SatNOGS ids"
            )
        if self._watchlist_entries:
            logger.info(
                f"[SpaceCollector] Watchlist loaded: {len(self._watchlist_entries)} curated entries from "
                f"{self._watchlist_path}"
            )

    # ── Lifecycle ──────────────────────────────────────────────────
    async def startup(self):
        await super().startup()
        try:
            from skyfield.api import load as skyfield_load
            # IMPORTANT: builtin=True uses Skyfield's bundled timescale data rather
            # than downloading from maia.usno.navy.mil.  Without this flag, timescale()
            # makes a blocking HTTPS request that can silently hang in containers —
            # leaving self._ts = None and causing _compute_positions() to return []
            # on every tick (the symptom: 0 space tracks on the map forever).
            self._ts = skyfield_load.timescale(builtin=True)
            logger.info("[SpaceCollector] skyfield timescale ready (builtin data, no network required)")
        except Exception as exc:
            logger.error(f"[SpaceCollector] skyfield timescale init failed: {exc}")
            raise

    # ── Space-Track authentication ────────────────────────────────
    async def _spacetrack_session(self, client: httpx.AsyncClient) -> bool:
        """
        Log in to Space-Track.org and return True on success.
        Space-Track uses cookie-based session auth — the login POST sets
        a session cookie that subsequent requests must carry.
        Think of it as a revolving door: you must badge in before accessing
        the reading room (the data queries).
        """
        try:
            resp = await client.post(
                SPACETRACK_LOGIN,
                data={"identity": self._spacetrack_user, "password": self._spacetrack_pass},
                timeout=30.0,
            )
            resp.raise_for_status()
            if "Failed" in resp.text or "Invalid" in resp.text:
                logger.error("[SpaceCollector] Space-Track login rejected — check credentials")
                return False
            logger.info("[SpaceCollector] Space-Track login successful")
            return True
        except Exception as exc:
            logger.warning(f"[SpaceCollector] Space-Track login failed: {exc}")
            return False

    # ── Fetch TLEs from Space-Track ───────────────────────────────
    async def _fetch_spacetrack_tles(self, client: httpx.AsyncClient) -> dict[int, tuple[str, str, str]]:
        """
        Fetch active payload TLEs from Space-Track GP class.
        Returns {norad_id: (name, line1, line2)} or empty dict on failure.
        """
        try:
            resp = await client.get(SPACETRACK_GP_URL, timeout=120.0)
            resp.raise_for_status()
            catalog = parse_tle_text(resp.text)
            logger.info(f"[SpaceCollector] Space-Track GP: {len(catalog)} active payloads")
            return catalog
        except Exception as exc:
            logger.warning(f"[SpaceCollector] Space-Track TLE fetch failed: {exc}")
            return {}

    # ── Fetch SATCAT metadata from Space-Track ────────────────────
    async def _fetch_spacetrack_satcat(self, client: httpx.AsyncClient) -> dict[int, dict]:
        """
        Fetch satellite catalog (SATCAT) metadata from Space-Track.
        Returns {norad_id: row_dict} with fields like COUNTRY, LAUNCH,
        PERIOD, INCLINATION, APOGEE, PERIGEE, RCS_SIZE, OBJECT_TYPE.

        SATCAT is the "baseball card" source — GP gives positions,
        SATCAT gives biography.
        """
        try:
            resp = await client.get(SPACETRACK_SATCAT_URL, timeout=120.0)
            resp.raise_for_status()
            rows = resp.json()
            satcat = {}
            for row in rows:
                try:
                    norad_id = int(row["NORAD_CAT_ID"])
                    satcat[norad_id] = row
                except (KeyError, ValueError):
                    pass
            logger.info(f"[SpaceCollector] Space-Track SATCAT: {len(satcat)} payload records")
            return satcat
        except Exception as exc:
            logger.warning(f"[SpaceCollector] Space-Track SATCAT fetch failed: {exc}")
            return {}

    # ── Fetch TLEs from N2YO (supplemental, curated only) ─────────
    async def _fetch_n2yo_tles(
        self,
        client: httpx.AsyncClient,
        existing_catalog: dict[int, tuple[str, str, str]],
    ) -> dict[int, tuple[str, str, str]]:
        """
        Fetch TLEs from N2YO for a small configured list of NORAD IDs.
        This is intentionally scoped: N2YO's TLE endpoint is useful for
        curated satellites, but not for replacing the full Space-Track feed.
        """
        if not self._n2yo_api_key or not self._n2yo_norad_ids:
            return {}

        fetched: dict[int, tuple[str, str, str]] = {}
        for norad_id in self._n2yo_norad_ids:
            if norad_id in existing_catalog or norad_id in fetched:
                continue
            url = f"{N2YO_BASE}/tle/{norad_id}&apiKey={self._n2yo_api_key}"
            try:
                resp = await client.get(url, timeout=30.0)
                resp.raise_for_status()
                payload = resp.json()
                tle_text = str(payload.get("tle", "")).strip()
                sat_info = payload.get("info") or {}
                sat_name = str(sat_info.get("satname", "")).strip()
                parsed = parse_tle_text(f"{sat_name}\n{tle_text}" if sat_name else tle_text)
                entry = parsed.get(norad_id)
                if entry:
                    fetched[norad_id] = entry
                else:
                    logger.warning(f"[SpaceCollector] N2YO returned unparsable TLE for NORAD {norad_id}")
            except Exception as exc:
                logger.warning(f"[SpaceCollector] N2YO TLE fetch failed for NORAD {norad_id}: {exc}")

        if fetched:
            logger.info(f"[SpaceCollector] N2YO: {len(fetched)} curated satellites fetched")
        return fetched

    async def _fetch_n2yo_single(
        self,
        client: httpx.AsyncClient,
        norad_id: int,
    ) -> tuple[Optional[tuple[str, str, str]], Optional[str]]:
        url = f"{N2YO_BASE}/tle/{norad_id}&apiKey={self._n2yo_api_key}"
        try:
            resp = await client.get(url, timeout=30.0)
            resp.raise_for_status()
            payload = resp.json()
            tle_text = str(payload.get("tle", "")).strip()
            sat_info = payload.get("info") or {}
            sat_name = str(sat_info.get("satname", "")).strip()
            parsed = parse_tle_text(f"{sat_name}\n{tle_text}" if sat_name else tle_text)
            entry = parsed.get(norad_id)
            if entry:
                return entry, None
            return None, "unparsable TLE"
        except Exception as exc:
            return None, str(exc)

    # ── SatNOGS DB (supplemental metadata + latest TLE) ──────────
    async def _satnogs_get_first(
        self,
        client: httpx.AsyncClient,
        path: str,
        params: dict[str, str],
    ) -> Optional[dict]:
        try:
            resp = await client.get(path, params=params, timeout=30.0)
            resp.raise_for_status()
            payload = resp.json()
            if isinstance(payload, list):
                return payload[0] if payload else None
            if isinstance(payload, dict) and isinstance(payload.get("results"), list):
                results = payload["results"]
                return results[0] if results else None
        except Exception as exc:
            logger.warning(f"[SpaceCollector] SatNOGS request failed for {path}: {exc}")
        return None

    async def _fetch_satnogs_records(
        self,
        client: httpx.AsyncClient,
    ) -> tuple[dict[int, tuple[str, str, str]], dict[int, dict], dict[int, set[str]]]:
        """
        Fetch SatNOGS satellite metadata and latest TLEs for configured NORAD
        ids and/or SatNOGS sat_ids. Only records with parseable TLE object
        numbers can be merged into the current integer-keyed catalog.
        """
        tle_catalog: dict[int, tuple[str, str, str]] = {}
        satnogs_meta: dict[int, dict] = {}
        source_sets: dict[int, set[str]] = {}

        if not self._use_satnogs:
            return tle_catalog, satnogs_meta, source_sets

        async def _ingest_record(sat_row: Optional[dict], tle_row: Optional[dict], lookup_label: str) -> None:
            if not sat_row and not tle_row:
                return

            sat_name = ""
            if sat_row:
                sat_name = str(sat_row.get("name") or "").strip()

            tle0 = str((tle_row or {}).get("tle0") or "").strip()
            tle1 = str((tle_row or {}).get("tle1") or "").strip()
            tle2 = str((tle_row or {}).get("tle2") or "").strip()

            parsed_norad: Optional[int] = None
            if tle1.startswith("1 ") and len(tle1) >= 7:
                try:
                    parsed_norad = int(tle1[2:7])
                except ValueError:
                    parsed_norad = None

            record_norad = (tle_row or {}).get("norad_cat_id")
            if parsed_norad is None:
                try:
                    parsed_norad = int(record_norad) if record_norad not in (None, "") else None
                except (TypeError, ValueError):
                    parsed_norad = None

            if parsed_norad is None:
                logger.warning(
                    f"[SpaceCollector] SatNOGS record {lookup_label} has no parseable catalog id; skipping"
                )
                return

            if sat_row:
                satnogs_meta[parsed_norad] = sat_row
                source_sets.setdefault(parsed_norad, set()).add("satnogs")

            if tle1 and tle2:
                if tle0.startswith("0 "):
                    tle_name = tle0[2:].strip()
                else:
                    tle_name = sat_name or tle0
                tle_catalog[parsed_norad] = (tle_name, tle1, tle2)
                source_sets.setdefault(parsed_norad, set()).add("satnogs")

        for norad_id in self._satnogs_norad_ids:
            sat_row = await self._satnogs_get_first(client, "/satellites/", {"norad_cat_id": str(norad_id)})
            tle_row = await self._satnogs_get_first(client, "/tle/", {"norad_cat_id": str(norad_id)})
            await _ingest_record(sat_row, tle_row, f"norad:{norad_id}")

        for sat_id in self._satnogs_sat_ids:
            sat_row = await self._satnogs_get_first(client, "/satellites/", {"sat_id": sat_id})
            tle_row = await self._satnogs_get_first(client, "/tle/", {"sat_id": sat_id})
            await _ingest_record(sat_row, tle_row, f"sat_id:{sat_id}")

        if tle_catalog or satnogs_meta:
            logger.info(
                f"[SpaceCollector] SatNOGS: {len(satnogs_meta)} metadata rows, "
                f"{len(tle_catalog)} latest TLEs"
            )
        return tle_catalog, satnogs_meta, source_sets

    async def _fetch_satnogs_single(
        self,
        client: httpx.AsyncClient,
        norad_id: Optional[int],
        sat_id: Optional[str],
    ) -> tuple[Optional[dict], Optional[tuple[str, str, str]], Optional[int], Optional[str]]:
        sat_params = None
        tle_params = None
        if sat_id:
            sat_params = {"sat_id": sat_id}
            tle_params = {"sat_id": sat_id}
        elif norad_id is not None:
            sat_params = {"norad_cat_id": str(norad_id)}
            tle_params = {"norad_cat_id": str(norad_id)}
        else:
            return None, None, None, "no satnogs identifier configured"

        sat_row = await self._satnogs_get_first(client, "/satellites/", sat_params)
        tle_row = await self._satnogs_get_first(client, "/tle/", tle_params)

        tle_entry = None
        resolved_norad = norad_id
        if tle_row:
            tle0 = str(tle_row.get("tle0") or "").strip()
            tle1 = str(tle_row.get("tle1") or "").strip()
            tle2 = str(tle_row.get("tle2") or "").strip()
            if tle1.startswith("1 ") and tle2.startswith("2 "):
                try:
                    resolved_norad = int(tle1[2:7])
                    tle_name = tle0[2:].strip() if tle0.startswith("0 ") else str((sat_row or {}).get("name") or "").strip()
                    tle_entry = (tle_name, tle1, tle2)
                except ValueError:
                    return sat_row, None, norad_id, "unparsable satnogs TLE object number"

        if sat_row is None and tle_row is None:
            return None, None, resolved_norad, "no satnogs record found"

        return sat_row, tle_entry, resolved_norad, None

    def _watchlist_source_due(self, state: dict[str, object], refresh_hours: int, now_ts: float) -> bool:
        last_success = state.get("last_success")
        if not isinstance(last_success, datetime):
            return True
        return (now_ts - last_success.timestamp()) >= (refresh_hours * 3600)

    async def _refresh_watchlist_sources(
        self,
        tle_catalog: dict[int, tuple[str, str, str]],
        satnogs_meta: dict[int, dict],
        source_map: dict[int, set[str]],
    ) -> None:
        if not self._watchlist_entries:
            return

        now = datetime.now(timezone.utc)
        now_ts = now.timestamp()
        n2yo_client = None
        satnogs_client = None
        try:
            if self._n2yo_api_key:
                n2yo_client = httpx.AsyncClient(timeout=30.0)
            if self._use_satnogs:
                satnogs_client = httpx.AsyncClient(base_url=SATNOGS_BASE, timeout=30.0, follow_redirects=True)

            for entry in self._watchlist_entries:
                if not entry["enabled"]:
                    continue
                runtime = self._watchlist_runtime.setdefault(entry["id"], {
                    "n2yo": {"last_attempt": None, "last_success": None, "last_error": None},
                    "satnogs": {"last_attempt": None, "last_success": None, "last_error": None},
                })
                norad_id = entry.get("norad_id")

                if "n2yo" in entry["sources"] and self._n2yo_api_key and n2yo_client and isinstance(norad_id, int):
                    state = runtime["n2yo"]
                    if self._watchlist_source_due(state, entry["n2yo_refresh_hours"], now_ts):
                        state["last_attempt"] = now
                        tle_entry, error = await self._fetch_n2yo_single(n2yo_client, norad_id)
                        if tle_entry:
                            if norad_id not in tle_catalog:
                                tle_catalog[norad_id] = tle_entry
                            source_map.setdefault(norad_id, set()).add("n2yo")
                            state["last_success"] = now
                            state["last_error"] = None
                        else:
                            state["last_error"] = error

                if "satnogs" in entry["sources"] and satnogs_client and (entry.get("satnogs_sat_id") or isinstance(norad_id, int)):
                    state = runtime["satnogs"]
                    if self._watchlist_source_due(state, entry["satnogs_refresh_hours"], now_ts):
                        state["last_attempt"] = now
                        sat_row, tle_entry, resolved_norad, error = await self._fetch_satnogs_single(
                            satnogs_client,
                            norad_id if isinstance(norad_id, int) else None,
                            entry.get("satnogs_sat_id"),
                        )
                        if resolved_norad is not None and sat_row:
                            satnogs_meta[resolved_norad] = sat_row
                            source_map.setdefault(resolved_norad, set()).add("satnogs")
                        if resolved_norad is not None and tle_entry:
                            if resolved_norad not in tle_catalog:
                                tle_catalog[resolved_norad] = tle_entry
                            source_map.setdefault(resolved_norad, set()).add("satnogs")
                        if sat_row or tle_entry:
                            state["last_success"] = now
                            state["last_error"] = None
                        else:
                            state["last_error"] = error
        finally:
            if n2yo_client:
                await n2yo_client.aclose()
            if satnogs_client:
                await satnogs_client.aclose()

    # ── Upsert satellite catalog to DB ────────────────────────────
    async def _upsert_satellite_catalog(
        self,
        tle_catalog: dict[int, tuple[str, str, str]],
        satcat: dict[int, dict],
        source_map: dict[int, set[str]],
        satnogs_meta: dict[int, dict],
    ) -> None:
        """
        Write/update satellite_catalog and satellite_tles tables using asyncpg.

        satellite_catalog is an ON CONFLICT DO UPDATE upsert — safe to
        run every 2 hours.  Only the `last_updated` column changes for
        rows where the data hasn't changed.

        satellite_tles stores one row per (norad_id, epoch). The ON
        CONFLICT DO NOTHING means we only ever INSERT new epochs, never
        overwrite historical snapshots — giving us an immutable TLE
        history for retroactive orbital replay.
        """
        import datetime as dt_module

        now = datetime.now(timezone.utc)
        catalog_rows = []
        tle_rows = []

        for norad_id, (name, line1, line2) in tle_catalog.items():
            sc = satcat.get(norad_id, {})
            sg = satnogs_meta.get(norad_id, {})
            sources = _sorted_sources(source_map.get(norad_id, {"spacetrack" if sc else "celestrak"}))
            tle_source = sources[0] if sources else ("spacetrack" if sc else "celestrak")

            def _f(key: str) -> Optional[float]:
                v = sc.get(key)
                try:
                    return float(v) if v not in (None, "", "N/A") else None
                except (TypeError, ValueError):
                    return None

            apogee_km      = _f("APOGEE")
            perigee_km     = _f("PERIGEE")
            period_min_val = _f("PERIOD")
            incl_deg       = _f("INCLINATION")

            orbit_class = _classify_orbit(apogee_km, perigee_km, incl_deg)

            # Parse "YYYY-MM-DD" strings to date objects for asyncpg
            def _date(key: str) -> Optional[dt_module.date]:
                v = sc.get(key)
                if not v:
                    return None
                try:
                    return dt_module.date.fromisoformat(str(v)[:10])
                except ValueError:
                    return None

            sg_launch = None
            if sg.get("launched"):
                try:
                    sg_launch = dt_module.date.fromisoformat(str(sg["launched"])[:10])
                except ValueError:
                    sg_launch = None

            country_code = sc.get("COUNTRY") or None
            if not country_code and sg.get("countries"):
                country_code = str(sg["countries"]).split(",")[0].strip() or None

            operator = sg.get("operator")
            if operator in (None, "", "None"):
                operator = None

            metadata = {
                "source_priority": sources,
            }
            if sg:
                metadata["satnogs"] = {
                    "sat_id": sg.get("sat_id"),
                    "norad_follow_id": sg.get("norad_follow_id"),
                    "names": sg.get("names"),
                    "status": sg.get("status"),
                    "website": sg.get("website"),
                    "countries": sg.get("countries"),
                    "updated": sg.get("updated"),
                    "citation": sg.get("citation"),
                    "telemetries": sg.get("telemetries") or [],
                }

            catalog_rows.append((
                norad_id,
                name or sg.get("name") or sc.get("SATNAME", str(norad_id)),
                sc.get("INTLDES") or None,
                sc.get("OBJECT_TYPE") or "PAYLOAD",
                country_code,
                _date("LAUNCH") or sg_launch,
                _date("DECAY"),
                period_min_val,
                incl_deg,
                apogee_km,
                perigee_km,
                sc.get("RCS_SIZE") or None,
                orbit_class,
                sc.get("SITE") or None,
                operator,
                None,
                None,
                sources,
                now,
                metadata,
            ))

            epoch_dt = _parse_tle_epoch(line1)
            if epoch_dt:
                tle_rows.append((
                    norad_id,
                    epoch_dt,
                    line1,
                    line2,
                    tle_source,
                ))

        if not catalog_rows:
            return

        async with self._db.acquire() as conn:
            # Upsert satellite_catalog
            await conn.executemany("""
                INSERT INTO satellite_catalog (
                    norad_id, object_name, intl_designator, object_type,
                    country_code, launch_date, decay_date,
                    period_min, inclination_deg, apogee_km, perigee_km,
                    rcs_size, orbit_class, launch_site, operator, purpose, contractor,
                    sources, last_updated, metadata
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
                ON CONFLICT (norad_id) DO UPDATE SET
                    object_name     = EXCLUDED.object_name,
                    intl_designator = EXCLUDED.intl_designator,
                    object_type     = EXCLUDED.object_type,
                    country_code    = EXCLUDED.country_code,
                    launch_date     = EXCLUDED.launch_date,
                    decay_date      = EXCLUDED.decay_date,
                    period_min      = EXCLUDED.period_min,
                    inclination_deg = EXCLUDED.inclination_deg,
                    apogee_km       = EXCLUDED.apogee_km,
                    perigee_km      = EXCLUDED.perigee_km,
                    rcs_size        = EXCLUDED.rcs_size,
                    orbit_class     = EXCLUDED.orbit_class,
                    launch_site     = EXCLUDED.launch_site,
                    operator        = COALESCE(EXCLUDED.operator, satellite_catalog.operator),
                    purpose         = COALESCE(EXCLUDED.purpose, satellite_catalog.purpose),
                    contractor      = COALESCE(EXCLUDED.contractor, satellite_catalog.contractor),
                    sources         = EXCLUDED.sources,
                    last_updated    = EXCLUDED.last_updated,
                    metadata        = EXCLUDED.metadata
            """, catalog_rows)

            # Insert new TLE epochs (immutable — never overwrite historical data)
            if tle_rows:
                await conn.executemany("""
                    INSERT INTO satellite_tles (norad_id, epoch, tle_line1, tle_line2, source)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (norad_id, epoch) DO NOTHING
                """, tle_rows)

        logger.info(
            f"[SpaceCollector] Catalog upserted: {len(catalog_rows)} satellites, "
            f"{len(tle_rows)} new TLE snapshots"
        )

    async def _upsert_watchlist_status(
        self,
        tle_catalog: dict[int, tuple[str, str, str]],
        satnogs_meta: dict[int, dict],
        source_map: dict[int, set[str]],
    ) -> None:
        if not self._watchlist_entries:
            return

        track_ids = [str(entry["norad_id"]) for entry in self._watchlist_entries if isinstance(entry.get("norad_id"), int)]
        last_seen_by_track: dict[str, datetime] = {}
        if track_ids:
            async with self._db.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT track_id, last_seen
                    FROM asset_states
                    WHERE source_domain = 'Space'
                      AND track_id = ANY($1::text[])
                    """,
                    track_ids,
                )
                last_seen_by_track = {str(row["track_id"]): row["last_seen"] for row in rows}

        now = datetime.now(timezone.utc)
        status_rows = []
        for entry in self._watchlist_entries:
            watch_id = entry["id"]
            runtime = self._watchlist_runtime.get(watch_id, {})
            norad_id = entry.get("norad_id")
            tle_name = None
            tle_epoch = None
            tle_age_minutes = None
            current_tle_source = None
            in_catalog = isinstance(norad_id, int) and norad_id in tle_catalog
            sources = []
            if isinstance(norad_id, int) and norad_id in source_map:
                sources = _sorted_sources(source_map[norad_id])
                current_tle_source = sources[0] if sources else None
            if isinstance(norad_id, int) and norad_id in tle_catalog:
                tle_name, line1, _ = tle_catalog[norad_id]
                tle_epoch = _parse_tle_epoch(line1)
                if tle_epoch:
                    tle_age_minutes = round((now - tle_epoch).total_seconds() / 60.0, 1)

            last_track_seen = last_seen_by_track.get(str(norad_id)) if isinstance(norad_id, int) else None
            active_track = bool(last_track_seen and (now - last_track_seen).total_seconds() <= max(300.0, self.poll_interval * 4))

            enabled_sources = [source for source in entry["sources"] if source in ("n2yo", "satnogs")]
            source_status = {}
            source_health = []
            for source in enabled_sources:
                state = runtime.get(source, {})
                refresh_hours = entry["n2yo_refresh_hours"] if source == "n2yo" else entry["satnogs_refresh_hours"]
                last_attempt = state.get("last_attempt")
                last_success = state.get("last_success")
                last_error = state.get("last_error")
                due = self._watchlist_source_due(state, refresh_hours, now.timestamp())
                source_status[source] = {
                    "enabled": True,
                    "due": due,
                    "refresh_hours": refresh_hours,
                    "last_attempt": last_attempt.isoformat() if isinstance(last_attempt, datetime) else None,
                    "last_success": last_success.isoformat() if isinstance(last_success, datetime) else None,
                    "last_error": last_error,
                }
                if last_error:
                    source_health.append("error")
                elif last_success:
                    source_health.append("ok")
                else:
                    source_health.append("idle")

            if not in_catalog:
                health_status = "missing"
            elif source_health and "error" in source_health and not active_track:
                health_status = "degraded"
            elif tle_age_minutes is not None and tle_age_minutes > 7 * 24 * 60:
                health_status = "stale"
            elif active_track:
                health_status = "healthy"
            else:
                health_status = "tracking"

            metadata = {
                "watch_sources": enabled_sources,
                "current_source_priority": sources,
            }
            if isinstance(norad_id, int) and norad_id in satnogs_meta:
                metadata["satnogs"] = {
                    "sat_id": satnogs_meta[norad_id].get("sat_id"),
                    "status": satnogs_meta[norad_id].get("status"),
                    "website": satnogs_meta[norad_id].get("website"),
                    "names": satnogs_meta[norad_id].get("names"),
                }

            status_rows.append((
                watch_id,
                entry["label"],
                entry["priority"],
                entry["enabled"],
                norad_id,
                entry.get("satnogs_sat_id"),
                enabled_sources,
                entry.get("notes"),
                tle_name or entry["label"],
                in_catalog,
                active_track,
                current_tle_source,
                tle_epoch,
                tle_age_minutes,
                last_track_seen,
                health_status,
                json.dumps(source_status),
                json.dumps(metadata),
                now,
            ))

        if not status_rows:
            return

        async with self._db.acquire() as conn:
            await conn.executemany(
                """
                INSERT INTO space_watchlist_status (
                    watch_id, label, priority, enabled, norad_id, satnogs_sat_id,
                    desired_sources, notes, current_name, in_catalog, active_track,
                    current_tle_source, tle_epoch, tle_age_minutes, last_track_seen,
                    health_status, source_status, metadata, updated_at
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19
                )
                ON CONFLICT (watch_id) DO UPDATE SET
                    label              = EXCLUDED.label,
                    priority           = EXCLUDED.priority,
                    enabled            = EXCLUDED.enabled,
                    norad_id           = EXCLUDED.norad_id,
                    satnogs_sat_id     = EXCLUDED.satnogs_sat_id,
                    desired_sources    = EXCLUDED.desired_sources,
                    notes              = EXCLUDED.notes,
                    current_name       = EXCLUDED.current_name,
                    in_catalog         = EXCLUDED.in_catalog,
                    active_track       = EXCLUDED.active_track,
                    current_tle_source = EXCLUDED.current_tle_source,
                    tle_epoch          = EXCLUDED.tle_epoch,
                    tle_age_minutes    = EXCLUDED.tle_age_minutes,
                    last_track_seen    = EXCLUDED.last_track_seen,
                    health_status      = EXCLUDED.health_status,
                    source_status      = EXCLUDED.source_status,
                    metadata           = EXCLUDED.metadata,
                    updated_at         = EXCLUDED.updated_at
                """,
                status_rows,
            )

    # ── TLE refresh ────────────────────────────────────────────────
    async def _refresh_tles(self) -> None:
        """
        Main TLE refresh cycle:
          1. Try Space-Track (auth → GP TLEs → SATCAT metadata)
          2. Fall back to CelesTrak if Space-Track fails or no credentials
          3. Upsert satellite_catalog + satellite_tles
          4. Build skyfield EarthSatellite objects
        """
        from skyfield.api import EarthSatellite

        new_catalog: dict[int, tuple[str, str, str]] = {}
        new_satcat: dict[int, dict] = {}
        satnogs_meta: dict[int, dict] = {}
        source_map: dict[int, set[str]] = {}

        if self._use_spacetrack:
            # Space-Track session uses cookie auth — share a single client
            # across the login + data requests so cookies are preserved.
            async with httpx.AsyncClient(
                base_url=SPACETRACK_BASE,
                timeout=120.0,
                follow_redirects=True,
            ) as client:
                logged_in = await self._spacetrack_session(client)
                if logged_in:
                    new_catalog = await self._fetch_spacetrack_tles(client)
                    new_satcat  = await self._fetch_spacetrack_satcat(client)
                    for norad_id in new_catalog:
                        source_map.setdefault(norad_id, set()).add("spacetrack")

        # Fallback: use CelesTrak if Space-Track didn't deliver
        if not new_catalog:
            if self._use_spacetrack:
                logger.warning("[SpaceCollector] Space-Track yielded no data — falling back to CelesTrak")
            async with httpx.AsyncClient(timeout=30.0) as client:
                for url in CELESTRAK_TLE_URLS:
                    try:
                        resp = await client.get(url)
                        resp.raise_for_status()
                        parsed = parse_tle_text(resp.text)
                        for norad_id, entry in parsed.items():
                            if norad_id not in new_catalog:
                                new_catalog[norad_id] = entry
                            source_map.setdefault(norad_id, set()).add("celestrak")
                        logger.info(f"[SpaceCollector] CelesTrak: {len(parsed)} sats from {url}")
                    except Exception as exc:
                        logger.warning(f"[SpaceCollector] CelesTrak fetch failed {url}: {exc}")

        if self._n2yo_api_key:
            async with httpx.AsyncClient(timeout=30.0) as client:
                n2yo_catalog = await self._fetch_n2yo_tles(client, new_catalog)
            for norad_id, entry in n2yo_catalog.items():
                if norad_id not in new_catalog:
                    new_catalog[norad_id] = entry
                source_map.setdefault(norad_id, set()).add("n2yo")

        if self._use_satnogs:
            async with httpx.AsyncClient(base_url=SATNOGS_BASE, timeout=30.0, follow_redirects=True) as client:
                satnogs_catalog, satnogs_meta, satnogs_sources = await self._fetch_satnogs_records(client)
            for norad_id, entry in satnogs_catalog.items():
                if norad_id not in new_catalog:
                    new_catalog[norad_id] = entry
                source_map.setdefault(norad_id, set()).update(satnogs_sources.get(norad_id, {"satnogs"}))
            for norad_id, sources in satnogs_sources.items():
                source_map.setdefault(norad_id, set()).update(sources)

        await self._refresh_watchlist_sources(new_catalog, satnogs_meta, source_map)

        if not new_catalog:
            logger.error("[SpaceCollector] No TLEs loaded — check connectivity")
            return

        # Persist catalog + TLE history to DB
        try:
            await self._upsert_satellite_catalog(new_catalog, new_satcat, source_map, satnogs_meta)
        except Exception as exc:
            logger.warning(f"[SpaceCollector] Catalog upsert error (non-fatal): {exc}")

        try:
            await self._upsert_watchlist_status(new_catalog, satnogs_meta, source_map)
        except Exception as exc:
            logger.warning(f"[SpaceCollector] Watchlist status upsert error (non-fatal): {exc}")

        # Guard: timescale must be initialized before building satellite objects.
        # If startup() failed to set self._ts, we cannot propagate orbits.
        if self._ts is None:
            logger.error(
                "[SpaceCollector] self._ts is None — skyfield timescale was not initialized. "
                "Check startup() logs for errors."
            )
            return

        # Build skyfield satellite objects in thread executor (CPU-bound)
        ts = self._ts
        def _build_sats():
            sats = []
            bad = 0
            for norad_id, (name, line1, line2) in new_catalog.items():
                try:
                    sat = EarthSatellite(line1, line2, name, ts)
                    sats.append((norad_id, sat))
                except Exception as exc:
                    bad += 1
                    logger.debug(f"[SpaceCollector] Bad TLE for NORAD {norad_id}: {exc}")
            if bad:
                logger.warning(f"[SpaceCollector] {bad} TLEs rejected (malformed)")
            return sats

        loop = asyncio.get_event_loop()
        sat_pairs = await loop.run_in_executor(None, _build_sats)

        self._tle_catalog = new_catalog
        self._satcat = new_satcat
        self._satellites = [sat for _, sat in sat_pairs]
        self._last_tle_refresh = time.monotonic()
        logger.info(
            f"[SpaceCollector] TLE refresh complete: "
            f"{len(self._satellites)} satellites ready"
        )

    # ── Position computation ──────────────────────────────────────
    def _compute_positions(self) -> list[dict]:
        """
        Compute current ground-track position for every satellite.

        SGP4 propagation is O(1) per satellite: evaluate the orbital
        model at ts.now(), then convert geocentric XYZ to geodetic
        lat/lon/altitude via wgs84.subpoint_of().
        """
        from skyfield.api import wgs84

        ts = self._ts
        if ts is None or not self._satellites:
            return []

        t = ts.now()
        now_dt = datetime.now(timezone.utc)
        events = []

        for sat in self._satellites:
            try:
                norad_id: int = sat.model.satnum
                geocentric = sat.at(t)
                subpoint = wgs84.subpoint_of(geocentric)

                lat = subpoint.latitude.degrees
                lon = subpoint.longitude.degrees
                alt_km = subpoint.elevation.km

                if alt_km < 0:
                    continue  # deorbited / bad TLE

                # Approximate heading from velocity projected to local surface
                heading_deg: Optional[float] = None
                try:
                    vel = geocentric.velocity.km_per_s
                    vx, vy, vz = float(vel[0]), float(vel[1]), float(vel[2])
                    lat_r = math.radians(lat)
                    lon_r = math.radians(lon)
                    north_x = -math.sin(lat_r) * math.cos(lon_r)
                    north_y = -math.sin(lat_r) * math.sin(lon_r)
                    north_z =  math.cos(lat_r)
                    east_x  = -math.sin(lon_r)
                    east_y  =  math.cos(lon_r)
                    east_z  =  0.0
                    v_north = vx*north_x + vy*north_y + vz*north_z
                    v_east  = vx*east_x  + vy*east_y  + vz*east_z
                    heading_deg = math.degrees(math.atan2(v_east, v_north)) % 360
                except Exception:
                    pass

                # Orbital parameters from SGP4 model
                # no_kozai is in rad/min → convert to rev/day for period calc
                revs_per_day = sat.model.no_kozai * (1440.0 / (2 * math.pi))
                period_min = orbital_period_min(revs_per_day)
                incl_deg = math.degrees(sat.model.inclo)

                # Classification: KNOWN_SATS first, then SATCAT country hint, then inclination heuristic
                sc = self._satcat.get(norad_id, {})
                if norad_id in KNOWN_SATS:
                    display_name, _, classification = KNOWN_SATS[norad_id]
                else:
                    display_name = sat.name.strip() if sat.name else str(norad_id)
                    country = sc.get("COUNTRY", "")
                    if country in _GOV_COUNTRY_CODES:
                        classification = "Government"
                    elif incl_deg > 85:
                        classification = "Government"  # high-inclination heuristic
                    else:
                        classification = "Commercial"
                callsign = display_name or str(norad_id)

                # TLE lines from catalog (NOT from sat.model — Satrec doesn't store them)
                tle_entry = self._tle_catalog.get(norad_id, ("", None, None))
                _, line1, line2 = tle_entry

                # Orbit class from SATCAT if available, else compute
                orbit_class = sc.get("ORBIT_CLASS") or _classify_orbit(
                    sc.get("APOGEE") and float(sc["APOGEE"]),
                    sc.get("PERIGEE") and float(sc["PERIGEE"]),
                    incl_deg,
                )

                event = TrackEventDict.create(
                    source_domain="Space",
                    source_feed=self.FEED_NAME,
                    track_id=str(norad_id),
                    timestamp=now_dt,
                    lon=lon,
                    lat=lat,
                    altitude_m=alt_km * 1000.0,
                    heading_deg=heading_deg,
                    speed_mps=None,
                    callsign=callsign,
                    classification=classification,
                    metadata={
                        "norad_id":           norad_id,
                        "tle_line1":          line1,
                        "tle_line2":          line2,
                        "orbital_period_min": round(period_min, 2),
                        "inclination_deg":    round(incl_deg, 3),
                        "altitude_km":        round(alt_km, 1),
                        "orbit_class":        orbit_class,
                        "country_code":       sc.get("COUNTRY") or None,
                        "intl_designator":    sc.get("INTLDES") or None,
                        "rcs_size":           sc.get("RCS_SIZE") or None,
                        "launch_date":        sc.get("LAUNCH") or None,
                    },
                )
                events.append(event)

            except Exception as exc:
                logger.debug(
                    f"[SpaceCollector] Skipping NORAD "
                    f"{getattr(sat.model, 'satnum', '?')}: {exc}"
                )

        return events

    # ── Main fetch ─────────────────────────────────────────────────
    async def fetch(self) -> list[dict]:
        elapsed = time.monotonic() - self._last_tle_refresh
        if elapsed >= self._tle_refresh_interval:
            await self._refresh_tles()

        if not self._satellites:
            logger.warning("[SpaceCollector] No satellites loaded; retrying TLE fetch next cycle")
            return []

        loop = asyncio.get_event_loop()
        events = await loop.run_in_executor(None, self._compute_positions)
        logger.debug(f"[SpaceCollector] {len(events)} satellite positions computed")
        return events


if __name__ == "__main__":
    collector = SpaceCollector()
    asyncio.run(collector.run())

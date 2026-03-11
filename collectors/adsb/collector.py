"""
ADS-B Collector — OpenSky Network + ADSBexchange (dual-source, deduplicated)

Two independent ADS-B aggregators serve complementary roles:

  OpenSky Network  — ~5,000 volunteer ground stations, dense in NA/Europe.
    Free with registration. Returns a global snapshot via REST every poll.
    Strength: squawk codes, origin country, broad coverage in populated areas.
    Weakness: sparse in Africa, Pacific, Middle East. No military flag.

  ADSBexchange  — independent aggregator; does NOT filter military traffic
    (unlike FlightAware/FR24 which suppress military by agreement). Has a
    dedicated `military` boolean field and `/v2/mil/` endpoint.
    Personal API plan: https://www.adsbexchange.com/data-samples/documentation/
    Strength: true military identification, registration, aircraft type code,
              better coverage in some regions via additional feeder network.
    Weakness: paid API; rate-limited.

Deduplication strategy
──────────────────────
Both sources identify aircraft by their ICAO 24-bit hex address — the same
identifier space, the same physical aircraft. If we naively wrote both
feeds to track_events, playback would show double the event density for
aircraft seen by both networks, and activity sparklines would be inflated.

The fix: treat the fetch-merge-write cycle as a single atomic unit.

  1. Fetch OpenSky and ADSBexchange concurrently (asyncio.gather).
  2. Build a dict keyed by ICAO hex from OpenSky results.
  3. For each ADSBexchange aircraft:
       - If already in dict (seen by OpenSky too): MERGE, letting ADSBx
         win on {military, registration, aircraft_type, category}.
         Set source_feed = "OpenSky+ADSBx".
       - If NOT in dict (ADSBx only): add as new. source_feed = "ADSBx".
  4. Remaining OpenSky-only entries keep source_feed = "OpenSky".
  5. Write exactly ONE track_event per ICAO hex per poll cycle.

This is analogous to a hash-join in a query plan — you build a hash table
on the smaller side (or either, since they're similar size), then probe it
with the other side, producing a single merged output stream.

ADSBexchange API
──────────────────────
Personal plan endpoint: https://adsbexchange.com/api/aircraft/v2/all/
Headers: { "api-auth": "<ADSBEXCHANGE_API_KEY>" }

Response format (v2):
  { "ac": [ { "hex": "...", "flight": "...", "lat": ..., "lon": ...,
              "alt_baro": ..., "alt_geom": ..., "gs": ..., "track": ...,
              "r": "registration", "t": "type_code",
              "category": "A3", "military": true/false, ... } ],
    "total": N, "now": epoch_ms }

Set ADSBEXCHANGE_BASE_URL if using a different endpoint (e.g. RapidAPI proxy):
  ADSBEXCHANGE_BASE_URL=https://adsbexchange-com1.p.rapidapi.com/v2/all/
  Then also set ADSBEXCHANGE_RAPID_KEY (used as X-RapidAPI-Key header).
"""

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector, TrackEventDict

logger = logging.getLogger(__name__)

# ── Military ICAO hex prefix ranges ──────────────────────────────
# These are national allocations to military operators.
# ADSBexchange's `military` field supersedes these when available;
# we keep them as a fallback for OpenSky-only events.
MILITARY_ICAO_PREFIXES = {
    "AE",   # US DoD / military
    "43",   # Russian military (approx range)
    "800",  # Indian Air Force
    "7C",   # Australian DoD (partial)
    "710",  # Chinese military (partial)
}

# Military mission callsign prefixes (US-centric, widely documented)
MILITARY_CALLSIGNS = {
    "RCH", "RFF", "REACH", "TOPAZ", "COBRA", "WOLF",
    "JAKE", "SWIFT", "ROCKY", "IRON",
}
GOVERNMENT_CALLSIGNS = {"SAM", "AF1", "AF2", "EXEC"}


def classify_aircraft(
    icao_hex: str,
    callsign: Optional[str],
    adsbx_military: Optional[bool] = None,
    category: Optional[str] = None,
) -> str:
    """
    Classify aircraft as Commercial / Military / Government / Unknown.

    Priority order:
      1. ADSBexchange explicit `military` boolean (most reliable)
      2. Category code B (lighter-than-air, gliders, etc.) → "Unknown"
      3. ICAO hex prefix table (national military allocations)
      4. Callsign pattern matching
      5. Default: "Commercial"
    """
    # ADSBexchange tells us directly — trust it
    if adsbx_military is True:
        return "Military"

    # ADS-B category codes (A=airplane tiers, B=lighter than air/special)
    if category and category.startswith("B"):
        return "Unknown"

    icao_upper = icao_hex.upper()
    if any(icao_upper.startswith(pfx) for pfx in MILITARY_ICAO_PREFIXES):
        return "Military"

    if callsign:
        cs = callsign.strip().upper()
        if any(cs.startswith(p) for p in MILITARY_CALLSIGNS):
            return "Military"
        if any(cs.startswith(p) for p in GOVERNMENT_CALLSIGNS):
            return "Government"

    return "Commercial"


# ─────────────────────────────────────────────────────────────────
# OpenSky helpers
# ─────────────────────────────────────────────────────────────────

def _parse_opensky_states(states: list, now: datetime) -> dict[str, dict]:
    """
    Parse OpenSky state vectors into a dict keyed by ICAO hex.

    Returns {icao24: partial_event_dict} — NOT yet TrackEventDicts;
    we merge with ADSBx data before finalising.
    """
    result = {}
    for s in states:
        # OpenSky state vector indices:
        # 0=icao24  1=callsign  2=origin_country  3=time_position
        # 4=last_contact  5=lon  6=lat  7=baro_altitude  8=on_ground
        # 9=velocity(m/s)  10=true_track  11=vertical_rate  12=sensors
        # 13=geo_altitude  14=squawk  15=spi  16=position_source
        icao24 = (s[0] or "").lower().strip()
        if not icao24:
            continue
        lon = s[5]
        lat = s[6]
        if lon is None or lat is None:
            continue

        result[icao24] = {
            "icao24":        icao24,
            "callsign":      (s[1] or "").strip() or None,
            "lon":           lon,
            "lat":           lat,
            "altitude_m":    s[7],          # baro altitude metres
            "heading_deg":   s[10],
            "speed_mps":     s[9],
            "on_ground":     s[8],
            "squawk":        s[14],
            "origin_country": s[2],
            "timestamp":     now,
            # ADSBx fields — filled in during merge if available
            "registration":  None,
            "aircraft_type": None,
            "category":      None,
            "adsbx_military": None,
            "source":        "OpenSky",
        }
    return result


# ─────────────────────────────────────────────────────────────────
# ADSBexchange helpers
# ─────────────────────────────────────────────────────────────────

def _parse_adsbx_aircraft(ac_list: list, now: datetime) -> dict[str, dict]:
    """
    Parse ADSBexchange v2 aircraft array into a dict keyed by ICAO hex.

    Speed note: ADSBexchange reports ground speed in knots; convert to m/s
    for consistency (1 knot = 0.514444 m/s). Altitude is feet; convert to
    metres (1 ft = 0.3048 m).
    """
    result = {}
    for ac in ac_list:
        icao24 = (ac.get("hex") or "").lower().strip()
        if not icao24:
            continue
        lat = ac.get("lat")
        lon = ac.get("lon")
        if lat is None or lon is None:
            continue

        # Altitude: prefer geometric, fall back to baro
        alt_ft = ac.get("alt_geom") or ac.get("alt_baro")
        alt_m = (float(alt_ft) * 0.3048) if alt_ft not in (None, "ground") else None

        speed_knots = ac.get("gs")
        speed_mps = (float(speed_knots) * 0.514444) if speed_knots is not None else None

        result[icao24] = {
            "icao24":         icao24,
            "callsign":       (ac.get("flight") or "").strip() or None,
            "lon":            float(lon),
            "lat":            float(lat),
            "altitude_m":     alt_m,
            "heading_deg":    ac.get("track"),
            "speed_mps":      speed_mps,
            "on_ground":      ac.get("alt_baro") == "ground",
            "squawk":         ac.get("squawk"),
            "origin_country": None,     # ADSBx doesn't return this
            "registration":   ac.get("r") or None,
            "aircraft_type":  ac.get("t") or None,
            "category":       ac.get("category") or None,
            "adsbx_military": ac.get("military", False),
            "timestamp":      now,
            "source":         "ADSBx",
        }
    return result


def _merge_sources(
    opensky: dict[str, dict],
    adsbx: dict[str, dict],
) -> list[dict]:
    """
    Merge two ICAO-keyed dicts into a single list with one entry per aircraft.

    Merge policy:
      - ADSBexchange WINS for: military flag, registration, aircraft_type,
        category, altitude (geometric is more accurate than baro), speed.
      - OpenSky WINS for: squawk, origin_country (ADSBx omits these).
      - Position: use ADSBx when both present (typically fresher / higher
        feeder count in its network).
      - source_feed label:
          both present  → "OpenSky+ADSBx"
          ADSBx only    → "ADSBx"
          OpenSky only  → "OpenSky"

    Returns a flat list of merged partial dicts ready for TrackEventDict.create().
    """
    merged: dict[str, dict] = {}

    # Start with all OpenSky entries
    for icao, row in opensky.items():
        merged[icao] = row.copy()

    # Merge/add ADSBexchange entries
    for icao, adsbx_row in adsbx.items():
        if icao in merged:
            base = merged[icao]
            # ADSBx enrichment fields win
            base["adsbx_military"] = adsbx_row["adsbx_military"]
            base["registration"]   = adsbx_row["registration"]   or base.get("registration")
            base["aircraft_type"]  = adsbx_row["aircraft_type"]  or base.get("aircraft_type")
            base["category"]       = adsbx_row["category"]       or base.get("category")
            # ADSBx position / kinematics are generally from more feeders
            base["lon"]         = adsbx_row["lon"]
            base["lat"]         = adsbx_row["lat"]
            base["altitude_m"]  = adsbx_row["altitude_m"]  if adsbx_row["altitude_m"] is not None else base["altitude_m"]
            base["heading_deg"] = adsbx_row["heading_deg"] if adsbx_row["heading_deg"] is not None else base["heading_deg"]
            base["speed_mps"]   = adsbx_row["speed_mps"]   if adsbx_row["speed_mps"]  is not None else base["speed_mps"]
            base["on_ground"]   = adsbx_row["on_ground"]
            # OpenSky-only fields kept from base (squawk, origin_country)
            base["source"] = "OpenSky+ADSBx"
        else:
            # ADSBx-only aircraft (not seen by OpenSky)
            merged[icao] = adsbx_row.copy()

    return list(merged.values())


# ─────────────────────────────────────────────────────────────────
# Collector
# ─────────────────────────────────────────────────────────────────

class AdsbCollector(BaseCollector):
    DOMAIN = "Air"
    FEED_NAME = "ADS-B"   # overridden per-run based on active sources

    OPENSKY_URL  = "https://opensky-network.org/api/states/all"
    OPENSKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
    ADSBX_URL    = "https://adsbexchange.com/api/aircraft/v2/all/"

    def __init__(self):
        super().__init__(
            db_url=os.environ["DATABASE_URL"],
            redis_url=os.environ["REDIS_URL"],
            poll_interval=float(os.environ.get("POLL_INTERVAL_SEC", 10)),
        )
        # OpenSky OAuth client credentials
        self._opensky_client_id = os.environ.get("OPENSKY_CLIENT_ID", "").strip()
        self._opensky_client_secret = os.environ.get("OPENSKY_CLIENT_SECRET", "").strip()
        self._opensky_token_url = os.environ.get("OPENSKY_TOKEN_URL", self.OPENSKY_TOKEN_URL).strip() or self.OPENSKY_TOKEN_URL
        self._opensky_enabled = True  # always attempt; gracefully degrades
        self._opensky_access_token: str | None = None
        self._opensky_access_token_expires_at: datetime | None = None

        # ADSBexchange credentials
        self._adsbx_key     = os.environ.get("ADSBEXCHANGE_API_KEY", "").strip()
        self._adsbx_url     = os.environ.get(
            "ADSBEXCHANGE_BASE_URL", self.ADSBX_URL
        ).rstrip("/") + "/"
        # Some deployments use a RapidAPI proxy with a different key header
        self._adsbx_rapid   = os.environ.get("ADSBEXCHANGE_RAPID_KEY", "").strip()
        self._adsbx_enabled = bool(self._adsbx_key or self._adsbx_rapid)
        self._opensky_auth_disabled_until: datetime | None = None
        self._opensky_rate_limited_until: datetime | None = None
        self._adsbx_disabled_until: datetime | None = None
        self._opensky_rate_limit_cooldown_sec = int(os.environ.get("OPENSKY_RATE_LIMIT_COOLDOWN_SEC", "300"))
        self._opensky_auth_failure_cooldown_sec = int(os.environ.get("OPENSKY_AUTH_FAILURE_COOLDOWN_SEC", "3600"))
        self._adsbx_error_cooldown_sec = int(os.environ.get("ADSBX_ERROR_COOLDOWN_SEC", "1800"))

        sources = []
        if self._opensky_enabled:
            sources.append("OpenSky")
        if self._adsbx_enabled:
            sources.append("ADSBx")
        self.FEED_NAME = "+".join(sources) if sources else "ADS-B"

        logger.info(
            "[AdsbCollector] Active sources: %s  |  OpenSky auth=%s  |  dedup: by ICAO hex",
            ", ".join(sources) if sources else "none",
            "oauth-client" if self._opensky_client_id and self._opensky_client_secret else "unauthenticated",
        )

    async def _get_opensky_access_token(self, client: httpx.AsyncClient) -> str | None:
        now = datetime.now(timezone.utc)
        if (
            self._opensky_access_token
            and self._opensky_access_token_expires_at
            and now < self._opensky_access_token_expires_at - timedelta(seconds=60)
        ):
            return self._opensky_access_token

        if not self._opensky_client_id or not self._opensky_client_secret:
            return None

        response = await client.post(
            self._opensky_token_url,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "client_credentials",
                "client_id": self._opensky_client_id,
                "client_secret": self._opensky_client_secret,
            },
            timeout=15.0,
        )
        response.raise_for_status()
        payload = response.json()
        access_token = str(payload.get("access_token") or "").strip()
        if not access_token:
            raise RuntimeError("OpenSky token response missing access_token")
        expires_in = int(payload.get("expires_in") or 300)
        self._opensky_access_token = access_token
        self._opensky_access_token_expires_at = now + timedelta(seconds=expires_in)
        return access_token

    # ── OpenSky fetch ─────────────────────────────────────────────
    async def _fetch_opensky(self, client: httpx.AsyncClient) -> dict[str, dict]:
        """
        Fetch all state vectors from OpenSky.
        Returns empty dict on any error (the other source can cover).
        """
        now = datetime.now(timezone.utc)
        if self._opensky_rate_limited_until and now < self._opensky_rate_limited_until:
            remaining = round((self._opensky_rate_limited_until - now).total_seconds())
            logger.info("[OpenSky] Cooling down after rate limit for %ss", remaining)
            return {}

        use_auth = self._opensky_auth_disabled_until is None or now >= self._opensky_auth_disabled_until
        headers: dict[str, str] = {}
        try:
            if use_auth:
                token = await self._get_opensky_access_token(client)
                if token:
                    headers["Authorization"] = f"Bearer {token}"

            resp = await client.get(self.OPENSKY_URL, headers=headers, timeout=15.0)
            if resp.status_code == 401 and headers.get("Authorization"):
                self._opensky_access_token = None
                self._opensky_access_token_expires_at = None
                self._opensky_auth_disabled_until = now + timedelta(seconds=self._opensky_auth_failure_cooldown_sec)
                logger.warning(
                    "[OpenSky] 401 with OAuth credentials — disabling authenticated requests for %ss and retrying unauthenticated",
                    self._opensky_auth_failure_cooldown_sec,
                )
                resp = await client.get(self.OPENSKY_URL, timeout=15.0)
            if resp.status_code == 429:
                retry_after = (
                    resp.headers.get("X-Rate-Limit-Retry-After-Seconds")
                    or resp.headers.get("Retry-After")
                )
                cooldown_sec = self._opensky_rate_limit_cooldown_sec
                if retry_after and retry_after.isdigit():
                    cooldown_sec = max(cooldown_sec, int(retry_after))
                self._opensky_rate_limited_until = now + timedelta(seconds=cooldown_sec)
                logger.warning(
                    "[OpenSky] Rate limited (429) — cooling down for %ss",
                    cooldown_sec,
                )
                return {}
            self._opensky_rate_limited_until = None
            resp.raise_for_status()
            data   = resp.json()
            states = data.get("states") or []
            now    = datetime.now(timezone.utc)
            parsed = _parse_opensky_states(states, now)
            logger.debug("[OpenSky] %d aircraft parsed", len(parsed))
            return parsed
        except httpx.HTTPStatusError as exc:
            logger.warning("[OpenSky] HTTP error %s — continuing without OpenSky data", exc.response.status_code)
            return {}
        except Exception as exc:
            logger.warning("[OpenSky] Fetch error: %s — continuing without OpenSky data", exc)
            return {}

    # ── ADSBexchange fetch ────────────────────────────────────────
    async def _fetch_adsbx(self, client: httpx.AsyncClient) -> dict[str, dict]:
        """
        Fetch all aircraft from ADSBexchange v2 API.
        Returns empty dict on any error (OpenSky covers as fallback).

        Auth headers:
          Direct API:  api-auth: <ADSBEXCHANGE_API_KEY>
          RapidAPI:    x-rapidapi-key: <ADSBEXCHANGE_RAPID_KEY>
                       x-rapidapi-host: adsbexchange-com1.p.rapidapi.com
        """
        now = datetime.now(timezone.utc)
        if self._adsbx_disabled_until and now < self._adsbx_disabled_until:
            remaining = round((self._adsbx_disabled_until - now).total_seconds())
            logger.info("[ADSBx] Cooling down after previous HTTP failure for %ss", remaining)
            return {}

        headers = {}
        if self._adsbx_rapid:
            # RapidAPI uses lowercase header names (case-insensitive per HTTP spec,
            # but match what RapidAPI's own sample code shows to be safe)
            headers["x-rapidapi-key"]  = self._adsbx_rapid
            headers["x-rapidapi-host"] = "adsbexchange-com1.p.rapidapi.com"
        elif self._adsbx_key:
            headers["api-auth"] = self._adsbx_key

        try:
            resp = await client.get(self._adsbx_url, headers=headers, timeout=20.0)
            if resp.status_code == 403:
                logger.warning("[ADSBx] 403 Forbidden — check ADSBEXCHANGE_API_KEY")
                self._adsbx_disabled_until = now + timedelta(seconds=self._adsbx_error_cooldown_sec)
                return {}
            if resp.status_code == 404:
                logger.warning(
                    "[ADSBx] 404 Not Found — disabling ADSBx polls for %ss; check ADSBX endpoint/key type",
                    self._adsbx_error_cooldown_sec,
                )
                self._adsbx_disabled_until = now + timedelta(seconds=self._adsbx_error_cooldown_sec)
                return {}
            if resp.status_code == 429:
                logger.warning("[ADSBx] Rate limited (429) — cooling down for %ss", self._adsbx_error_cooldown_sec)
                self._adsbx_disabled_until = now + timedelta(seconds=self._adsbx_error_cooldown_sec)
                return {}
            self._adsbx_disabled_until = None
            resp.raise_for_status()
            data = resp.json()
            ac_list = data.get("ac") or []
            now = datetime.now(timezone.utc)
            parsed = _parse_adsbx_aircraft(ac_list, now)
            logger.debug("[ADSBx] %d aircraft parsed", len(parsed))
            return parsed
        except httpx.HTTPStatusError as exc:
            logger.warning("[ADSBx] HTTP error %s — continuing without ADSBx data", exc.response.status_code)
            return {}
        except Exception as exc:
            logger.warning("[ADSBx] Fetch error: %s — continuing without ADSBx data", exc)
            return {}

    # ── Main fetch ────────────────────────────────────────────────
    async def fetch(self) -> list[dict]:
        """
        Concurrently fetch from all enabled sources, merge by ICAO hex,
        and return exactly one TrackEvent per physical aircraft.

        Concurrency: asyncio.gather() runs both HTTP requests in the same
        event loop — they overlap in wall time (both await I/O simultaneously)
        without needing threads. It's like two fishing lines in the water
        at once rather than one after the other.
        """
        async with httpx.AsyncClient() as client:
            tasks = []
            if self._opensky_enabled:
                tasks.append(self._fetch_opensky(client))
            if self._adsbx_enabled:
                tasks.append(self._fetch_adsbx(client))

            if not tasks:
                logger.error("[AdsbCollector] No ADS-B sources configured")
                return []

            results = await asyncio.gather(*tasks, return_exceptions=True)

        # Unpack results based on which tasks ran
        opensky_data: dict[str, dict] = {}
        adsbx_data:   dict[str, dict] = {}

        idx = 0
        if self._opensky_enabled:
            r = results[idx]
            idx += 1
            if isinstance(r, dict):
                opensky_data = r
        if self._adsbx_enabled:
            r = results[idx]
            idx += 1
            if isinstance(r, dict):
                adsbx_data = r

        # Merge by ICAO hex → one entry per aircraft
        merged_rows = _merge_sources(opensky_data, adsbx_data)

        # Count sources for logging
        only_os  = sum(1 for r in merged_rows if r["source"] == "OpenSky")
        only_ax  = sum(1 for r in merged_rows if r["source"] == "ADSBx")
        both     = sum(1 for r in merged_rows if r["source"] == "OpenSky+ADSBx")
        logger.info(
            "[AdsbCollector] %d aircraft total  "
            "(OpenSky-only: %d  ADSBx-only: %d  both: %d)",
            len(merged_rows), only_os, only_ax, both,
        )

        events = []
        for row in merged_rows:
            icao24  = row["icao24"]
            source  = row["source"]

            # Final classification — ADSBx military flag is most trustworthy
            classification = classify_aircraft(
                icao_hex=icao24,
                callsign=row.get("callsign"),
                adsbx_military=row.get("adsbx_military"),
                category=row.get("category"),
            )

            events.append(TrackEventDict.create(
                source_domain=self.DOMAIN,
                source_feed=source,           # "OpenSky" | "ADSBx" | "OpenSky+ADSBx"
                track_id=icao24,
                timestamp=row["timestamp"],
                lon=row["lon"],
                lat=row["lat"],
                callsign=row.get("callsign"),
                altitude_m=row.get("altitude_m"),
                heading_deg=row.get("heading_deg"),
                speed_mps=row.get("speed_mps"),
                classification=classification,
                metadata={
                    "on_ground":      row.get("on_ground"),
                    "squawk":         row.get("squawk"),
                    "origin_country": row.get("origin_country"),
                    "registration":   row.get("registration"),
                    "aircraft_type":  row.get("aircraft_type"),
                    "category":       row.get("category"),
                    "military_flag":  row.get("adsbx_military"),
                    "sources":        source,
                },
            ))

        return events


if __name__ == "__main__":
    collector = AdsbCollector()
    asyncio.run(collector.run())

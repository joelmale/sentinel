"""
ADS-B Collector — OpenSky Network + ADSBexchange + ADSBx binCraft (tri-source, deduplicated)

Three independent ADS-B data paths serve complementary roles:

  OpenSky Network  — ~5,000 volunteer ground stations, dense in NA/Europe.
    Free with registration. Returns a global snapshot via REST every poll.
    Strength: squawk codes, origin country, broad coverage in populated areas.
    Weakness: sparse in Africa, Pacific, Middle East. No military flag.

  ADSBexchange REST — independent aggregator; does NOT filter military traffic
    (unlike FlightAware/FR24 which suppress military by agreement). Has a
    dedicated `military` boolean field and `/v2/mil/` endpoint.
    Personal API plan: https://www.adsbexchange.com/data-samples/documentation/
    Strength: true military identification, registration, aircraft type code,
              better coverage in some regions via additional feeder network.
    Weakness: paid API; rate-limited.

  ADSBx binCraft  — binary globe endpoint from ADS-B Exchange.
    URL: https://globe.adsbexchange.com/re-api/?binCraft&zstd&box=S,N,W,E
    Requires session cookies (adsbx_sid + adsbx_identity_exp) and
    Referer: https://globe.adsbexchange.com/ header.
    Returns Zstandard-compressed fixed-stride binary payload decoded by
    bincraft_decoder.py.
    Strength: highest receiver consensus, RSSI, surveillance type,
              receiverCount per aircraft — best positional accuracy.
    Poll rate: irregular, 120–200 s (randomised) to avoid over-querying.

    Cookie management: the collector can refresh its own session cookies
    automatically (BINCRAFT_AUTO_REFRESH_COOKIES=true, default) by GETting
    the globe homepage every BINCRAFT_COOKIE_REFRESH_INTERVAL_SEC (default
    10800 = 3 h) and capturing the Set-Cookie response headers.  No seed
    value is required — if ADSBX_BINCRAFT_COOKIES is empty the first poll
    cycle will attempt a bootstrap GET to acquire them.

    Caveat: globe.adsbexchange.com sits behind Cloudflare.  A plain HTTP
    GET with browser-like headers works when Cloudflare is satisfied by
    the User-Agent / Accept headers alone (the common case for server IPs
    that have previously been seen as feeders).  If Cloudflare issues a
    JS challenge, the GET returns a 403 / empty-cookie response and the
    collector logs a warning; it then falls back to whatever cookies are
    already stored and retries the refresh on the next scheduled interval.
    In that case, supply ADSBX_BINCRAFT_COOKIES manually from a browser
    DevTools session as a one-time seed.

Deduplication strategy
──────────────────────
All three sources identify aircraft by ICAO 24-bit hex.

  1. Fetch OpenSky and ADSBexchange REST concurrently every poll cycle.
  2. Merge OpenSky + ADSBx REST by ICAO hex (as before).
  3. If binCraft is due this cycle, fetch it too (independent timer).
  4. Apply binCraft as a second-pass enrichment over the merged list:
       - Existing aircraft: binCraft wins on position, military flag,
         registration, type, and adds receiver_count/rssi/surveillance_type.
       - New aircraft (binCraft-only): appended to the list.
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
import random
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import zstandard as zstd

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector, TrackEventDict
from bincraft_decoder import decode_aircraft_payload

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
# binCraft helpers
# ─────────────────────────────────────────────────────────────────

def _parse_bincraft_aircraft(aircraft_list: list, now: datetime) -> dict[str, dict]:
    """
    Normalise a list of decoded binCraft aircraft dicts into the same
    intermediate format used by the OpenSky / ADSBx parsers.

    Keyed by lowercase ICAO hex.  Aircraft without a valid lat/lon are
    skipped — they carry no positional information useful for the map.

    Unit conversions:
      altitude: feet → metres (× 0.3048); "ground" sentinel preserved.
      speed:    knots → m/s   (× 0.514444).
    dbFlags bit 1 is the military flag (same bit used by ADSBx REST).
    """
    result: dict[str, dict] = {}
    for ac in aircraft_list:
        icao24 = (ac.get("hex") or "").lower().strip()
        # Skip pseudo-addresses (~xxxxxx) — they aren't stable ICAO identifiers
        if not icao24 or icao24.startswith("~"):
            continue
        if ac.get("lat") is None or ac.get("lon") is None:
            continue

        alt_ft = ac.get("alt_geom") or ac.get("alt_baro")
        alt_m  = (float(alt_ft) * 0.3048) if alt_ft not in (None, "ground") else None

        gs_knots  = ac.get("gs")
        speed_mps = (float(gs_knots) * 0.514444) if gs_knots is not None else None

        db_flags = ac.get("dbFlags", 0) or 0
        military = bool(db_flags & 2)

        result[icao24] = {
            "icao24":          icao24,
            "callsign":        ac.get("flight"),
            "lon":             float(ac["lon"]),
            "lat":             float(ac["lat"]),
            "altitude_m":      alt_m,
            "heading_deg":     ac.get("track"),
            "speed_mps":       speed_mps,
            "on_ground":       ac.get("alt_baro") == "ground",
            "squawk":          ac.get("squawk"),
            "origin_country":  None,          # binCraft does not carry this
            "registration":    ac.get("r") or None,
            "aircraft_type":   ac.get("t") or None,
            "category":        ac.get("category") or None,
            "adsbx_military":  military,
            "timestamp":       now,
            "source":          "binCraft",
            # binCraft-specific extras (added to metadata)
            "receiver_count":    ac.get("receiverCount"),
            "rssi":              ac.get("rssi"),
            "surveillance_type": ac.get("type"),
        }
    return result


def _enrich_with_bincraft(
    merged: list[dict],
    bincraft: dict[str, dict],
) -> list[dict]:
    """
    Apply binCraft data as a second-pass enrichment over the already-merged
    OpenSky+ADSBx list.

    Think of this as a LEFT JOIN where binCraft is the right-hand side:
      - Matching rows (same ICAO): binCraft wins on position/kinematics,
        military flag, registration, aircraft type, and adds the three
        binCraft-only fields (receiver_count, rssi, surveillance_type).
      - Non-matching binCraft rows: appended as new entries.
      - Merged rows not in binCraft: unchanged.

    The source label is updated to reflect which feeds contributed
    (e.g. "OpenSky+ADSBx+binCraft" or "OpenSky+binCraft").
    """
    merged_by_icao: dict[str, dict] = {r["icao24"]: r for r in merged}

    for icao, bc in bincraft.items():
        if icao in merged_by_icao:
            base = merged_by_icao[icao]
            # Position from binCraft: highest receiver consensus → most accurate
            base["lon"]         = bc["lon"]
            base["lat"]         = bc["lat"]
            base["altitude_m"]  = bc["altitude_m"]  if bc["altitude_m"]  is not None else base.get("altitude_m")
            base["heading_deg"] = bc["heading_deg"] if bc["heading_deg"] is not None else base.get("heading_deg")
            base["speed_mps"]   = bc["speed_mps"]   if bc["speed_mps"]   is not None else base.get("speed_mps")
            base["on_ground"]   = bc["on_ground"]
            # Military flag: binCraft wins when set (dbFlags bit 1 is reliable)
            if bc["adsbx_military"]:
                base["adsbx_military"] = True
            # Registration / type: prefer existing non-None values; fill gaps from binCraft
            base["registration"]  = base.get("registration")  or bc.get("registration")
            base["aircraft_type"] = base.get("aircraft_type") or bc.get("aircraft_type")
            # binCraft-exclusive fields (always overwrite — these don't exist in OpenSky/ADSBx)
            base["receiver_count"]    = bc.get("receiver_count")
            base["rssi"]              = bc.get("rssi")
            base["surveillance_type"] = bc.get("surveillance_type")
            # Update source label
            old_src = base.get("source", "")
            if "binCraft" not in old_src:
                base["source"] = old_src + "+binCraft" if old_src else "binCraft"
        else:
            # binCraft-only aircraft not seen by OpenSky or ADSBx REST
            merged_by_icao[icao] = bc

    return list(merged_by_icao.values())


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

        # ── binCraft (ADSBx globe binary endpoint) ────────────────────
        # Cookies are passed as a raw "Cookie: ..." header value, e.g.:
        #   ADSBX_BINCRAFT_COOKIES=adsbx_sid=abc123; adsbx_identity_exp=xyz
        # Bounding box: "south,north,west,east" (signed decimal degrees)
        #   Default covers the entire globe.
        self._bincraft_cookies      = os.environ.get("ADSBX_BINCRAFT_COOKIES", "").strip()
        self._bincraft_box          = os.environ.get("ADSBX_BINCRAFT_BOX", "-90,90,-180,180").strip()
        self._bincraft_min_interval = int(os.environ.get("BINCRAFT_MIN_INTERVAL_SEC", "120"))
        self._bincraft_max_interval = int(os.environ.get("BINCRAFT_MAX_INTERVAL_SEC", "200"))
        self._bincraft_error_cooldown_sec = int(os.environ.get("BINCRAFT_ERROR_COOLDOWN_SEC", "600"))

        # ── binCraft cookie auto-refresh ──────────────────────────────
        # When enabled, the collector GETs the globe homepage on a schedule
        # and captures fresh session cookies from the Set-Cookie headers.
        # BINCRAFT_COOKIE_REFRESH_INTERVAL_SEC: how often to refresh (s).
        #   Default 10800 = 3 hours.
        # BINCRAFT_SESSION_URL: the URL used to acquire cookies.
        #   Default is the globe homepage; override if ADSBx ever exposes a
        #   dedicated lightweight session endpoint.
        self._bincraft_auto_refresh_cookies = (
            os.environ.get("BINCRAFT_AUTO_REFRESH_COOKIES", "true").lower()
            in ("1", "true", "yes")
        )
        self._bincraft_cookie_refresh_interval_sec = int(
            os.environ.get("BINCRAFT_COOKIE_REFRESH_INTERVAL_SEC", "10800")
        )
        self._bincraft_session_url = os.environ.get(
            "BINCRAFT_SESSION_URL", "https://globe.adsbexchange.com/"
        ).strip()

        # ── Browser fingerprint ───────────────────────────────────────
        # BINCRAFT_USER_AGENT: the User-Agent string sent with both the
        #   cookie-refresh GET and the binCraft data fetch.  Set this to
        #   match your own browser so Cloudflare's TLS/JA3 fingerprint
        #   and UA string are consistent.  Default matches a real Chrome
        #   145 / Edge 145 install on macOS 10.15.
        # BINCRAFT_SEC_CH_UA: the structured Client Hints equivalent of
        #   the UA string (sec-ch-ua header).  Chrome/Edge 100+ sends
        #   this alongside User-Agent.  Must match the UA version.
        # BINCRAFT_SEC_CH_UA_PLATFORM: "macOS", "Windows", "Linux", …
        _default_ua = (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0"
        )
        # Brand order and obfuscation token come from the real browser:
        #   "Not:A-Brand" is the GREASE placeholder Chrome/Edge 145 uses.
        #   The order (Not:A-Brand → Edge → Chromium) and version numbers
        #   must match the UA string exactly or Cloudflare flags the mismatch.
        _default_ch_ua = (
            '"Not:A-Brand";v="99", "Microsoft Edge";v="145", "Chromium";v="145"'
        )
        self._bincraft_user_agent = os.environ.get(
            "BINCRAFT_USER_AGENT", _default_ua
        ).strip() or _default_ua
        self._bincraft_sec_ch_ua = os.environ.get(
            "BINCRAFT_SEC_CH_UA", _default_ch_ua
        ).strip() or _default_ch_ua
        self._bincraft_sec_ch_ua_platform = os.environ.get(
            "BINCRAFT_SEC_CH_UA_PLATFORM", "macOS"
        ).strip() or "macOS"

        # binCraft is "enabled" when we have seed cookies OR auto-refresh
        # will bootstrap them on the first poll cycle.
        self._bincraft_enabled = (
            bool(self._bincraft_cookies) or self._bincraft_auto_refresh_cookies
        )

        # Fire the first binCraft fetch immediately on startup
        self._bincraft_next_fetch: datetime = datetime.now(timezone.utc)
        self._bincraft_disabled_until: datetime | None = None

        # Cookie refresh timer: if seed cookies are present, wait a full
        # interval before the first refresh; if not, bootstrap immediately.
        if self._bincraft_cookies:
            self._bincraft_cookie_refresh_at: datetime = (
                datetime.now(timezone.utc)
                + timedelta(seconds=self._bincraft_cookie_refresh_interval_sec)
            )
        else:
            # No seed — attempt bootstrap on the very first poll cycle
            self._bincraft_cookie_refresh_at = datetime.now(timezone.utc)
            if self._bincraft_auto_refresh_cookies:
                logger.info(
                    "[binCraft] No seed cookies — will attempt auto-bootstrap "
                    "on first poll via %s",
                    self._bincraft_session_url,
                )

        sources = []
        if self._opensky_enabled:
            sources.append("OpenSky")
        if self._adsbx_enabled:
            sources.append("ADSBx")
        if self._bincraft_enabled:
            sources.append("binCraft")
        self.FEED_NAME = "+".join(sources) if sources else "ADS-B"

        bincraft_cookie_mode = (
            f"auto-refresh every {self._bincraft_cookie_refresh_interval_sec // 3600}h"
            if self._bincraft_auto_refresh_cookies
            else "manual (set BINCRAFT_AUTO_REFRESH_COOKIES=true to automate)"
        )
        logger.info(
            "[AdsbCollector] Active sources: %s  |  OpenSky auth=%s  "
            "|  binCraft data-interval=%d–%ds  |  binCraft cookies=%s  "
            "|  dedup: by ICAO hex",
            ", ".join(sources) if sources else "none",
            "oauth-client" if self._opensky_client_id and self._opensky_client_secret else "unauthenticated",
            self._bincraft_min_interval,
            self._bincraft_max_interval,
            bincraft_cookie_mode,
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

    # ── binCraft cookie helpers ───────────────────────────────────

    @staticmethod
    def _parse_cookie_header(cookie_str: str) -> dict[str, str]:
        """
        Parse a raw Cookie header string into an ordered name→value dict.

        Input:  "adsbx_sid=abc123; adsbx_identity_exp=xyz789"
        Output: {"adsbx_sid": "abc123", "adsbx_identity_exp": "xyz789"}

        This is a forward-only parse — it handles the simple semicolon-
        delimited format used in Cookie (request) headers, NOT the richer
        Set-Cookie (response) format which includes Path, Expires, etc.
        """
        result: dict[str, str] = {}
        for part in cookie_str.split(";"):
            part = part.strip()
            if "=" in part:
                name, _, value = part.partition("=")
                result[name.strip()] = value.strip()
        return result

    async def _refresh_bincraft_cookies(self, client: httpx.AsyncClient) -> bool:
        """
        Acquire fresh ADSBx globe session cookies by GETting the session URL.

        The globe server sets adsbx_sid and adsbx_identity_exp via Set-Cookie
        headers on a plain HTTP GET — no JavaScript execution required in the
        common case.  We send a full browser-like header set so Cloudflare's
        basic bot scoring is satisfied.

        On success:
          - Merges new cookies over any existing ones (preserves extras).
          - Clears _bincraft_disabled_until so a previously auth-failed
            binCraft fetch will retry immediately.
          - Enables binCraft if it was waiting for a bootstrap.
          - Schedules the next refresh at now + cookie_refresh_interval_sec.
          - Returns True.

        On failure (network error, Cloudflare JS challenge, no cookies in
        response):
          - Leaves existing cookies unchanged.
          - Schedules a retry at now + cookie_refresh_interval_sec.
          - Logs a clear warning.
          - Returns False.

        Cloudflare caveat: if the CDN issues a JS challenge (cf_clearance
        required), the response will be a 403 or contain no session cookies.
        In that case supply ADSBX_BINCRAFT_COOKIES as a one-time seed from
        your browser — the auto-refresh will take over once a valid session
        is already established.
        """
        # The cookies we care about from the globe session
        SESSION_COOKIE_NAMES = {"adsbx_sid", "adsbx_identity_exp"}

        try:
            resp = await client.get(
                self._bincraft_session_url,
                headers={
                    # ── Navigation fingerprint — matches curl #1 from browser ──
                    # Header order matters for HTTP/2 HPACK fingerprinting;
                    # keys are listed in the exact order Edge 145 sends them.
                    # Referer reflects navigation from the account page,
                    # which is the normal path a feeder operator takes.
                    "accept": (
                        "text/html,application/xhtml+xml,application/xml;"
                        "q=0.9,image/avif,image/webp,image/apng,*/*;"
                        "q=0.8,application/signed-exchange;v=b3;q=0.7"
                    ),
                    "accept-encoding":         "gzip, deflate, br, zstd",
                    "accept-language":         "en-US,en;q=0.9",
                    "cache-control":           "no-cache",
                    "pragma":                  "no-cache",
                    "priority":                "u=0, i",
                    "referer":                 "https://account.adsbexchange.com/",
                    "sec-ch-ua":               self._bincraft_sec_ch_ua,
                    "sec-ch-ua-mobile":        "?0",
                    "sec-ch-ua-platform":      f'"{self._bincraft_sec_ch_ua_platform}"',
                    "sec-fetch-dest":          "document",
                    "sec-fetch-mode":          "navigate",
                    "sec-fetch-site":          "same-origin",
                    "sec-fetch-user":          "?1",
                    "upgrade-insecure-requests": "1",
                    "user-agent":              self._bincraft_user_agent,
                },
                timeout=20.0,
                follow_redirects=True,
            )

            # httpx automatically parses all Set-Cookie headers into resp.cookies
            new_cookies: dict[str, str] = {
                name: value
                for name, value in resp.cookies.items()
                if name in SESSION_COOKIE_NAMES
            }

            if not new_cookies:
                logger.warning(
                    "[binCraft] Cookie refresh: no session cookies received "
                    "(status=%d url=%s) — Cloudflare JS challenge may be required; "
                    "supply ADSBX_BINCRAFT_COOKIES manually as a seed",
                    resp.status_code,
                    self._bincraft_session_url,
                )
                # Still reschedule so we don't hammer the endpoint
                self._bincraft_cookie_refresh_at = (
                    datetime.now(timezone.utc)
                    + timedelta(seconds=self._bincraft_cookie_refresh_interval_sec)
                )
                return False

            # Merge: existing cookies first, new cookies overwrite on collision
            merged = self._parse_cookie_header(self._bincraft_cookies)
            merged.update(new_cookies)
            self._bincraft_cookies = "; ".join(f"{k}={v}" for k, v in merged.items())

            # If binCraft was suspended after an auth failure, clear it —
            # fresh cookies mean we can retry right away
            if self._bincraft_disabled_until:
                logger.info(
                    "[binCraft] Cookies refreshed — clearing auth error cooldown "
                    "so next fetch proceeds immediately"
                )
                self._bincraft_disabled_until = None

            # Bootstrap: enable binCraft now that we have cookies
            if not self._bincraft_enabled:
                self._bincraft_enabled = True
                logger.info("[binCraft] Session bootstrapped — binCraft enabled")

            now = datetime.now(timezone.utc)
            self._bincraft_cookie_refresh_at = now + timedelta(
                seconds=self._bincraft_cookie_refresh_interval_sec
            )
            logger.info(
                "[binCraft] Session cookies refreshed (%s)  "
                "next refresh in %ds (~%dh)",
                ", ".join(new_cookies.keys()),
                self._bincraft_cookie_refresh_interval_sec,
                self._bincraft_cookie_refresh_interval_sec // 3600,
            )
            return True

        except Exception as exc:
            logger.warning("[binCraft] Cookie refresh failed: %s", exc)
            self._bincraft_cookie_refresh_at = (
                datetime.now(timezone.utc)
                + timedelta(seconds=self._bincraft_cookie_refresh_interval_sec)
            )
            return False

    # ── binCraft fetch ────────────────────────────────────────────
    async def _fetch_bincraft(self, client: httpx.AsyncClient) -> dict[str, dict]:
        """
        Fetch the ADS-B Exchange globe binary endpoint, decompress (Zstandard),
        decode the binCraft payload, and return a dict keyed by ICAO hex.

        Returns empty dict on any error so the rest of the merge still proceeds.

        Timing: only called when self._bincraft_next_fetch has been reached.
        On success, schedules the next fetch at a random interval in
        [_bincraft_min_interval, _bincraft_max_interval] seconds — irregular
        timing avoids synchronised load spikes on the upstream server.

        Authentication: session cookies are passed verbatim in the Cookie header
        alongside a Referer header that matches the expected origin for the API.
        The box parameter format is "south,north,west,east" (decimal degrees).
        """
        now = datetime.now(timezone.utc)

        if self._bincraft_disabled_until and now < self._bincraft_disabled_until:
            remaining = round((self._bincraft_disabled_until - now).total_seconds())
            logger.info("[binCraft] Cooling down after error for %ss", remaining)
            return {}

        url = (
            f"https://globe.adsbexchange.com/re-api/"
            f"?binCraft&zstd&box={self._bincraft_box}"
        )
        headers = {
            # ── XHR fingerprint — matches curl #2 from browser ───────────
            # Header order matches Edge 145's actual HTTP/2 frame order.
            # No Origin or Connection — browser omits both for same-origin
            # XHRs over HTTP/2.  No sec-fetch-user — only sent on navigations.
            "accept":              "*/*",
            "accept-encoding":     "gzip, deflate, br, zstd",
            "accept-language":     "en-US,en;q=0.9",
            "cache-control":       "no-cache",
            "cookie":              self._bincraft_cookies,
            "pragma":              "no-cache",
            "priority":            "u=1, i",
            "referer":             "https://globe.adsbexchange.com/",
            "sec-ch-ua":           self._bincraft_sec_ch_ua,
            "sec-ch-ua-mobile":    "?0",
            "sec-ch-ua-platform":  f'"{self._bincraft_sec_ch_ua_platform}"',
            "sec-fetch-dest":      "empty",
            "sec-fetch-mode":      "cors",
            "sec-fetch-site":      "same-origin",
            "user-agent":          self._bincraft_user_agent,
            "x-requested-with":    "XMLHttpRequest",
        }

        try:
            resp = await client.get(url, headers=headers, timeout=30.0)

            if resp.status_code == 401 or resp.status_code == 403:
                if self._bincraft_auto_refresh_cookies:
                    logger.warning(
                        "[binCraft] HTTP %d — cookies likely expired; "
                        "scheduling immediate cookie refresh on next poll cycle",
                        resp.status_code,
                    )
                    # Force a refresh on the very next fetch() call
                    self._bincraft_cookie_refresh_at = datetime.now(timezone.utc)
                else:
                    logger.warning(
                        "[binCraft] HTTP %d — update ADSBX_BINCRAFT_COOKIES manually "
                        "(set BINCRAFT_AUTO_REFRESH_COOKIES=true to automate this); "
                        "disabling for %ds",
                        resp.status_code, self._bincraft_error_cooldown_sec,
                    )
                self._bincraft_disabled_until = now + timedelta(seconds=self._bincraft_error_cooldown_sec)
                return {}

            if resp.status_code == 429:
                logger.warning(
                    "[binCraft] Rate limited (429) — cooling down for %ds",
                    self._bincraft_error_cooldown_sec,
                )
                self._bincraft_disabled_until = now + timedelta(seconds=self._bincraft_error_cooldown_sec)
                return {}

            resp.raise_for_status()

            # Decompress Zstandard payload before decoding
            compressed = resp.content
            dctx = zstd.ZstdDecompressor()
            raw = dctx.decompress(compressed, max_output_size=50_000_000)

            decoded = decode_aircraft_payload(raw)
            ac_list = decoded.get("aircraft", [])
            now_ts  = datetime.now(timezone.utc)
            parsed  = _parse_bincraft_aircraft(ac_list, now_ts)

            # Schedule next fetch at a random interval (irregular to avoid hammering)
            interval = random.randint(self._bincraft_min_interval, self._bincraft_max_interval)
            self._bincraft_next_fetch = now + timedelta(seconds=interval)
            self._bincraft_disabled_until = None

            logger.info(
                "[binCraft] %d aircraft parsed  (version=%s, stride=%d)  "
                "next fetch in %ds",
                len(parsed),
                decoded["header"].get("bincraft_version", "?"),
                decoded["header"].get("stride", 0),
                interval,
            )
            return parsed

        except zstd.ZstdError as exc:
            logger.warning("[binCraft] Decompression error: %s — skipping this cycle", exc)
            self._bincraft_next_fetch = now + timedelta(seconds=self._bincraft_min_interval)
            return {}
        except httpx.HTTPStatusError as exc:
            logger.warning("[binCraft] HTTP error %s — skipping this cycle", exc.response.status_code)
            self._bincraft_next_fetch = now + timedelta(seconds=self._bincraft_min_interval)
            return {}
        except Exception as exc:
            logger.warning("[binCraft] Fetch/decode error: %s — skipping this cycle", exc)
            self._bincraft_next_fetch = now + timedelta(seconds=self._bincraft_min_interval)
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
        now = datetime.now(timezone.utc)

        # Cookie refresh runs BEFORE the main gather so that if new cookies
        # are acquired (bootstrap or expiry recovery) the binCraft fetch in
        # this same cycle immediately uses them.
        cookie_refresh_due = (
            self._bincraft_auto_refresh_cookies
            and now >= self._bincraft_cookie_refresh_at
        )

        async with httpx.AsyncClient() as client:
            if cookie_refresh_due:
                await self._refresh_bincraft_cookies(client)
                # Re-read now — refresh may have just enabled binCraft
                now = datetime.now(timezone.utc)

            bincraft_due = (
                self._bincraft_enabled
                and now >= self._bincraft_next_fetch
            )

            tasks: list = []
            if self._opensky_enabled:
                tasks.append(self._fetch_opensky(client))
            if self._adsbx_enabled:
                tasks.append(self._fetch_adsbx(client))
            if bincraft_due:
                tasks.append(self._fetch_bincraft(client))

            if not tasks:
                logger.error("[AdsbCollector] No ADS-B sources configured")
                return []

            results = await asyncio.gather(*tasks, return_exceptions=True)

        # Unpack results in the order tasks were appended
        opensky_data:   dict[str, dict] = {}
        adsbx_data:     dict[str, dict] = {}
        bincraft_data:  dict[str, dict] = {}

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
        if bincraft_due:
            r = results[idx]
            idx += 1
            if isinstance(r, dict):
                bincraft_data = r

        # Pass 1: merge OpenSky + ADSBx REST by ICAO hex
        merged_rows = _merge_sources(opensky_data, adsbx_data)

        # Pass 2: enrich with binCraft (if fetched this cycle)
        if bincraft_data:
            merged_rows = _enrich_with_bincraft(merged_rows, bincraft_data)

        # Logging summary
        only_os = sum(1 for r in merged_rows if r["source"] == "OpenSky")
        only_ax = sum(1 for r in merged_rows if r["source"] == "ADSBx")
        only_bc = sum(1 for r in merged_rows if r["source"] == "binCraft")
        multi   = len(merged_rows) - only_os - only_ax - only_bc
        logger.info(
            "[AdsbCollector] %d aircraft total  "
            "(OpenSky-only: %d  ADSBx-only: %d  binCraft-only: %d  multi-source: %d)%s",
            len(merged_rows), only_os, only_ax, only_bc, multi,
            "  [binCraft cycle]" if bincraft_due else "",
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
                source_feed=source,
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
                    "on_ground":         row.get("on_ground"),
                    "squawk":            row.get("squawk"),
                    "origin_country":    row.get("origin_country"),
                    "registration":      row.get("registration"),
                    "aircraft_type":     row.get("aircraft_type"),
                    "category":          row.get("category"),
                    "military_flag":     row.get("adsbx_military"),
                    "sources":           source,
                    # binCraft-exclusive fields (None when binCraft not in source)
                    "receiver_count":    row.get("receiver_count"),
                    "rssi":              row.get("rssi"),
                    "surveillance_type": row.get("surveillance_type"),
                },
            ))

        return events


if __name__ == "__main__":
    collector = AdsbCollector()
    asyncio.run(collector.run())

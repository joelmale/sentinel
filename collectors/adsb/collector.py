"""
ADS-B Collector — OpenSky Network

Polls the OpenSky Network REST API for live aircraft state vectors.
ADS-B (Automatic Dependent Surveillance–Broadcast) is the transponder
signal all modern commercial aircraft broadcast every ~0.5 seconds.
OpenSky Network aggregates these from ~5000 ground stations globally.

API docs: https://openskynetwork.github.io/opensky-api/rest.html

Classification heuristic: ICAO 24-bit addresses in certain ranges
are assigned to military aircraft by national aviation authorities.
This is a rough heuristic — dedicated databases like ADSBDB provide
more accurate classification.
"""

import asyncio
import os
from datetime import datetime, timezone

import httpx

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector, TrackEventDict

# ICAO hex ranges allocated to military (approximate, US-centric)
# Source: various public ICAO allocation documents
MILITARY_ICAO_PREFIXES = {
    "AE",  # US military
    "43",  # Russian military
    "800",  # Indian Air Force
}


def classify_aircraft(icao_hex: str, callsign: str | None) -> str:
    """Heuristic classification from ICAO address and callsign."""
    icao_upper = icao_hex.upper()
    if any(icao_upper.startswith(pfx) for pfx in MILITARY_ICAO_PREFIXES):
        return "Military"
    if callsign:
        cs = callsign.strip().upper()
        # Military callsign patterns
        if any(cs.startswith(p) for p in ("RCH", "RFF", "REACH", "TOPAZ", "COBRA", "WOLF")):
            return "Military"
        # Government/special
        if cs.startswith(("SAM", "AF1", "AF2", "EXEC")):
            return "Government"
    return "Commercial"


class OpenSkyCollector(BaseCollector):
    DOMAIN = "Air"
    FEED_NAME = "OpenSky"

    BASE_URL = "https://opensky-network.org/api/states/all"

    def __init__(self):
        super().__init__(
            db_url=os.environ["DATABASE_URL"],
            redis_url=os.environ["REDIS_URL"],
            poll_interval=float(os.environ.get("POLL_INTERVAL_SEC", 10)),
        )
        self.username = os.environ.get("OPENSKY_USERNAME") or None
        self.password = os.environ.get("OPENSKY_PASSWORD") or None

    async def fetch(self) -> list[dict]:
        auth = (self.username, self.password) if self.username else None
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(self.BASE_URL, auth=auth)
            resp.raise_for_status()
            data = resp.json()

        states = data.get("states") or []
        now = datetime.now(timezone.utc)
        events = []

        for s in states:
            # OpenSky state vector format (index reference):
            # 0=icao24, 1=callsign, 2=origin_country, 3=time_position,
            # 4=last_contact, 5=longitude, 6=latitude, 7=baro_altitude,
            # 8=on_ground, 9=velocity, 10=true_track, 11=vertical_rate,
            # 12=sensors, 13=geo_altitude, 14=squawk, 15=spi, 16=position_source

            icao24 = s[0]
            callsign = (s[1] or "").strip() or None
            lon = s[5]
            lat = s[6]
            on_ground = s[8]
            speed_ms = s[9]       # m/s
            heading = s[10]       # degrees
            altitude = s[7]       # baro altitude in metres
            squawk = s[14]

            # Skip aircraft without position or on the ground (optional filter)
            if lon is None or lat is None:
                continue

            classification = classify_aircraft(icao24, callsign)

            events.append(TrackEventDict.create(
                source_domain=self.DOMAIN,
                source_feed=self.FEED_NAME,
                track_id=icao24,
                timestamp=now,
                lon=lon,
                lat=lat,
                callsign=callsign,
                altitude_m=altitude,
                heading_deg=heading,
                speed_mps=speed_ms,
                classification=classification,
                metadata={
                    "on_ground": on_ground,
                    "squawk": squawk,
                    "origin_country": s[2],
                },
            ))

        return events


if __name__ == "__main__":
    collector = OpenSkyCollector()
    asyncio.run(collector.run())

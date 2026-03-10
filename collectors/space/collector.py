"""
Space / Satellite Collector — Celestrak + Space-Track + skyfield

TLE (Two-Line Element) sets are the standard format for describing
satellite orbits. They encode the Keplerian orbital elements needed
to propagate a satellite's position forward in time using the SGP4
model.

Think of TLEs as a recipe: given the current state of the orbit
(inclination, eccentricity, period, etc.) and a reference epoch,
SGP4 can compute where the satellite will be at any future moment.

This collector:
  1. Downloads TLE sets from Celestrak every 2 hours
  2. Uses skyfield to compute ground tracks for the next 24 hours
  3. Writes future pass predictions as TrackEvents with future timestamps
  4. The playback engine can then show predicted satellite coverage

Key satellites of OSINT interest:
  - Maxar (WorldView-3, GeoEye-1): high-res optical imaging
  - Capella Space: SAR (see through clouds, day/night)
  - Gaofen series: Chinese optical/SAR
  - Persona series: Russian reconnaissance
  - USA-224 (KH-11 Kennan): US optical reconnaissance (classified orbit, inferred)

TODO Phase 2: Implement full TLE → ground track pipeline using skyfield.
"""

import asyncio
import os

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector

# Celestrak catalog groups of interest
CELESTRAK_GROUPS = {
    "active": "https://celestrak.org/SOCRATES/query.php?FORMAT=TLE",
    "visual": "https://celestrak.org/SOCRATES/query.php?FORMAT=TLE",
    # Direct TLE endpoints:
    "active_sats": "https://celestrak.org/SOCRATES/query.php",
}

# Space-Track login
SPACETRACK_LOGIN = "https://www.space-track.org/ajaxauth/login"
SPACETRACK_QUERY = "https://www.space-track.org/basicspacedata/query/class/gp/OBJECT_TYPE/PAYLOAD/orderby/NORAD_CAT_ID/format/json"

# NORAD IDs of OSINT-relevant commercial imaging satellites
KNOWN_IMAGING_SATS = {
    40115: ("WorldView-3", "Maxar", "Optical"),
    49260: ("WorldView Legion 1", "Maxar", "Optical"),
    53867: ("Capella-8", "Capella Space", "SAR"),
    57266: ("GaoFen-3 03", "CASC", "SAR"),
}


class SpaceCollector(BaseCollector):
    DOMAIN = "Space"
    FEED_NAME = "Celestrak/SpaceTrack"

    def __init__(self):
        super().__init__(
            db_url=os.environ["DATABASE_URL"],
            redis_url=os.environ["REDIS_URL"],
            poll_interval=float(os.environ.get("TLE_REFRESH_INTERVAL_SEC", 7200)),
        )
        self.spacetrack_user = os.environ.get("SPACETRACK_USER")
        self.spacetrack_pass = os.environ.get("SPACETRACK_PASS")

    async def fetch(self) -> list[dict]:
        # TODO Phase 2:
        # 1. httpx.post to Space-Track login
        # 2. GET TLE catalog JSON
        # 3. For each satellite of interest:
        #    from skyfield.api import load, EarthSatellite
        #    ts = load.timescale()
        #    satellite = EarthSatellite(line1, line2, name, ts)
        #    t = ts.now()
        #    geocentric = satellite.at(t)
        #    subpoint = geocentric.subpoint()
        #    -> subpoint.longitude.degrees, subpoint.latitude.degrees
        # 4. Create TrackEvent for current + projected passes
        raise NotImplementedError("Space collector — implement in Phase 2")


if __name__ == "__main__":
    collector = SpaceCollector()
    asyncio.run(collector.run())

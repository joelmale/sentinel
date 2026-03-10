"""
AIS Collector — AISHub

AIS (Automatic Identification System) is the maritime equivalent of ADS-B.
All commercial vessels >300 GT are required to broadcast their MMSI, position,
heading, and voyage data on VHF radio every 2-10 seconds.

AISHub aggregates feeds from volunteer AIS receivers globally.
You must share AIS data back to use the free tier (reciprocal arrangement).

API: https://www.aishub.net/api

NMEA sentence types we care about:
  - !AIVDM type 1/2/3: Position report class A (Class A transponders)
  - !AIVDM type 18: Position report class B (smaller vessels)
  - !AIVDM type 5: Voyage data (ship name, destination, ETA)

TODO Phase 2: Implement NMEA sentence parser using pyais library.
"""

import asyncio
import os

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector, TrackEventDict

# Vessel type codes → classification
# Source: ITU-R M.1371 Table 36
VESSEL_TYPE_MAP = {
    range(20, 30): "Wing in Ground",
    range(30, 40): "Fishing",
    range(35, 36): "Military",  # 35 = military ops
    range(40, 50): "High Speed Craft",
    range(50, 60): "Special Craft",
    range(60, 70): "Passenger",
    range(70, 80): "Cargo",
    range(80, 90): "Tanker",
    range(90, 100): "Other",
}


def classify_vessel(vessel_type: int) -> str:
    if vessel_type == 35:
        return "Military"
    for r, classification in VESSEL_TYPE_MAP.items():
        if vessel_type in r:
            return classification
    return "Unknown"


class AISHubCollector(BaseCollector):
    DOMAIN = "Maritime"
    FEED_NAME = "AISHub"

    def __init__(self):
        super().__init__(
            db_url=os.environ["DATABASE_URL"],
            redis_url=os.environ["REDIS_URL"],
            poll_interval=float(os.environ.get("POLL_INTERVAL_SEC", 30)),
        )
        self.username = os.environ["AISHUB_USERNAME"]
        self.password = os.environ["AISHUB_PASSWORD"]

    async def fetch(self) -> list[dict]:
        # TODO Phase 2: Implement AISHub HTTP API call
        # Endpoint: https://data.aishub.net/ws.php?username=X&format=1&output=json&compress=0
        # Response: JSON array of vessel state records
        raise NotImplementedError("AIS collector — implement in Phase 2")


if __name__ == "__main__":
    collector = AISHubCollector()
    asyncio.run(collector.run())

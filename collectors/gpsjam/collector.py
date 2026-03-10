"""
GPS Jamming Collector — GPSJam.org

GPSJam.org derives GPS interference data from ADS-B feeds.
Modern aircraft report the accuracy of their GNSS position fix (NACp field).
When NACp values degrade over an area, it indicates GPS jamming or spoofing.

The site publishes H3 hexagonal grid data (resolution 4, ~288km² per cell)
with interference probability scores.

H3 is Uber's hierarchical geospatial indexing system. Think of it as
a planet-sized honeycomb where each cell has a unique 64-bit integer ID.
At resolution 4, the Earth is divided into ~288,122 hexagons.

This collector:
  1. Fetches the daily H3 tile data from GPSJam
  2. Diffs against previous snapshot to detect changes
  3. Writes only changed cells to DB (avoids writing 288k rows every hour)

TODO Phase 2: Implement full H3 tile fetch + diff logic.
Useful library: h3-py (pip install h3) for cell→lat/lon conversion.
"""

import asyncio
import os

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector

GPSJAM_BASE = "https://gpsjam.org"
# GPSJam publishes geojson-style data; exact endpoint requires inspection


class GPSJamCollector(BaseCollector):
    DOMAIN = "GPS"
    FEED_NAME = "GPSJam"

    def __init__(self):
        super().__init__(
            db_url=os.environ["DATABASE_URL"],
            redis_url=os.environ["REDIS_URL"],
            poll_interval=float(os.environ.get("POLL_INTERVAL_SEC", 3600)),
        )
        self._previous_snapshot: dict[str, float] = {}  # h3_cell_id → interference_score

    async def fetch(self) -> list[dict]:
        # TODO Phase 2:
        # 1. httpx GET GPSJam tile data for current UTC date
        # 2. Parse H3 cell IDs + interference scores
        # 3. Diff against self._previous_snapshot
        # 4. For changed cells:
        #    import h3
        #    lat, lon = h3.cell_to_latlng(cell_id)
        #    -> create TrackEvent with metadata: {h3_cell: cell_id, score: score}
        # 5. Update self._previous_snapshot
        raise NotImplementedError("GPSJam collector — implement in Phase 2")


if __name__ == "__main__":
    collector = GPSJamCollector()
    asyncio.run(collector.run())

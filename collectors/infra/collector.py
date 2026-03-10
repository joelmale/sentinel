"""
Infrastructure Outage Collector — IODA + PowerOutage.us

Monitors two types of infrastructure disruption:

1. Internet outages (IODA — Georgia Tech Internet Intelligence Lab)
   IODA uses three complementary measurement methods:
   - BGP routing data: ASN-level route withdrawals
   - Active probing: ICMP ping to large address samples
   - Telescope: unsolicited traffic patterns (darknet)
   When all three signal simultaneously, it's almost certainly a real outage.

2. Power outages (PowerOutage.us)
   Aggregates data from US electric utilities reporting customer outage counts.
   Updates every 15 minutes. Useful for correlating infrastructure disruptions.

The combined "infrastructure" domain gives analysts context for why
AIS vessels might suddenly lose transponder contact, or why internet
blackout events precede other activity.

TODO Phase 2: Implement both source parsers.
"""

import asyncio
import os

import sys
sys.path.insert(0, "/app/base")
from base_collector import BaseCollector

# IODA API (Georgia Tech)
IODA_API = "https://api.ioda.caida.org/v2/outages/alerts"

# PowerOutage.us — scrape the summary JSON endpoint
POWEROUTAGE_API = "https://api.poweroutage.us/api/v1/states"


class InfraCollector(BaseCollector):
    DOMAIN = "Infra"
    FEED_NAME = "IODA+PowerOutage"

    def __init__(self):
        super().__init__(
            db_url=os.environ["DATABASE_URL"],
            redis_url=os.environ["REDIS_URL"],
            poll_interval=float(os.environ.get("POLL_INTERVAL_SEC", 300)),
        )

    async def fetch(self) -> list[dict]:
        # TODO Phase 2:
        # IODA:
        #   GET https://api.ioda.caida.org/v2/outages/alerts?from=<unix>&until=<unix>
        #   Response: list of {entity: {type, code, name}, level, time, score}
        #   Map entity code → country ISO → centroid lat/lon
        #   Create TrackEvent: source_domain=Infra, track_id=country_code,
        #                      metadata={type: "internet", severity: score}
        #
        # PowerOutage:
        #   GET https://api.poweroutage.us/api/v1/states
        #   Response: list of {state, customers_tracked, customers_out, percent_out}
        #   Map state name → centroid lat/lon (use us-states GeoJSON)
        raise NotImplementedError("Infra collector — implement in Phase 2")


if __name__ == "__main__":
    collector = InfraCollector()
    asyncio.run(collector.run())

# Domain Data Flows

This page describes how each domain-specific collector differs from the shared collector pipeline.

Shared runtime:

- [collectors/base/base_collector.py](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py)

## Air: ADS-B

Collector:

- [collectors/adsb/collector.py](/Users/JoelN/Coding/sentinel/collectors/adsb/collector.py)

Primary sources:

- OpenSky
- ADSBx REST
- ADSBx binCraft

Flow:

1. fetch OpenSky snapshot
2. fetch ADSBx REST
3. optionally fetch binCraft on its own cadence
4. merge by ICAO24
5. classify military/commercial/government
6. emit one merged event per aircraft per poll cycle

Key enrichment:

- registration
- aircraft type
- ADS-B category
- military hints
- receiver-quality fields from binCraft

Main caveats:

- external API rate limits
- ADSBx credentials/cookies
- military classification is heuristic when explicit source flags are absent

## Maritime: AIS

Collector:

- [collectors/ais/collector.py](/Users/JoelN/Coding/sentinel/collectors/ais/collector.py)

Primary sources/modes:

- AISStream websocket
- AccessAIS import
- Global Fishing Watch
- optional MarineTraffic enrichment

Flow:

1. ingest AIS position/static vessel data
2. classify vessel from type codes
3. merge source variants depending on selected runtime mode
4. optionally enrich selected vessels from MarineTraffic public pages
5. emit normalized maritime events

Key enrichment:

- ship type classification
- destination
- owner/operator
- public vessel profile/image where available

Main caveats:

- source mode changes behavior significantly
- MarineTraffic enrichment is best-effort and Cloudflare-sensitive
- some maritime identity fields are sparse or inconsistent across feeds

## Space

Collector:

- [collectors/space/collector.py](/Users/JoelN/Coding/sentinel/collectors/space/collector.py)

Primary sources:

- Space-Track
- CelesTrak fallback
- optional N2YO and SatNOGS supplemental data

Flow:

1. fetch TLEs and SATCAT metadata
2. upsert `satellite_catalog`
3. insert `satellite_tles`
4. propagate current positions from TLE state
5. emit live space events
6. update `space_watchlist_status`

Key enrichment:

- orbit class
- launch metadata
- country/operator/purpose
- TLE provenance

Main caveats:

- TLE quality/source freshness
- N2YO supplemental parsing quality
- distinction between orbital metadata and current propagated position

## GPSJam

Collector:

- [collectors/gpsjam/collector.py](/Users/JoelN/Coding/sentinel/collectors/gpsjam/collector.py)

Primary source:

- GPSJam H3 daily CSV datasets

Flow:

1. fetch latest or fallback daily H3 CSV
2. normalize cell scores
3. compare against previous snapshot
4. emit:
   - GPS track-like events for map/timeline integration
   - disruption metadata for normalized disruption tables

Key enrichment:

- H3 cell metadata
- percent/severity scores
- polygon geometry per cell

Main caveats:

- this is an anomaly/hint layer, not direct RF ground truth
- geometry is cell-derived rather than source-native polygons

## Infra

Collector:

- [collectors/infra/collector.py](/Users/JoelN/Coding/sentinel/collectors/infra/collector.py)

Primary sources:

- IODA
- PowerOutage.us
- Cloudflare Radar
- EIA

Flow:

1. poll enabled source endpoints
2. normalize each source into disruption-like events
3. emit point-based track events for map compatibility
4. embed `_disruption` metadata for normalized disruption writes

Key enrichment today:

- source severity and score metadata
- state centroid approximations for outages
- source payload capture

Main caveats:

- geospatial enrichment is weakest in this domain
- many events are represented as centroids or coarse jurisdictions, not real service polygons
- documentation should explicitly note this gap

## ACLED

Collector:

- [collectors/acled/collector.py](/Users/JoelN/Coding/sentinel/collectors/acled/collector.py)

Primary source:

- ACLED conflict/event API

Flow:

1. authenticate with ACLED OAuth
2. fetch event rows for configured filters
3. normalize conflict events into:
   - point-based track events
   - disruption metadata

Key enrichment:

- country/admin/location
- actor metadata
- fatalities and event type/subtype

Main caveats:

- treated under `Infra` domain in current schema/runtime
- event geometry is point-based from source rows

## Cross-domain notes

- All domains share identity resolution, current-state writes, Redis publication, and source-run tracking.
- Air and Maritime are still the most traditional moving-track domains.
- Space combines dynamic positions with heavy catalog enrichment.
- GPSJam, Infra, and ACLED use track-compatible events mainly to fit the current UI pipeline while also writing normalized disruptions.

## Recommended diagrams/tables for this page

- domain/source matrix
- per-domain sequence mini-diagrams
- table of source credentials and cadence

## Explicit caveats

- “Track event” does not mean the same operational thing in every domain.
- Some domains use point-style events mainly as UI compatibility adapters on top of richer disruption semantics.

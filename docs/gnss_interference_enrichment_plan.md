# GNSS Interference Enrichment Plan

## Scope

This document captures the current assessment of Sentinel's GNSS interference data strategy and a concrete engineering plan for improving it.

It focuses on:

- `GPSJam` as the currently integrated source
- candidate external enrichment/corroboration sources
- Sentinel-native correlation from existing Air and Maritime data
- a practical implementation path using the current PostgreSQL/PostGIS/TimescaleDB + FastAPI + React stack

## Current Assessment

### What Sentinel Has Today

Sentinel currently ingests `GPSJam` data via [`collectors/gpsjam/collector.py`](/Users/JoelN/Coding/sentinel/collectors/gpsjam/collector.py).

That collector currently provides:

- H3 cell ID
- H3 polygon geometry
- H3 resolution
- normalized score
- percentage score
- source URL
- normalized disruption records through the shared collector path

This is a solid prototype baseline.

### What GPSJam Actually Represents

`GPSJam` should be treated as an observational anomaly layer, not authoritative proof of active jamming.

Important caveats from the public GPSJam documentation:

- it is derived from aircraft-reported navigation quality
- the map reflects degraded navigation performance, not direct RF measurement
- the effect is aggregated over a long observation window
- poor reported quality can have causes other than intentional jamming

Sources:

- [GPSJAM About](https://gpsjam.org/about/)
- [GPSJAM FAQ](https://gpsjam.org/faq)

### Why FR24 Scraping Is Not The First Recommendation

The Google request observed from the FR24 page is a map styling request, not the GNSS interference dataset:

- `mapsresources-pa.googleapis.com/...styleTables...`

That is basemap infrastructure, not the jamming data itself.

FR24's jamming page is potentially useful, but:

- it appears to rely on undocumented front-end data flows
- it may use binary/tiled transport
- it is likely brittle to scrape
- it is not ideal as a primary dependency for Sentinel

Sources:

- [FR24 GPS jamming page](https://www.flightradar24.com/data/gps-jamming?date=2026-03-14-00)
- [FR24 blog: GPS jamming map](https://www.flightradar24.com/blog/inside-flightradar24/gps-jamming-map/)

## Source Recommendations

### Recommended Source Priority

1. `GPSJam`
- Keep as the current public baseline source.
- Position it as a low-confidence anomaly hint layer.

2. `GPSwise`
- Best next source if API access is available.
- Better fit than fragile scraping.
- Treat as an independent second aviation-derived source.

Source:
- [GPSwise API docs](https://gpswise.aero/api-docs)

3. `SkAI Data Services`
- Strong candidate if commercial or partner access is available.
- Offers spoofing/jamming-specific products and APIs.

Source:
- [GPS World summary of SkAI tracker](https://www.gpsworld.com/gps-spoofing-and-jamming-tracker-map/)

4. `Spire`
- Best commercial-grade path if budget and access exist.
- Strong because it combines terrestrial and satellite ADS-B and explicitly references navigation quality metrics.

Source:
- [Spire GNSS Interference](https://spire.com/aviation/gnss-interference/)

5. `FR24 scraping`
- Only as an experimental fallback if no cleaner second source is available.
- Do not make it production-critical.

## Recommended Data Strategy

### Core Principle

No single external map should define Sentinel's GNSS truth model.

Instead:

- ingest multiple signals
- normalize them into one observation model
- enrich them geospatially
- fuse them into operational events with confidence scoring

### Recommended Internal Model

#### `gnss_interference_observations`

Purpose:
- normalized evidence from `GPSJam`, future `GPSwise`, future `SkAI`, optional `FR24`, and Sentinel-native heuristics

Recommended fields:

- `observation_id`
- `source`
- `observed_at`
- `valid_from`
- `valid_to`
- `geometry`
- `centroid`
- `h3_cell`
- `signal_type`
  - `jamming_hint`
  - `spoofing_hint`
  - `accuracy_loss`
  - `route_anomaly`
- `score`
- `window_hours`
- `source_confidence`
- `metadata`

#### `gnss_interference_events`

Purpose:
- fused operational incidents derived from one or more observations

Recommended fields:

- `event_id`
- `status`
- `first_seen`
- `last_seen`
- `valid_from`
- `valid_to`
- `geometry`
- `centroid`
- `confidence`
- `evidence_count`
- `independent_source_count`
- `planned_vs_unplanned`
- `impacted_air_assets`
- `impacted_maritime_assets`
- `metadata`

## Best Enrichment Paths

### 1. Sentinel-Native ADS-B Correlation

This is the highest-value enrichment path because Sentinel already ingests ADS-B.

Recommended derived signals:

- position quality degradation clusters
- sudden heading discontinuities
- speed discontinuities
- route divergence clusters
- spatial concentration of degraded aircraft in the same cell/AOI
- airport/FIR/route corridor overlap

### 2. Maritime Correlation

AIS is not a GNSS interference authority, but it can provide corroboration.

Recommended signals:

- impossible motion
- coherent vessel jump clusters
- coastal/port disruption overlap
- same-area same-time maritime anomalies

### 3. Geospatial Context Enrichment

Every GNSS observation or event should be enriched with:

- country
- FIR/UIR
- nearest airport(s)
- route corridor
- AOI overlap
- impacted tracked asset counts
- coastal/ocean tag for maritime relevance

## FR24 Evaluation Notes

If FR24 must be explored later, do it only as a bounded experiment:

1. Inspect browser network calls on the jamming page.
2. Ignore:
- Google Maps style/table requests
- static assets
- generic basemap requests
3. Look for:
- JSON or GeoJSON
- vector tile protobuf
- binary tile payloads
- date/window keyed requests
4. Prototype a decoder first.
5. Do not wire it into production until:
- data semantics are understood
- update cadence is confirmed
- terms/risk are reviewed

## Recommended Commit-By-Commit Engineering Plan

### Commit 1
`add gnss interference planning doc and source taxonomy`

Goal:
- establish internal terminology and source classes before schema changes

Files likely touched:

- `docs/gnss_interference_enrichment_plan.md`
- optional type/constants modules

Backend:
- none

Frontend:
- none

Validation:
- document review only

Why standalone:
- creates the canonical plan and vocabulary for later slices

### Commit 2
`add normalized gnss interference observation table`

Goal:
- create a source-agnostic evidence model

Files likely touched:

- [`docker/timescaledb/init.sql`](/Users/JoelN/Coding/sentinel/docker/timescaledb/init.sql)
- [`collectors/base/base_collector.py`](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py)

Backend changes:

- add `gnss_interference_observations`
- add indexes on:
  - `observed_at`
  - `geometry`
  - `source`
  - `h3_cell`

Frontend changes:
- none

Validation:

- `python3 -m py_compile collectors/base/base_collector.py`
- `psql` schema inspection

Why standalone:
- enables all later work without changing UI behavior yet

### Commit 3
`write gpsjam observations into normalized gnss model`

Goal:
- preserve the current GPSJam path while adding normalized GNSS evidence rows

Files likely touched:

- [`collectors/gpsjam/collector.py`](/Users/JoelN/Coding/sentinel/collectors/gpsjam/collector.py)
- [`collectors/base/base_collector.py`](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py)

Backend changes:

- insert GPSJam-derived rows into `gnss_interference_observations`
- include:
  - H3 cell
  - polygon geometry
  - score
  - window metadata
  - source confidence

Frontend changes:
- none

Validation:

- collector run
- DB row inspection

Why standalone:
- upgrades the current source without waiting for new external integrations

### Commit 4
`add geospatial enrichment for gnss observations`

Goal:
- make observations operationally meaningful

Files likely touched:

- new lookup tables or seed data under `docker/timescaledb/`
- backend enrichment helper module
- [`collectors/gpsjam/collector.py`](/Users/JoelN/Coding/sentinel/collectors/gpsjam/collector.py)

Backend changes:

- enrich each observation with:
  - country
  - FIR if available
  - nearest airport
  - AOI overlap
  - impacted live asset counts

Frontend changes:
- none

Validation:

- sample enriched rows in DB
- spot-check geometry overlaps

Why standalone:
- improves product usefulness before adding more sources

### Commit 5
`derive sentinel adsb gnss anomaly observations`

Goal:
- create Sentinel-native GNSS anomaly evidence from existing ADS-B data

Files likely touched:

- [`collectors/adsb/collector.py`](/Users/JoelN/Coding/sentinel/collectors/adsb/collector.py)
- new backend scoring helper

Backend changes:

- derive low/medium-confidence GNSS anomaly observations from:
  - route discontinuities
  - clustered degraded quality proxies
  - abrupt multi-aircraft anomalies

Frontend changes:
- none

Validation:

- unit-style sampling against known events
- DB inserts into `gnss_interference_observations`

Why standalone:
- adds a powerful internal corroboration source without new external dependencies

### Commit 6
`add fused gnss interference event materialization`

Goal:
- cluster observations into operational incidents

Files likely touched:

- backend route/service modules
- schema additions if needed

Backend changes:

- create `gnss_interference_events`
- cluster by space/time
- compute:
  - `confidence`
  - `evidence_count`
  - `independent_source_count`
  - `impacted_air_assets`
  - `impacted_maritime_assets`

Frontend changes:
- none yet

Validation:

- SQL/result inspection
- compare fused events vs raw observation count

Why standalone:
- creates the operational read model before UI work

### Commit 7
`add gpswise ingestion adapter`

Goal:
- add a second independent external signal source

Files likely touched:

- new collector or provider module
- backend config/env handling

Backend changes:

- ingest `GPSwise` into `gnss_interference_observations`

Frontend changes:
- none

Validation:

- source-specific row verification
- confidence/source metadata checks

Why standalone:
- cleanly adds one new evidence source without entangling UI changes

### Commit 8
`add gnss interference api and detail payloads`

Goal:
- expose normalized observations and fused events to the app

Files likely touched:

- new FastAPI router
- shared API models

Backend changes:

- endpoint(s) for:
  - observations
  - fused events
  - event detail with source breakdown

Frontend changes:
- minimal wiring only

Validation:

- `python3 -m py_compile api/...`
- API response inspection

Why standalone:
- gives the frontend a stable contract without redesigning UX yet

### Commit 9
`add gnss confidence and source breakdown ui`

Goal:
- show why a GNSS event matters

Files likely touched:

- frontend event/detail components
- map overlays if needed

Frontend changes:

- render:
  - confidence
  - source count
  - evidence list
  - impacted assets
  - enriched area context

Backend changes:
- none or minimal contract polishing

Validation:

- `npm --prefix frontend run type-check`
- `npm --prefix frontend run lint`

Why standalone:
- keeps UI work after the model is stable

### Commit 10
`evaluate experimental fr24 adapter`

Goal:
- only if needed, run a bounded FR24 prototype

Files likely touched:

- separate experimental module
- docs/runbook

Backend changes:

- optional prototype parser/adapter

Frontend changes:
- none

Validation:

- prove data format is stable enough before adoption

Why standalone:
- keeps risky scraping isolated from production logic

## Recommended Immediate Order

Implement first:

1. Commit 2
2. Commit 3
3. Commit 4
4. Commit 5
5. Commit 6

Defer until access exists:

6. Commit 7

Only experiment later if necessary:

7. Commit 10

## Bottom Line

The best next move is not scraping FR24 first.

The best next move is:

- normalize GPSJam properly
- enrich it geospatially
- correlate it with Sentinel's own ADS-B/AIS signals
- then add a second external source when you have reliable access

That will give Sentinel a much stronger and more defensible GNSS interference model than relying on any single public map.

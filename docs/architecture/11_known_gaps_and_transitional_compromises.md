# Known Gaps And Transitional Compromises

This page documents important implementation realities that maintainers need to know before changing the system.

## Data model transitions

### `asset_states` still exists

- `asset_states` is still written and still read in some compatibility paths.
- It should be treated as a migration-era compatibility cache, not the target fused-state model.

### Fallback behavior still exists in live routes

- [api/routers/tracks.py](/Users/JoelN/Coding/sentinel/api/routers/tracks.py) still contains fallback behavior between:
  - `asset_current_state`
  - `asset_states`
  - `track_events`

This means:

- live summaries can become approximations if fused state is empty
- history and live semantics are not fully isolated in every read path

## Overview implementation limits

- [api/routers/overview.py](/Users/JoelN/Coding/sentinel/api/routers/overview.py) still uses an in-process cache
- cache behavior is not yet distributed or shared across replicas
- some overview sections are still more approximate than dedicated operational read models would be

## Frontend architectural compromises

- Sentinel is intentionally hybrid:
  - Zustand for operational state
  - React Query for fetches
  - websocket deltas for live events
- this is practical, but it means state ownership can be spread across multiple layers

## Live map sensitivity

- `MapCanvas`, `SourcePanel`, and websocket orchestration are still the most behavior-sensitive parts of the UI
- performance work and compiler-readiness work are intentionally more conservative there than in overview/table/detail surfaces

## Enrichment fragility

Some enrichment sources are best-effort:

- MarineTraffic public-page scraping
- ADSBx binCraft cookies/session bootstrap
- optional N2YO or SatNOGS supplemental lookups

These should not be documented as fully reliable operational data sources.

## Domain modeling unevenness

- Air and Maritime behave most like traditional moving-track domains
- Space combines live propagation with heavy catalog enrichment
- GPSJam, Infra, and ACLED often pass through track-compatible events mainly for UI compatibility while also writing normalized disruption state

That means “track event” is not an identical semantic concept in every domain.

## Infra geospatial weakness

- Infra is currently the weakest geospatially enriched domain
- many infra events are represented as centroids or coarse jurisdictions instead of true service-area polygons

This should be called out because it affects map interpretation and impact analysis.

## WebSocket scaling limitation

- [api/routers/ws.py](/Users/JoelN/Coding/sentinel/api/routers/ws.py) tracks active connections in process memory
- multi-replica fan-out would need shared coordination

## Documentation rule

These gaps should be referenced from other pages where relevant, not hidden in a single appendix page.

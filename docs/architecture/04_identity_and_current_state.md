# Identity And Current State

Sentinel is in the middle of a deliberate shift from feed-local track identity to canonical entity-based state.

The current implementation spans both models:

- canonical identity and fused state
- feed-scoped state
- legacy compatibility state

Primary code paths:

- schema: [docker/timescaledb/init.sql](/Users/JoelN/Coding/sentinel/docker/timescaledb/init.sql)
- collector write path: [collectors/base/base_collector.py](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py)
- live/read path: [api/routers/tracks.py](/Users/JoelN/Coding/sentinel/api/routers/tracks.py)

## Identity layers

### Canonical entity

`entities`

- one durable internal `entity_id`
- typed as `asset`, `disruption`, or future entity categories
- may carry a human display name and generic metadata

### External identifiers

`entity_identifiers`

- stores identifiers such as:
  - ICAO24
  - MMSI
  - IMO
  - NORAD ID
  - registration
  - feed-local track identifiers
- supports first/last seen tracking and confidence

### Feed-local resolution

`asset_identity_resolutions`

- maps `(source_domain, source_feed, track_id)` to `entity_id`
- represents the persisted result of identity resolution performed in [BaseCollector._resolve_asset_entity_id](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py)

Current behavior:

- deterministic when no stronger identifier match exists
- upgraded when candidate identifiers match an existing canonical entity

## Motion/state layers

### Raw normalized evidence

`asset_observations`

- one row per normalized source observation
- closest thing to source evidence retained in the core tracking path
- carries confidence and raw/normalized payloads

### Historical track sample

`track_events`

- time-series history used for replay, export, and historical views
- linked back to `entity_id`
- linked to source observation via `source_observation_id`

### Feed-scoped latest state

`asset_source_states`

- one row per `(source_domain, source_feed, track_id)`
- used as the per-feed latest view
- lets Sentinel compare conflicting source states before fusion

### Fused canonical current state

`asset_current_state`

- one row per canonical `entity_id`
- intended live-state source of truth
- contains winning source feed, winning event, confidence, and fused state fields

Fusion behavior in the current code:

- [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) writes feed-scoped state first
- then selects from `asset_source_states` to upsert `asset_current_state`
- routes prefer `asset_current_state` for live queries

### Legacy compatibility state

`asset_states`

- retained because older parts of the app and migration-era readers still assume `(source_domain, track_id)` current state
- should be documented as compatibility storage, not the target long-term model

## Current source-of-truth guidance

Use:

- `asset_current_state` for fused live state
- `asset_source_states` for feed-specific latest state
- `track_events` for replay/history
- `asset_observations` for evidence/audit

Treat as transitional:

- `asset_states`

## Route behavior today

Live routes in [api/routers/tracks.py](/Users/JoelN/Coding/sentinel/api/routers/tracks.py):

- prefer `asset_current_state`
- may fall back to older/live-history approximations where current-state data is unavailable

That fallback behavior should be explicitly documented because it affects:

- header counts
- overview counts
- live map/detail behavior during ingestion failures or schema migration gaps

## Collector identity lifecycle

Current write order in [BaseCollector._write_to_db](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py):

1. resolve or create `entity_id`
2. ensure `entities` row exists
3. write `entity_identifiers`
4. write assertions and enrichments
5. write `asset_observations`
6. write `track_events`
7. upsert `asset_source_states`
8. upsert `asset_states`
9. derive and upsert `asset_current_state`

## Disruption identity

Disruptions follow the same entity pattern:

- canonical entity row in `entities`
- current disruption state in `disruption_events`
- evidence history in `disruption_observations`

This means the entity model is shared by both moving assets and non-track operational phenomena.

## Recommended diagrams for this page

- identity table relationship diagram
- asset state lifecycle sequence
- current-state precedence diagram:
  - `asset_observations` -> `track_events`
  - `asset_source_states` -> `asset_current_state`
  - `asset_states` marked legacy

## Explicit caveats

- Some current-state behavior is still dependent on collector correctness and write ordering.
- Some live summaries still use fallback logic when fused state is missing.
- `asset_states` existing alongside `asset_current_state` can be misleading unless clearly documented as transitional.

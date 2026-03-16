# Data Model

The schema is initialized in [docker/timescaledb/init.sql](/Users/JoelN/Coding/sentinel/docker/timescaledb/init.sql). Sentinel's model is built around a layered split between:

- canonical entities and identifiers
- raw normalized observations
- canonical historical track samples
- feed-scoped current state
- fused current state
- disruptions and impact relationships
- analyst workflow tables
- domain-specific enrichment tables

## Schema groups

### 1. Canonical entity model

Core tables:

- `entities`
- `entity_identifiers`
- `asset_identity_resolutions`
- `entity_assertions`
- `entity_impacts`
- `entity_enrichments`
- `sources`
- `source_runs`

Purpose:

- represent durable identity
- store external identifiers and feed-specific resolution
- track source registry and collector health
- store stable metadata and conflicts separately from live motion state

### 2. Asset history and current state

Core tables:

- `asset_observations`
- `track_events`
- `asset_source_states`
- `asset_current_state`
- `asset_states`

Purpose:

- `asset_observations`: raw normalized evidence
- `track_events`: historical track samples for replay/history
- `asset_source_states`: per-feed latest state
- `asset_current_state`: fused best-known latest state per canonical entity
- `asset_states`: legacy compatibility current-state cache

### 3. Analyst workflow

Core tables:

- `annotations`
- `regions_of_interest`
- `alert_rules`
- `alert_events`

Purpose:

- analyst-authored annotations and AOIs
- alert rules and resulting alert events

### 4. Disruption and environmental model

Core tables:

- `disruption_events`
- `disruption_observations`
- `entity_impacts`

Purpose:

- represent non-track operational phenomena such as GPS interference, outages, hazards, and related spatial effects

### 5. Space-specific model

Core tables:

- `satellite_catalog`
- `satellite_tles`
- `space_watchlist_status`

Purpose:

- maintain satellite metadata, TLE history, and curated watchlist state

### 6. Aggregate and telemetry support

Core views:

- `track_events_1min`
- `track_events_hourly`

Purpose:

- power operational summaries and historical trend surfaces

## Time-series vs relational storage

Timescale hypertables:

- `track_events`
- `asset_observations`
- `entity_assertions`
- `alert_events`
- `disruption_observations`

Relational tables:

- `entities`
- `entity_identifiers`
- `asset_identity_resolutions`
- `asset_source_states`
- `asset_current_state`
- `asset_states`
- `entity_enrichments`
- `entity_impacts`
- `satellite_catalog`
- `space_watchlist_status`
- `annotations`
- `regions_of_interest`
- `alert_rules`
- `disruption_events`
- `sources`
- `source_runs`

## Geometry model

Point geometry:

- `track_events.position`
- `asset_observations.position`
- `asset_source_states.position`
- `asset_current_state.position`
- `asset_states.position`
- `annotations.position`
- `disruption_events.centroid`

General geometry:

- `disruption_events.geometry`

Polygon geometry:

- `regions_of_interest.geometry`

PostGIS use:

- GIST indexes back bbox, AOI, and intersection queries
- disruptions can use point, polygon, or other geometry types in a single column

## Temporal model

Observed/evidence time:

- `asset_observations.observed_at`
- `track_events.timestamp`
- `entity_assertions.asserted_at`
- `disruption_observations.observed_at`

Current-state time:

- `asset_source_states.last_seen`
- `asset_current_state.last_seen`
- `asset_states.last_seen`

Validity windows:

- `disruption_events.valid_from`
- `disruption_events.valid_to`
- `disruption_events.expires_at`

Ingestion time:

- `asset_observations.ingested_at`
- `track_events.ingested_at`
- `satellite_tles.ingested_at`

## Source-of-truth guidance

Preferred current source of truth:

- identity: `entities` and `entity_identifiers`
- fused live state: `asset_current_state`
- per-feed live state: `asset_source_states`
- historical motion: `track_events`
- raw normalized evidence: `asset_observations`
- disruptions: `disruption_events` + `disruption_observations`

Compatibility/transitional:

- `asset_states` remains present for older readers and migration-era fallbacks

## Important implementation caveats

- The codebase still contains some fallback logic from `asset_current_state` to older sources in [api/routers/tracks.py](/Users/JoelN/Coding/sentinel/api/routers/tracks.py).
- `asset_states` should be documented as a compatibility layer, not the target long-term canonical model.
- Some route summaries still approximate “live” counts from history when fused current-state data is unavailable.

## Recommended tables/diagrams for this page

- entity model table map
- tracking/current-state table map
- disruption model table map
- space-specific table map

# Collector Pipeline

All collectors share the runtime and persistence pipeline implemented in [collectors/base/base_collector.py](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py).

This shared pipeline is the main reason Sentinel can ingest multiple domains without duplicating database logic in every collector.

## Shared collector contract

Each collector:

- inherits from `BaseCollector`
- implements `fetch() -> list[dict]`
- emits normalized `TrackEventDict`-shaped events

BaseCollector handles:

- startup and connection pools
- source registration
- source run tracking
- retry/backoff
- entity resolution
- multi-table writes
- Redis publication

## Runtime lifecycle

At startup:

1. connect to PostgreSQL
2. ensure storage model exists
3. register source in `sources`
4. create/update `source_runs`
5. connect to Redis

At each poll:

1. call collector-specific `fetch()`
2. normalize returned events
3. split events into:
   - historical track events
   - current-state events
   - live publish events
   - disruption events
   - disruption observations
4. write DB batch
5. publish Redis live events
6. update source run telemetry

## Database write pipeline

The central write path is [BaseCollector._write_to_db](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py).

Key steps:

1. resolve `entity_id` for asset events
2. ensure `entities` rows exist
3. upsert `entity_identifiers`
4. insert `entity_assertions` when stable fields exist
5. upsert `entity_enrichments`
6. insert `asset_observations`
7. insert `track_events`
8. upsert `asset_source_states`
9. upsert compatibility `asset_states`
10. upsert `asset_current_state`
11. upsert `disruption_events`
12. insert `disruption_observations`
13. derive and write `entity_impacts`

## Redis publication

Published stream:

- key: `sentinel:track_events`

Purpose:

- live fan-out to websocket clients via [api/routers/ws.py](/Users/JoelN/Coding/sentinel/api/routers/ws.py)

Important note:

- Redis carries live deltas only
- historical truth remains in TimescaleDB

## Source registry and health

Tables:

- `sources`
- `source_runs`

Tracked attributes include:

- source feed
- source domain
- collector name
- run status
- last success time
- last error
- batches and events written

These power:

- overview ops panels
- source health diagnostics
- ingest lag reporting

## Disruption handling

Collectors can embed disruption metadata inside event metadata under internal keys.

BaseCollector then normalizes those into:

- `disruption_events`
- `disruption_observations`
- optional `entity_impacts`

This lets non-track domains share the same collector runtime while still landing in a distinct operational model.

## Source-specific override pattern

Most collectors do not need collector-specific SQL because the shared model covers:

- track history
- current state
- identity
- enrichments
- disruptions

Collectors with domain-specific storage extend this with additional writes:

- Space:
  - `satellite_catalog`
  - `satellite_tles`
  - `space_watchlist_status`
- AIS:
  - best-effort MarineTraffic enrichment merged through shared enrichment paths

## Failure model

If `fetch()` fails:

- the collector logs an error
- source run error is updated
- exponential backoff is applied
- no DB write occurs for that poll

If DB write fails:

- the batch fails and the collector retries on the next cycle
- missing live state can cascade into UI issues because `asset_current_state` will not update

## Recommended diagrams for this page

- collector lifecycle sequence diagram
- write pipeline diagram from normalized event to DB tables
- Redis live fan-out diagram

## Explicit caveats

- Because multiple write layers depend on identity resolution, collector ordering bugs can leave `asset_current_state` empty even when raw history exists.
- Best-effort enrichments should be documented as non-blocking paths, not guaranteed ingestion paths.

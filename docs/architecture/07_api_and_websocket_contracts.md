# API And WebSocket Contracts

The API is wired in [api/main.py](/Users/JoelN/Coding/sentinel/api/main.py). Sentinel uses REST for summary/detail/history queries and a websocket for live delta fan-out.

## Router groups

### Health and capability

- [api/routers/health.py](/Users/JoelN/Coding/sentinel/api/routers/health.py)

Purpose:

- service liveness
- capability flags such as overview support

Primary frontend consumer:

- [frontend/src/App.tsx](/Users/JoelN/Coding/sentinel/frontend/src/App.tsx)

### Tracks

- [api/routers/tracks.py](/Users/JoelN/Coding/sentinel/api/routers/tracks.py)

Purpose:

- live summary
- live detail
- historical track queries
- export
- domain status helpers
- maritime enrichment fetches

Key table dependencies:

- `asset_current_state`
- `asset_source_states`
- `track_events`
- `asset_states`
- `entity_enrichments`

### Satellites

- [api/routers/satellites.py](/Users/JoelN/Coding/sentinel/api/routers/satellites.py)

Purpose:

- satellite catalog details
- TLE history
- space watchlist dashboard

Key table dependencies:

- `satellite_catalog`
- `satellite_tles`
- `space_watchlist_status`

### Disruptions

- [api/routers/disruptions.py](/Users/JoelN/Coding/sentinel/api/routers/disruptions.py)

Purpose:

- normalized disruption query
- disruption source status
- disruption dashboard

Key table dependencies:

- `disruption_events`
- `disruption_observations`
- `asset_current_state`

### Alerts

- [api/routers/alerts.py](/Users/JoelN/Coding/sentinel/api/routers/alerts.py)

Purpose:

- alert rule CRUD
- recent alert events
- acknowledge action

Key table dependencies:

- `alert_rules`
- `alert_events`

### Overview

- [api/routers/overview.py](/Users/JoelN/Coding/sentinel/api/routers/overview.py)

Purpose:

- overview landing payloads
- split core vs pivots responses
- section-level status metadata

Key table dependencies:

- `asset_current_state`
- `track_events`
- `alert_events`
- `sources`
- `source_runs`
- disruption tables

### Telemetry

- [api/routers/telemetry.py](/Users/JoelN/Coding/sentinel/api/routers/telemetry.py)

Purpose:

- API request performance snapshot
- unified domain telemetry dashboard

### Annotations

- [api/routers/annotations.py](/Users/JoelN/Coding/sentinel/api/routers/annotations.py)

Purpose:

- analyst annotation CRUD

## WebSocket

Route:

- `/ws/live`

Implementation:

- [api/routers/ws.py](/Users/JoelN/Coding/sentinel/api/routers/ws.py)

Flow:

1. browser opens websocket
2. server accepts connection and sends `connected`
3. server reads Redis stream `sentinel:track_events`
4. server batches events and pushes `track_events` messages
5. frontend ingests deltas into stores

Current limitations:

- connection manager is in-process only
- multi-replica websocket coordination would require Redis pub/sub or equivalent shared fan-out

## Frontend contract usage

REST consumers:

- [frontend/src/App.tsx](/Users/JoelN/Coding/sentinel/frontend/src/App.tsx)
- [frontend/src/components/AssetCard.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/AssetCard.tsx)
- [frontend/src/components/TrackBrowserView.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/TrackBrowserView.tsx)

Websocket consumer:

- [frontend/src/hooks/useLiveStream.ts](/Users/JoelN/Coding/sentinel/frontend/src/hooks/useLiveStream.ts)

## Response categories

Live:

- `/api/tracks/live`
- `/ws/live`

Historical:

- track history and export endpoints in [api/routers/tracks.py](/Users/JoelN/Coding/sentinel/api/routers/tracks.py)
- TLE history in [api/routers/satellites.py](/Users/JoelN/Coding/sentinel/api/routers/satellites.py)

Operational summary:

- `/api/overview/*`
- `/api/telemetry/*`
- dashboard routes under disruptions/satellites/tracks

## Recommended diagrams/tables for this page

- REST route group table
- websocket sequence diagram
- UI surface -> route dependency matrix

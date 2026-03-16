# System Overview

Sentinel is a multi-domain geospatial intelligence stack with five primary runtime layers:

1. React/TypeScript frontend
2. FastAPI application layer
3. PostgreSQL/PostGIS/TimescaleDB storage
4. Redis live fan-out
5. Collector services per source/domain

Core entry points:

- frontend shell: [frontend/src/App.tsx](/Users/JoelN/Coding/sentinel/frontend/src/App.tsx)
- API application: [api/main.py](/Users/JoelN/Coding/sentinel/api/main.py)
- base collector runtime: [collectors/base/base_collector.py](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py)
- schema bootstrap: [docker/timescaledb/init.sql](/Users/JoelN/Coding/sentinel/docker/timescaledb/init.sql)
- service composition: [docker-compose.yml](/Users/JoelN/Coding/sentinel/docker-compose.yml)

## Runtime topology

Frontend:

- renders Overview, Map, and Track Browser workspaces
- uses React Query for API fetches
- uses Zustand for operational UI state
- consumes websocket deltas for live updates

API:

- exposes REST endpoints under `/api/*`
- exposes live websocket at `/ws/live`
- reads from TimescaleDB/PostGIS
- records request performance in [api/perf.py](/Users/JoelN/Coding/sentinel/api/perf.py)
- runs a background alert evaluator on startup

Database:

- stores canonical entities, identifiers, enrichments, assertions, and impacts
- stores historical observations and track samples in hypertables
- stores fused current state and feed-scoped current state
- stores disruptions, alerts, annotations, satellite metadata, and aggregate views

Redis:

- receives live event payloads from collectors
- feeds websocket fan-out via [api/routers/ws.py](/Users/JoelN/Coding/sentinel/api/routers/ws.py)

Collectors:

- fetch source-specific data on independent schedules
- normalize source payloads into a shared event shape
- write history/current state into TimescaleDB
- publish live deltas into Redis

## High-level data flow

Collector flow:

1. Source collector fetches external data.
2. Source payload is normalized into `TrackEventDict`-like events.
3. [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) resolves entity identity and source metadata.
4. Events are written to:
   - `asset_observations`
   - `track_events`
   - `asset_source_states`
   - `asset_current_state`
   - disruption tables when applicable
5. Live event payloads are published to Redis stream `sentinel:track_events`.

Frontend flow:

1. Frontend loads overview or workspace data via REST.
2. Frontend opens `/ws/live` for live delta batches.
3. Zustand stores hold:
   - map and playback state
   - viewport asset state
   - selected asset/detail context
   - alert and investigation state
4. UI surfaces consume those stores and query results:
   - overview cards
   - map layers and panels
   - browser/table views
   - asset detail card

## Workspace model

Current top-level workspaces in [frontend/src/App.tsx](/Users/JoelN/Coding/sentinel/frontend/src/App.tsx):

- `overview`
- `map`
- `table`

Operationally:

- `overview` is the summary-first landing surface
- `map` is the tactical geospatial workspace
- `table` is the dense browsing and correlation surface

## Recommended diagrams for this page

- system context diagram:
  - frontend
  - API
  - Redis
  - TimescaleDB/PostGIS
  - collector services
- high-level ingest-to-UI sequence:
  - collector -> DB/Redis -> API -> frontend

## Transitional notes

- Sentinel is currently a hybrid operational SPA, not a server-rendered frontend.
- The architecture includes both a newer canonical entity/current-state model and some compatibility-era tables and fallback behavior.
- Some external enrichments are best-effort rather than guaranteed operational feeds.

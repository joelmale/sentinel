# Runtime Components

This page describes Sentinel's major runtime components and their responsibilities.

Primary composition points:

- [docker-compose.yml](/Users/JoelN/Coding/sentinel/docker-compose.yml)
- [api/main.py](/Users/JoelN/Coding/sentinel/api/main.py)
- [frontend/src/App.tsx](/Users/JoelN/Coding/sentinel/frontend/src/App.tsx)

## Frontend

Location:

- `frontend/`

Responsibilities:

- render Overview, Map, and Track Browser workspaces
- orchestrate live and historical fetches
- consume websocket deltas
- manage interactive operational state

Important runtime modules:

- root shell: [frontend/src/App.tsx](/Users/JoelN/Coding/sentinel/frontend/src/App.tsx)
- map workspace: [frontend/src/components/MapCanvas.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/MapCanvas.tsx)
- overview: [frontend/src/components/OverviewPage.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/OverviewPage.tsx)
- table/browser: [frontend/src/components/TrackBrowserView.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/TrackBrowserView.tsx)
- live websocket hook: [frontend/src/hooks/useLiveStream.ts](/Users/JoelN/Coding/sentinel/frontend/src/hooks/useLiveStream.ts)

## API

Location:

- `api/`

Responsibilities:

- route registration and application lifecycle
- DB and Redis access
- REST and websocket endpoints
- alert evaluator startup
- request performance telemetry

Entry point:

- [api/main.py](/Users/JoelN/Coding/sentinel/api/main.py)

Key runtime responsibilities:

- DB pool startup/shutdown via [api/db/connection.py](/Users/JoelN/Coding/sentinel/api/db/connection.py)
- Redis pool startup/shutdown via [api/redis_client.py](/Users/JoelN/Coding/sentinel/api/redis_client.py)
- HTTP request timing via [api/perf.py](/Users/JoelN/Coding/sentinel/api/perf.py)
- background alert evaluator via [api/alert_evaluator.py](/Users/JoelN/Coding/sentinel/api/alert_evaluator.py)

## Database

Location:

- TimescaleDB/PostGIS initialized from [docker/timescaledb/init.sql](/Users/JoelN/Coding/sentinel/docker/timescaledb/init.sql)

Responsibilities:

- canonical identity storage
- historical event storage
- current-state storage
- enrichment storage
- disruptions and impacts
- analyst workflow tables
- continuous aggregates

## Redis

Responsibilities:

- receive live event publication from collectors
- provide low-latency stream input to websocket gateway

Important path:

- stream key defined in [collectors/base/base_collector.py](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) and consumed in [api/routers/ws.py](/Users/JoelN/Coding/sentinel/api/routers/ws.py)

## Collectors

Locations:

- `collectors/adsb/`
- `collectors/ais/`
- `collectors/space/`
- `collectors/gpsjam/`
- `collectors/infra/`
- `collectors/acled/`

Shared base:

- [collectors/base/base_collector.py](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py)

Responsibilities:

- poll external sources
- normalize payloads
- write DB batches
- publish live deltas
- update source health tables

## Background and support components

- overview aggregation routes: [api/routers/overview.py](/Users/JoelN/Coding/sentinel/api/routers/overview.py)
- telemetry routes: [api/routers/telemetry.py](/Users/JoelN/Coding/sentinel/api/routers/telemetry.py)
- websocket gateway: [api/routers/ws.py](/Users/JoelN/Coding/sentinel/api/routers/ws.py)
- performance panel/state: [frontend/src/store/usePerfStore.ts](/Users/JoelN/Coding/sentinel/frontend/src/store/usePerfStore.ts)

## Recommended diagram for this page

- service/component diagram showing:
  - browser
  - frontend runtime
  - API
  - Redis
  - DB
  - collectors

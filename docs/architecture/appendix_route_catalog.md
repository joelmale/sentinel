# Route Catalog

Primary router registration happens in [api/main.py](/Users/JoelN/Coding/sentinel/api/main.py).

## Route groups

| Route group | Module | Purpose | Primary consumers |
| --- | --- | --- | --- |
| `/health` | [api/routers/health.py](/Users/JoelN/Coding/sentinel/api/routers/health.py) | health and capability flags | `App.tsx`, ops checks |
| `/api/tracks/*` | [api/routers/tracks.py](/Users/JoelN/Coding/sentinel/api/routers/tracks.py) | live summary/detail, history, export, enrichment helpers | map, browser, asset card |
| `/api/satellites/*` | [api/routers/satellites.py](/Users/JoelN/Coding/sentinel/api/routers/satellites.py) | satellite catalog, TLEs, watchlist | space detail, dashboards |
| `/api/disruptions/*` | [api/routers/disruptions.py](/Users/JoelN/Coding/sentinel/api/routers/disruptions.py) | disruption queries and dashboards | disruption dashboard, map overlays |
| `/api/alerts/*` | [api/routers/alerts.py](/Users/JoelN/Coding/sentinel/api/routers/alerts.py) | alert rules and recent alert events | alert queue, investigation |
| `/api/overview/*` | [api/routers/overview.py](/Users/JoelN/Coding/sentinel/api/routers/overview.py) | overview landing payloads | overview workspace |
| `/api/telemetry/*` | [api/routers/telemetry.py](/Users/JoelN/Coding/sentinel/api/routers/telemetry.py) | API perf and dashboard telemetry | perf panel, domain dashboards |
| `/api/annotations/*` | [api/routers/annotations.py](/Users/JoelN/Coding/sentinel/api/routers/annotations.py) | analyst annotations | annotation UI |
| `/ws/live` | [api/routers/ws.py](/Users/JoelN/Coding/sentinel/api/routers/ws.py) | live delta stream | `useLiveStream` |

## Important live/read distinctions

| Category | Main routes | Backing tables |
| --- | --- | --- |
| Live fused state | `/api/tracks/live` | `asset_current_state`, `asset_source_states`, fallback compatibility paths |
| Historical track data | history/export routes in tracks router | `track_events` |
| Static/semi-static enrichment | satellites and maritime enrichment routes | `satellite_catalog`, `satellite_tles`, `entity_enrichments` |
| Disruption state | `/api/disruptions/*` | `disruption_events`, `disruption_observations` |
| Overview summaries | `/api/overview/*` | mixed summaries from live state, alerts, sources, disruptions |

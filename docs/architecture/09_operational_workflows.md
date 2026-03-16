# Operational Workflows

This page maps major Sentinel UI workflows to the routes, stores, and tables that support them.

Primary frontend orchestration:

- [frontend/src/App.tsx](/Users/JoelN/Coding/sentinel/frontend/src/App.tsx)

## Overview workflow

UI:

- [frontend/src/components/OverviewPage.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/OverviewPage.tsx)

Flow:

1. frontend checks `/health` capabilities
2. frontend loads overview core payload
3. frontend lazy-loads overview pivots
4. user opens map, browser, or investigation from overview actions

Primary backend routes:

- [api/routers/health.py](/Users/JoelN/Coding/sentinel/api/routers/health.py)
- [api/routers/overview.py](/Users/JoelN/Coding/sentinel/api/routers/overview.py)

Primary tables:

- `asset_current_state`
- `track_events`
- `alert_events`
- `sources`
- `source_runs`
- disruption tables

## Live map workflow

UI:

- [frontend/src/components/MapCanvas.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/MapCanvas.tsx)
- [frontend/src/components/SourcePanel.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/SourcePanel.tsx)
- [frontend/src/components/TimelinePanel.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/TimelinePanel.tsx)
- [frontend/src/components/AssetCard.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/AssetCard.tsx)

Flow:

1. `useMapStore` controls viewport, layers, playback, and selection
2. `App.tsx` fetches scoped live data based on viewport and domain scope
3. websocket deltas arrive via `useLiveStream`
4. viewport assets and live summary are stored in `useLiveDataStore`
5. `MapCanvas` renders current visible assets and disruptions
6. `SourcePanel` manages scope narrowing, shortlist, and filters
7. selecting an asset opens `AssetCard`

Primary routes:

- `/api/tracks/live`
- `/api/disruptions/events`
- `/ws/live`

Primary state:

- `useMapStore`
- `useLiveDataStore`
- `usePerfStore`

## Track Browser workflow

UI:

- [frontend/src/components/TrackBrowserView.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/TrackBrowserView.tsx)

Flow:

1. browser opens with an asset set already fetched by `App.tsx`
2. local filters narrow the in-memory result set
3. selecting a row updates the selected asset and flies the map if coordinates exist
4. domain-specific detail queries fetch:
   - satellite catalog/TLE data
   - other enrichments as needed

Primary data dependencies:

- viewport/live asset set from `useLiveDataStore`
- selected asset state from `useMapStore`
- satellite detail routes for space assets

## Asset detail workflow

UI:

- [frontend/src/components/AssetCard.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/AssetCard.tsx)

Flow:

1. selected asset comes from `useMapStore`
2. live detail comes from `useLiveDataStore`
3. domain-specific enrichment is fetched on demand:
   - satellites: catalog and TLEs
   - maritime: MarineTraffic-backed enrichment
   - air: aircraft photo lookup
4. card actions can:
   - focus map
   - enter replay window
   - export history
   - open external search

Primary backend routes:

- tracks live/detail/export paths
- satellite routes
- maritime enrichment route in tracks router

## Alert and investigation workflow

UI:

- [frontend/src/components/AlertQueuePanel.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/AlertQueuePanel.tsx)
- [frontend/src/components/InvestigationPanel.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/InvestigationPanel.tsx)

Flow:

1. alert rules fire into `alert_events`
2. frontend receives live alerts through store updates and historical alert polling
3. alert queue triages alerts into:
   - new
   - acknowledged
   - investigating
   - closed
4. `openInvestigation()` pivots the workspace:
   - map focus
   - asset card open
   - replay window around alert
   - investigation context set in store
5. investigation panel loads nearby disruptions and annotations

Primary state:

- `pendingAlerts`
- `investigationContext`
- playback state
- selected asset state

## Recommended diagrams for this page

- overview action flow
- live map event loop
- investigation pivot sequence
- asset detail dependency diagram

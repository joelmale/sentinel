# Frontend State And Data Flow

Sentinel's frontend uses a hybrid model:

- Zustand for long-lived operational state
- React Query for network fetches and caching
- websocket deltas for live updates

Primary integration point:

- [frontend/src/App.tsx](/Users/JoelN/Coding/sentinel/frontend/src/App.tsx)

## Stores

### `useMapStore`

Location:

- [frontend/src/store/useMapStore.ts](/Users/JoelN/Coding/sentinel/frontend/src/store/useMapStore.ts)

Responsibilities:

- viewport and playback state
- layer visibility
- selected asset and detail context
- alert and investigation context
- track-panel scope state
- pinned tracks and group filters
- map presentation settings

This is the main operational store for the map workspace.

### `useLiveDataStore`

Location:

- [frontend/src/store/useLiveDataStore.ts](/Users/JoelN/Coding/sentinel/frontend/src/store/useLiveDataStore.ts)

Responsibilities:

- global live summary
- viewport asset cache
- UI-delayed summary and viewport snapshots
- selected asset detail
- space aggregate payloads

This store acts as the live data buffer between fetch/websocket flows and UI surfaces.

### `usePerfStore`

Location:

- [frontend/src/store/usePerfStore.ts](/Users/JoelN/Coding/sentinel/frontend/src/store/usePerfStore.ts)

Responsibilities:

- request metrics
- websocket metrics
- map metrics
- API perf snapshots
- perf panel state

## WebSocket flow

Client hook:

- [frontend/src/hooks/useLiveStream.ts](/Users/JoelN/Coding/sentinel/frontend/src/hooks/useLiveStream.ts)

Behavior:

- open `/ws/live`
- auto-reconnect with exponential backoff
- forward parsed messages to caller
- record websocket metrics in `usePerfStore`

`App.tsx` batches websocket events before applying them to stores to avoid high-frequency UI churn.

## React Query usage

Primary query orchestration is in [frontend/src/App.tsx](/Users/JoelN/Coding/sentinel/frontend/src/App.tsx).

Key fetch categories:

- health/capability
- live summary
- viewport/domain-scoped live detail
- overview core and pivots
- selected asset history/detail
- domain dashboards
- telemetry/perf

Component-local queries exist in:

- [frontend/src/components/AssetCard.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/AssetCard.tsx)
- [frontend/src/components/TrackBrowserView.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/TrackBrowserView.tsx)

Examples:

- satellite catalog/TLE detail
- maritime enrichment pull
- aircraft photo lookup

## Workspace connectivity

### Overview

- rendered by [frontend/src/components/OverviewPage.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/OverviewPage.tsx)
- driven by overview REST payloads
- minimal websocket dependence

### Map

- rendered by [frontend/src/components/MapCanvas.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/MapCanvas.tsx)
- driven by:
  - `useMapStore`
  - `useLiveDataStore`
  - websocket deltas
  - viewport/domain-scoped live queries

### Track Browser

- rendered by [frontend/src/components/TrackBrowserView.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/TrackBrowserView.tsx)
- consumes loaded asset sets and on-demand detail queries

### Asset detail

- rendered by [frontend/src/components/AssetCard.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/AssetCard.tsx)
- combines:
  - selected live asset state
  - domain-specific enrichment queries
  - replay/export actions through store state

## Data ownership guidance

Use Zustand for:

- state that multiple operational surfaces mutate or coordinate
- playback state
- selection and investigation context
- layer/filter state

Use React Query for:

- fetchable server state
- cacheable detail payloads
- overview and dashboard payloads

Use websocket deltas for:

- live event ingestion only

## Recommended diagrams/tables for this page

- frontend state map:
  - `App.tsx`
  - stores
  - queries
  - websocket hook
  - main UI surfaces
- workspace-to-store dependency matrix

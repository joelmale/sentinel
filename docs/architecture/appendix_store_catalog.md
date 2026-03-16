# Store Catalog

## Zustand stores

| Store | File | Purpose | Main consumers |
| --- | --- | --- | --- |
| `useMapStore` | [frontend/src/store/useMapStore.ts](/Users/JoelN/Coding/sentinel/frontend/src/store/useMapStore.ts) | operational workspace state | `App.tsx`, `MapCanvas`, `SourcePanel`, `AssetCard`, alerts/investigation |
| `useLiveDataStore` | [frontend/src/store/useLiveDataStore.ts](/Users/JoelN/Coding/sentinel/frontend/src/store/useLiveDataStore.ts) | live summary/detail asset buffers | `App.tsx`, `MapCanvas`, `SourcePanel`, browser/detail surfaces |
| `usePerfStore` | [frontend/src/store/usePerfStore.ts](/Users/JoelN/Coding/sentinel/frontend/src/store/usePerfStore.ts) | request/ws/map telemetry | perf panel, app shell |

## Key state categories

`useMapStore`

- viewport
- playback
- layers
- selection
- pinned tracks
- domain scopes
- alert triage
- investigation context
- map presentation settings

`useLiveDataStore`

- `globalSummary`
- `viewportAssets`
- `selectedAssetDetail`
- `spaceAggregates`

`usePerfStore`

- request timing by key
- websocket counters
- map rendering metrics
- API perf snapshot

## Query orchestration

React Query is primarily orchestrated in [frontend/src/App.tsx](/Users/JoelN/Coding/sentinel/frontend/src/App.tsx), with component-local queries in:

- [frontend/src/components/AssetCard.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/AssetCard.tsx)
- [frontend/src/components/TrackBrowserView.tsx](/Users/JoelN/Coding/sentinel/frontend/src/components/TrackBrowserView.tsx)

## WebSocket integration

Hook:

- [frontend/src/hooks/useLiveStream.ts](/Users/JoelN/Coding/sentinel/frontend/src/hooks/useLiveStream.ts)

Primary behavior:

- websocket messages are ingested in `App.tsx`
- batched updates are applied to stores
- `usePerfStore` records connection and message metrics

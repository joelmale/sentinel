# Compiler Readiness Tracker

Goal:

- make the non-map UI compiler-clean first
- avoid `MapCanvas`, `SourcePanel`, and websocket internals for now
- target:
  - `OverviewPage`
  - `AssetCard`
  - `TrackBrowserView`
  - smaller shared UI hooks

## Phase Checklist

- [x] Phase 1: add scoped compiler-readiness lint profile
- [x] Phase 2: clean small UI hooks
- [x] Phase 3: make `OverviewPage` compiler-clean
- [x] Phase 4: make `AssetCard` compiler-clean
- [x] Phase 5: make `TrackBrowserView` compiler-clean
- [x] Phase 6: add compiler-clean CI/local gate
- [x] Phase 7: document exclusions and next frontier

## Commit Log

- Phase 1 complete: scoped compiler-readiness lint profile added for `OverviewPage`, `AssetCard`, `TrackBrowserView`, `useDrag`, `useResize`, and `useResizePanel`
- Phase 2 complete: audited `useDrag`, `useResize`, and `useResizePanel`; no compiler-readiness changes were required
- Phase 3 complete: audited `OverviewPage`; it already passes the scoped compiler-readiness lint profile
- Phase 4 complete: replaced `AssetCard`'s effect-driven aircraft photo state with a query-driven fetch path
- Phase 5 complete: removed effect-driven state syncing from `TrackBrowserView` and derived active selection directly from filtered results
- Phase 6 complete: added `lint:compiler-ready` enforcement to frontend CI
- Phase 7 complete: documented the current clean scope and the intentionally excluded map/live-stream surfaces

## Current Compiler-Clean Scope

- `frontend/src/components/OverviewPage.tsx`
- `frontend/src/components/AssetCard.tsx`
- `frontend/src/components/TrackBrowserView.tsx`
- `frontend/src/hooks/useDrag.ts`
- `frontend/src/hooks/useResize.ts`
- `frontend/src/hooks/useResizePanel.ts`

These files are covered by `npm --prefix frontend run lint:compiler-ready` and by the frontend CI job.

## Intentionally Excluded For Now

- `frontend/src/components/MapCanvas.tsx`
- `frontend/src/components/SourcePanel.tsx`
- websocket and live-stream internals such as `frontend/src/hooks/useLiveStream.ts`

Reason:

- these files still contain render-time impurity, live timing, or high-churn operational state patterns
- forcing them into compiler-ready shape now would mix architectural work into the stable tactical workspace

## Next Frontier

If compiler-readiness work continues, the next likely targets are:

1. `frontend/src/hooks/useLiveStream.ts`
2. map-adjacent orchestration in `frontend/src/App.tsx`
3. carefully scoped cleanup in `frontend/src/components/MapCanvas.tsx`

Those should be done as a separate work block with explicit acceptance that behavior-sensitive live map code is back in scope.

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
- [ ] Phase 6: add compiler-clean CI/local gate
- [ ] Phase 7: document exclusions and next frontier

## Commit Log

- Phase 1 complete: scoped compiler-readiness lint profile added for `OverviewPage`, `AssetCard`, `TrackBrowserView`, `useDrag`, `useResize`, and `useResizePanel`
- Phase 2 complete: audited `useDrag`, `useResize`, and `useResizePanel`; no compiler-readiness changes were required
- Phase 3 complete: audited `OverviewPage`; it already passes the scoped compiler-readiness lint profile
- Phase 4 complete: replaced `AssetCard`'s effect-driven aircraft photo state with a query-driven fetch path
- Phase 5 complete: removed effect-driven state syncing from `TrackBrowserView` and derived active selection directly from filtered results

# React Compiler Strict Tracker

Goal:

- extend the non-map compiler-clean subset to the newer React Compiler purity/static rules
- keep `MapCanvas`, `SourcePanel`, and websocket/live-stream internals out of scope
- target:
  - `OverviewPage`
  - `AssetCard`
  - `TrackBrowserView`
  - smaller shared UI hooks

## Phase Checklist

- [x] Phase 1: add strict compiler purity/static lint profile
- [ ] Phase 2: remove render-time impurity from the subset
- [ ] Phase 3: eliminate effect-driven derived state patterns
- [ ] Phase 4: hoist static component and config definitions
- [ ] Phase 5: normalize event and callback boundaries
- [ ] Phase 6: enforce strict compiler-ready lint in CI/local checks

## Commit Log

- Phase 1 complete: added `lint:compiler-strict` and scoped warning-mode `recommended-latest` React Hooks compiler rules for the existing non-map subset

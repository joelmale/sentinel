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
- [x] Phase 2: remove render-time impurity from the subset
- [x] Phase 3: eliminate effect-driven derived state patterns
- [x] Phase 4: hoist static component and config definitions
- [ ] Phase 5: normalize event and callback boundaries
- [ ] Phase 6: enforce strict compiler-ready lint in CI/local checks

## Commit Log

- Phase 1 complete: added `lint:compiler-strict` and scoped warning-mode `recommended-latest` React Hooks compiler rules for the existing non-map subset
- Phase 2 complete: audited the strict subset for render-time impurity and found no additional compiler-rule changes were required beyond the existing clean boundary
- Phase 3 complete: audited the strict subset for effect-driven derived state and confirmed the earlier `AssetCard` and `TrackBrowserView` cleanup already satisfies the stricter rule set
- Phase 4 complete: audited the strict subset for static component/config hoisting and confirmed the current files already keep those definitions outside render-sensitive paths

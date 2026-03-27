# Sentinel Performance Scaling Plan

**Goal**: Scale Sentinel to 10,000+ live assets while keeping the map responsive and interaction latency predictable.
**Status**: Phase 1 complete; Phase 2 complete in code; Phase 3 in progress; Phase 4 browser-path work partially complete; websocket delta and replica-safe fan-out are in progress
**Last validated against code**: 2026-03-27

This plan is based on the current frontend implementation, not on a hypothetical full-global render model. The map path is already partially bounded by viewport-scoped API queries, so the highest-value work is reducing unnecessary React/Zustand invalidation, cutting layer rebuild scope, and simplifying duplicate store update paths.

---

## Table of Contents

1. [Decision: React vs Preact](#decision-react-vs-preact)
2. [Current Bottlenecks](#current-bottlenecks)
3. [Priority Order](#priority-order)
4. [Phase 1 — Reduce Invalidations](#phase-1--reduce-invalidations)
5. [Phase 2 — Simplify Data Flow](#phase-2--simplify-data-flow)
6. [Phase 3 — Rendering Scalability](#phase-3--rendering-scalability)
7. [Phase 4 — Browser and Backend Scale](#phase-4--browser-and-backend-scale)
8. [Deprioritized or Rejected Changes](#deprioritized-or-rejected-changes)
9. [Test Strategy](#test-strategy)
10. [Performance Targets](#performance-targets)
11. [Risk Register](#risk-register)

---

## Decision: React vs Preact

**Decision: stay on React. Do not migrate to Preact.**

Why:

- The map hot path is deck.gl/WebGL plus JS data preparation, not React DOM diffing.
- The biggest current cost is broad store invalidation, repeated array derivation, and layer object churn.
- `@deck.gl/react` is built and validated against React.
- A Preact migration adds compatibility risk without addressing the confirmed bottlenecks.

This project should spend engineering time on render-path architecture, not framework substitution.

---

## Current Bottlenecks

These are the bottlenecks confirmed in the current codebase.

| # | Bottleneck | Where | Why it matters |
|---|---|---|---|
| 1 | Broad Zustand subscriptions | `MapCanvas.tsx`, `SourcePanel.tsx`, other panels | Heavy components subscribe to the entire store and re-render on unrelated state changes |
| 2 | Monolithic layer build | `MapCanvas.tsx` | Static and domain-specific deck.gl layers rebuild together |
| 3 | Duplicate `Map` cloning and mirrored stores | `useMapStore.ts`, `useLiveDataStore.ts` | Asset updates clone `Map`s repeatedly and fan out across multiple stores |
| 4 | Trail derivation on render path | `MapCanvas.tsx`, `useMapStore.ts` | Trails are re-filtered and re-mapped per domain during layer construction |
| 5 | Browser path fetches full live datasets and filters client-side | `App.tsx`, `TrackBrowserView.tsx` | Table view scales poorly even though the DOM is paginated |
| 6 | Optional future scale work | worker, LOD, backend deltas | Valuable later, but not first-order fixes for the current code |

Important context:

- `MapCanvas` renders from `viewportAssets`, not directly from the entire global `liveAssets` map.
- The viewport asset set is already constrained by `bbox` and domain-scope queries in `App.tsx`.
- This makes in-map spatial indexing less urgent than reducing re-renders and duplicated derivation.

---

## Priority Order

This is the updated implementation order.

| Priority | Change | Effort | Expected impact |
|---|---|---|---|
| 1 | Replace broad store subscriptions with selectors | Low | Cuts avoidable renders across the heaviest components |
| 2 | Split `deckLayerBuild` into static and domain-scoped memos | Medium | Stops static layer rebuilds during live updates |
| 3 | Reduce duplicate asset copies and `Map` cloning in stores | Medium | Lowers update cost and store fan-out |
| 4 | Move trail derivation off the render path as much as possible | Medium | Reduces repeated allocations in map updates |
| 5 | Add focused browser/table scaling work | Medium | Prevents the non-map path from becoming the next bottleneck |
| 6 | Add LOD and worker-based processing | High | Best path for 10k+ and bursty streams after the basics are fixed |
| 7 | Add backend delta payloads and multi-replica WS broadcast | Medium | Important for throughput, but not the first frontend frame-time fix |

---

## Current Implementation Status

Completed in code:

- selector-based Zustand subscriptions for the heaviest map and workspace surfaces
- split `MapCanvas` layer building into static, domain, and disruption memos
- pre-derived per-domain viewport asset arrays for layer factories
- memoized `viewState` and narrowed several remaining non-critical store consumers
- split trail updates from point upserts and throttled trail writes
- removed one extra `uiViewportAssets` clone and batched multi-domain viewport replacement into a single store write
- reduced repeated trail-buffer prefix scans by grouping trail entries once per render
- restored clear ownership of `viewportAssets`: scoped query results determine membership, while websocket updates now refresh only existing viewport members and immediately drop streamed tracks that move out of bounds
- added an explicit low-zoom aggregation pass that renders background Air, Maritime, and Space density as aggregate cells instead of sparse individual-point thinning, while still suppressing low-zoom background trails
- added a worker-backed websocket preprocessing path for event deduplication, viewport membership partitioning, and trail shaping, with a main-thread fallback if worker setup fails
- added opportunistic websocket delta delivery so repeat track updates can ship compact payloads instead of full events when that materially reduces message size
- added a Redis-backed leader-and-pubsub websocket fan-out path so one replica consumes the stream while all replicas can broadcast to their local websocket clients

Still intentionally deferred:

- benchmark-driven replacement of full-`Map` cloning in the stores
- deeper aggregation layers, richer worker preprocessing, and operational visibility around leader handoff / pubsub lag
- automated render-scope and throughput tests, since the frontend still has no dedicated test runner configured

Additional completed work after the original Phase 1/2 pass:

- default live-map scoped queries now apply a 60-minute `last_seen` cutoff via `max_age_minutes=60`, which reduces stale-track clutter on the map without changing broader summary freshness windows
- the track browser now uses a dedicated server-driven query path instead of fetching full live domain datasets into the client
- the browser sidebar summaries are now computed server-side across the full filtered result set rather than the current page sample

---

## Phase 1 — Reduce Invalidations

**Goal**: Stop unrelated state changes from forcing expensive map and panel re-renders.
**Effort**: 2–4 days.
**Status**: Complete in code. Targeted validation is in place via type-check and lint; render-scope tests are still pending.

### 1.1 Convert heavy Zustand consumers to narrow selectors

**Files**:

- `frontend/src/components/MapCanvas.tsx`
- `frontend/src/components/SourcePanel.tsx`
- `frontend/src/components/AlertQueuePanel.tsx`
- `frontend/src/components/InvestigationPanel.tsx`

**Problem**:

These components currently destructure from `useMapStore()` without a selector, which subscribes them to the entire store. Any store write can invalidate them.

**Outcome**:

- Replace whole-store reads with field-level selectors.
- Use `zustand/shallow` where grouped selection is appropriate.
- Split action selectors from data selectors so stable action references do not drag data dependencies with them.

Example:

```typescript
const {
  layers,
  trailBuffer,
  selectedTrackId,
  selectedDomain,
} = useMapStore(
  (state) => ({
    layers: state.layers,
    trailBuffer: state.trailBuffer,
    selectedTrackId: state.selectedTrackId,
    selectedDomain: state.selectedDomain,
  }),
  shallow,
)
```

Additional follow-through completed:

- `App.tsx` now uses selector-based subscriptions for both `useMapStore` and `useLiveDataStore`
- smaller interactive surfaces such as `AssetCard`, `TimelinePanel`, `TrackBrowserView`, `UnderseaLandingPointCard`, and `AlertNotification` no longer subscribe to full stores

### 1.2 Split `deckLayerBuild` into smaller memos

**File**: `frontend/src/components/MapCanvas.tsx`

**Problem**:

One memo builds static layers, disruption layers, and all domain layers together.

**Outcome**:

- Extract `staticLayers`
- Extract `maritimeLayers`
- Extract `airLayers`
- Extract `spaceLayers`
- Compose them in one final `allLayers` memo

Keep memo dependencies tight. Static overlays should not rebuild on every asset update.

### 1.3 Pre-derive domain subsets once per render, not inside each layer group

**File**: `frontend/src/components/MapCanvas.tsx`

**Problem**:

The current layer build repeatedly filters `viewportAssets` by domain and focus state inside the large memo.

**Outcome**:

- Derive `airViewportAssets`, `maritimeViewportAssets`, `spaceViewportAssets` in dedicated memos
- Derive `focus` and `background` subsets from those domain arrays once
- Reuse those arrays in layer factories

This is lower risk than immediately changing store shape.

### 1.4 Treat `viewState` memoization as optional cleanup, not a lead task

**File**: `frontend/src/components/MapCanvas.tsx`

`viewState` is now memoized as part of the broader `MapCanvas` memo cleanup.

### Phase 1 commits

```text
perf(frontend): replace broad useMapStore subscriptions with selectors
refactor(frontend): split MapCanvas deck layer build into scoped memos
perf(frontend): precompute domain viewport subsets for layer builders
test(frontend): add selector and layer memo coverage
```

---

## Phase 2 — Simplify Data Flow

**Goal**: Reduce asset update fan-out and duplicate allocation across stores.
**Effort**: 3–5 days.
**Status**: Complete for the current architecture. Remaining work is optional and benchmark-driven if profiling still shows store update cost as a dominant bottleneck.

### 2.1 Audit and reduce duplicate map copies

**Files**:

- `frontend/src/store/useMapStore.ts`
- `frontend/src/store/useLiveDataStore.ts`
- `frontend/src/App.tsx`

**Current shape**:

- `useMapStore.liveAssets`
- `useMapStore.trailBuffer`
- `useLiveDataStore.viewportAssets`
- `useLiveDataStore.uiViewportAssets`

The current path clones and mirrors asset state multiple times.

**Outcome**:

- Define clear ownership:
  - `viewportAssets` should remain the render source for the map
  - `liveAssets` should exist only if panels actually need non-viewport coverage
- Re-evaluate whether `uiViewportAssets` needs to be a full cloned `Map`, or whether the throttled UI path can instead use a versioned snapshot or derived array
- Avoid duplicating the same asset set in multiple stores when one source of truth is sufficient

Implemented so far:

- `uiViewportAssets` now reuses the latest `viewportAssets` map reference on sync instead of cloning
- `App.tsx` replaces Air/Maritime/Space viewport results in one `replaceViewportAssetDomains` store write instead of three sequential writes
- websocket refreshes now only mutate tracks that are already members of the current viewport-scoped result set
- websocket updates that move a currently visible track outside the current bounds now remove it from `viewportAssets` immediately instead of waiting for the next poll

### 2.2 Replace full-map cloning with a safer mutation strategy

**Files**:

- `frontend/src/store/useMapStore.ts`
- `frontend/src/store/useLiveDataStore.ts`

**Problem**:

Each upsert clones the whole `Map`, even for small batches.

**Remaining work**:

- Benchmark before choosing a replacement
- Prefer one of:
  - a mutable backing cache plus version counter
  - partitioned maps by domain
  - an Immer-backed approach, only if benchmarks show it helps with current `Map` usage

**Recommendation**:

Do not assume `Record<string, ...>` is automatically better. The shape change should be justified by benchmark results, not style preference.

### 2.3 Separate trail maintenance from general asset upsert concerns

**Files**:

- `frontend/src/store/useMapStore.ts`
- `frontend/src/App.tsx`

**Problem**:

`upsertAssets` updates both live assets and trail buffers in the same hot path.

**Outcome**:

- Split trail writes into an explicit trail update path
- Allow trails to run at a lower cadence than point positions if needed
- Pre-separate trails by domain if that materially reduces render work

Implemented so far:

- trail writes now use a dedicated `appendTrailPoints` path
- live point upserts still happen per frame batch, while trail writes are throttled
- `MapCanvas` now groups trail entries by domain once before deriving visible trails

### 2.4 Keep map-specific filtering where it belongs

The current plan should not move every filter into the store immediately. Some filters are view-specific and should stay close to the map. First reduce redundant derivation and subscription churn; only then decide what belongs in store state.

Additional completed refinement:

- map-scoped live queries now use a stricter `max_age_minutes=60` filter, which effectively makes the default operational map view “recent activity only” rather than inheriting the broader per-domain freshness windows used elsewhere

### Phase 2 commits

```text
refactor(frontend): reduce duplicated viewport asset copies across stores
perf(frontend): benchmark and replace full-map clone update path
perf(frontend): split trail updates from general asset upserts
test(frontend): add store throughput and trail path coverage
```

---

## Phase 3 — Rendering Scalability

**Goal**: Make the map path resilient once Phase 1 and 2 have removed avoidable CPU waste.
**Effort**: 4–7 days.
**Status**: In progress. The first low-risk LOD pass is implemented, and websocket preprocessing now has an initial worker path. Richer aggregation and broader worker offload are still pending.

### 3.1 Add zoom-based level of detail

**File**: `frontend/src/components/MapCanvas.tsx`

**Outcome so far**:

- At low zoom, background Air, Maritime, and Space tracks are rendered as deterministic aggregate cells instead of individual low-signal points
- At low zoom, background trails are suppressed unless the track is pinned, selected, alert-relevant, or otherwise priority-scoped
- At higher zoom, individual tracks and full trail sets still render normally

**Next step**:

- If profiling still shows low-zoom density pressure after the current pass, replace the thinning approach with explicit aggregation layers for the densest domains first

Candidate future layers:

- `HexagonLayer`
- `ScreenGridLayer`

This is a better scale lever than premature framework migration.

### 3.2 Move expensive preprocessing to a Web Worker

**Files**:

- new `frontend/src/workers/...`
- `frontend/src/App.tsx`
- related store wiring

**Use worker for**:

- event deduplication
- trail shaping or simplification
- domain bucketing
- optional search index maintenance

Implemented so far:

- websocket batch deduplication, domain bucketing, viewport membership partitioning, and trail shaping now run through a dedicated frontend worker when available
- the UI falls back to the same pure processing path on the main thread if the worker is unavailable or faults

Do not start with the worker. First shrink the main-thread work so the worker boundary is clear and justified.

### 3.3 Evaluate GPU-side filtering selectively

**File**: `frontend/src/components/MapCanvas.tsx`

`DataFilterExtension` can help for some visibility and classification cases, but it is not a substitute for:

- fixing broad store subscriptions
- stopping full layer rebuilds
- removing repeated trail derivation

Treat this as a targeted optimization after the CPU-side path is clean.

### 3.4 Revisit spatial indexing only if viewport-scoped data is still too large

The current map flow already fetches viewport-scoped data. That means `rbush` is not an automatic top-priority item.

Add spatial indexing only if profiling shows either:

- `viewportAssets` remains very large at target zooms, or
- trail culling remains expensive after Phase 1 and 2

### Phase 3 commits

```text
perf(frontend): add zoom-based LOD rendering for dense domains
feat(frontend): move event preprocessing into worker pipeline
perf(frontend): apply deck.gl GPU filtering where it replaces real CPU work
test(frontend): add LOD and worker processing coverage
```

---

## Phase 4 — Browser and Backend Scale

**Goal**: Fix the non-map path and reduce network overhead once render invalidation is under control.
**Effort**: 4–6 days.
**Status**: Browser query work is partially complete. Backend websocket delta work and multi-replica-safe websocket fan-out are now in progress.

### 4.1 Fix table-view scaling at the data source

**Files**:

- `frontend/src/App.tsx`
- `frontend/src/components/TrackBrowserView.tsx`
- related backend route if needed

**Problem**:

The browser view fetches full live domain datasets and then filters and sorts entirely on the client.

**Outcome so far**:

- Add server-side filtering and pagination for track browser queries
- Return only the fields needed for the table path where possible
- Keep the current 100-row page size unless UX requires virtualization later

Implemented:

- `api/routers/tracks.py` now exposes a dedicated `/api/tracks/browser` endpoint
- `TrackBrowserView.tsx` now queries that endpoint directly instead of loading the full live track set into the client
- browser facets and right-hand summaries now come from the backend, computed over the full filtered result set

Remaining:

- refine group-summary semantics if the current backend approximations are not strong enough for air/maritime analysis
- add tests and benchmark tracking for browser query latency and payload size

### 4.2 Add list virtualization only if page size grows

`TrackBrowserView` already paginates to 100 rows, so virtualization is not urgent. Add it only if:

- infinite scroll replaces pagination, or
- per-page row count increases substantially

### 4.3 Add backend delta payloads for WebSocket track updates

**Files**:

- `api/routers/ws.py`
- client WS handling path

This is worthwhile once the frontend is ready to merge deltas efficiently. It reduces bandwidth and object churn but should follow the store/data-path cleanup.

Implemented so far:

- `api/routers/ws.py` now emits `track_deltas` for tracks already seen on a connection, while still sending full `track_events` for first-seen tracks
- delta emission is opportunistic: the backend now falls back to full events when a delta is not materially smaller than the full payload
- the frontend websocket path now rehydrates those deltas back into full track objects before they enter the existing live-processing pipeline

### 4.4 Add multi-replica-safe broadcast if horizontal scale is required

Implemented so far:

- API startup now launches a websocket fan-out worker that uses a Redis-backed leader lease plus Redis pub/sub for replica-safe broadcast
- the elected leader consumes the Redis stream once and republishes normalized websocket payloads onto a shared pub/sub channel
- every API replica subscribes to that pub/sub channel and forwards those messages to its local websocket clients

Remaining:

- add operational visibility for leader handoff and pub/sub lag if this path becomes production-critical
- decide whether old pending stream entries should be reclaimed more aggressively during leader failover

### Phase 4 commits

```text
feat(api): add paginated and filterable track browser endpoint
perf(frontend): use server-driven browser query path
perf(api): add full-result browser summaries for sidebar correlation
perf(api): emit websocket delta payloads for incremental updates
feat(api): add multi-replica websocket broadcast path
test(api): add browser query and websocket delta coverage
```

---

## Deprioritized or Rejected Changes

These items are intentionally not near the top of the plan.

### Preact migration

Rejected. It does not address the current bottlenecks.

### `flushWsBatch` empty-queue guard

Already present in `App.tsx`. No action needed.

### Immediate `rbush` adoption

Deprioritized. The map already operates on viewport-scoped data.

### Immediate trigram/prefix search index for map search

Deprioritized. The current search cost is real, but it is not more urgent than selector granularity, layer decomposition, and store fan-out. Revisit after Phase 1 and 2.

### Immediate browser list virtualization

Deprioritized. The current table is paginated to 100 rows, so the larger issue is full-dataset fetching and client-side processing.

### Forced migration from `Map` to plain object

Rejected as a default assumption. Benchmark first.

---

## Test Strategy

### Principles

1. Add measurements before and after each phase.
2. Verify both correctness and invalidation scope.
3. Prefer observable behavior over implementation-only assertions.

### Tests to add first

**Store subscription tests**

- `MapCanvas` does not re-render on unrelated `useMapStore` changes
- `SourcePanel` does not re-render on unrelated map-only changes

**Layer memo tests**

- static layer builders do not run when only air assets update
- maritime updates do not rebuild space layers

**Store update tests**

- small upsert batches do not cause excessive cloning after the chosen refactor
- trail updates and asset updates can be exercised independently

**Browser path tests**

- server-driven browser filtering returns stable paginated results
- browser summaries are computed over the full filtered result set, not the current page
- client no longer sorts and filters a full live dataset unnecessarily

### Benchmark focus

Track at minimum:

- map render commit count during live updates
- `deckLayerBuild` time before and after split
- asset upsert time for a 100-event batch
- trail derivation time
- browser query payload size and client processing time

---

## Performance Targets

These targets are intentionally conservative until profiling data is captured.

| Metric | Baseline target to measure | After Phase 1 | After Phase 2 | After Phase 3 | After Phase 4 |
|---|---|---|---|---|---|
| Map component re-renders during unrelated store writes | Measure first | materially reduced | stable | stable | stable |
| `deckLayerBuild` cost during live updates | Measure first | reduced by scoped memos | reduced further | stable under higher load | stable |
| Comfortable map asset count in active viewport | Measure first | improved | improved | 10k+ path validated | stable |
| Asset upsert latency for 100-event burst | Measure first | slightly improved | materially improved | stable | stable |
| Trail processing overhead | Measure first | slightly improved | materially improved | stable | stable |
| Browser view payload and client processing cost | Measure first | unchanged | unchanged | unchanged | materially improved |

Success criteria:

- map interactions remain smooth during live WS updates
- unrelated store writes do not trigger heavy map recomputation
- low-zoom dense views remain usable after LOD work
- table view no longer depends on full-dataset client-side filtering
- default live-map view no longer surfaces stale assets older than the operational freshness cutoff

---

## Risk Register

| Risk | Phase | Likelihood | Mitigation |
|---|---|---|---|
| Selector refactor misses a state dependency and causes stale UI | 1 | Medium | add focused render and behavior tests while converting each component |
| Layer split increases code complexity | 1 | Medium | extract small layer builder helpers with narrow inputs |
| Store simplification removes data another panel still relies on | 2 | Medium | audit store ownership before deleting mirrored state |
| Chosen `Map` replacement path is slower in practice | 2 | Medium | benchmark candidate strategies before rollout |
| Trail decoupling changes visual expectations | 2 | Low | keep selected-track history path separate and validate visually |
| Worker overhead exceeds savings | 3 | Medium | only introduce after reducing main-thread waste and benchmark message cost |
| LOD changes user expectations at low zoom | 3 | Low | switch by zoom threshold and preserve detail at operational zoom |
| Backend delta payloads complicate client merge logic | 4 | Medium | introduce behind a protocol flag with full-payload fallback |

---

*Related docs: `docs/architecture/08_frontend_state_and_data_flow.md`*

# Track Panel Redesign Plan

## Objective

Redesign the Sentinel Map View Track Panel so users narrow to small, useful subsets before rendering, instead of enabling whole high-density domains first.

The main design goal is:

- progressive narrowing before rendering
- lower interaction cost
- lower cognitive load
- lower cold-start and map churn
- strong support for shortlist-driven analysis
- make `show everything` an advanced action, not the default path

## Critical Assessment

The current Track Panel is acting as:

- layer switcher
- domain browser
- filter tree
- workspace status view

That breaks down for large domains because the first meaningful action is often “turn on the whole domain.” For Space, and often Air/Maritime, that is the wrong abstraction.

The core UX failure is:

- activation happens before narrowing

Sentinel should invert that flow:

- choose domain
- choose subset
- preview count
- apply scope
- inspect shortlist

Not:

- choose domain
- load/render everything
- try to recover with filters

## Main Interaction Mistakes

1. Domain toggles are too coarse for large datasets.
2. Browse and render are coupled.
3. The panel reflects loaded assets more than intended scope.
4. `Show all` is too easy.
5. Space grouping appears too late in the flow.
6. Selection, pinning, and investigation are not strong enough as separate modes.

## Recommended Interaction Model

The Track Panel should become a combination of:

- scoped query builder
- shortlist manager
- active selection panel

It should not behave like a raw “turn on the whole domain” browser.

New flow:

1. Expand domain
2. Pick a quick scope
3. Preview count
4. Apply scope
5. Results land in shortlist
6. Map shows shortlist plus optional low-cost context

## Recommended Default Behavior Per Domain

### Air

Default scopes:

- Military
- Commercial sample
- Recent alerts
- Viewport only
- By operator

Default action should be `Military` or `Recent alerts`, not all aircraft.

### Maritime

Default scopes:

- Military/Government
- Major routes
- Recent alerts
- Viewport only
- By flag/operator

Default action should be `Recent alerts` or `Major routes sample`, not all vessels.

### Space

Default scopes:

- Watchlist
- Priority constellations
- By function
- By constellation
- By operator
- Recent alerts

Default action should be `Watchlist` or `Priority constellations`.

`Show all active payloads` should be advanced-only with a count preview.

### GPS / Infra

Treat these as event/disruption domains, not track domains.

Default scopes:

- Active disruptions
- High severity
- Near selected asset
- Recent alerts

## Recommended Filter Hierarchy

Three-step narrowing flow:

1. Scope
   - Watchlist
   - Viewport
   - AOI
   - Recent alerts
   - Pinned
   - Investigation

2. Domain-specific filter
   - Space: constellation, operator, function, orbit class
   - Air: classification, operator, aircraft type, source feed
   - Maritime: flag, type, operator, source feed

3. Result cap / shortlist mode
   - Top 50
   - Top 200
   - Selected only
   - Pinned only

This narrowing should happen before rendering, not only after.

## Selection, Pinning, Investigation Focus

### Selection

- one active selected asset
- opens detail card
- keeps its trail visible

### Pinning

- persistent shortlist
- survives filter changes
- remains visible unless explicitly cleared

### Investigation focus

- stronger than pin
- can override filter hiding
- auto-loads supporting disruptions and related assets
- does not require the whole domain to remain visible

### Background assets

- low-opacity context only
- never compete visually with selected/pinned/investigation assets

## Remove or Demote

Remove as primary behavior:

- raw domain-first activation
- immediate all-tracks behavior
- large always-expanded lists for dense domains
- treating the panel as a passive mirror of fetched assets

Demote to advanced mode:

- `Show all`
- full-domain trails
- full-catalog Space browsing

## Commit-by-Commit Redesign Roadmap

## Completion Status

- [x] 1. add domain quick scope cards to track panel
- [x] 2. add scoped filter state for map panel queries
- [x] 3. add pre-render count previews for scoped queries
- [x] 4. add shortlist mode to track panel
- [x] 5. add server-side scoped live queries for track panel
- [x] 6. make space panel watchlist and constellation first
- [x] 7. separate selected pinned and investigation rendering
- [x] 8. demote show-all to advanced mode

## Implementation Log

1. `65c347a` `add quick scope cards to track panel`
2. `142c2e6` `separate scope intent from layer visibility`
3. `b0dac8d` `add scoped track preview counts`
4. `a8f78f2` `add track panel shortlist mode`
5. `b8eba58` `add scoped live queries for track panel`
6. `754385f` `make space panel watchlist and constellation first`
7. `f7a1844` `separate selected pinned and investigation rendering`
8. `fd5757f` `demote show-all to advanced mode`

### 1. add domain quick scope cards to track panel

Goal:

- replace first-click domain activation with scope selection

Files:

- `frontend/src/components/SourcePanel.tsx`
- `frontend/src/store/useMapStore.ts`

Backend:

- none

Frontend:

- expanding a domain shows `Quick Scope` actions first
- no immediate full-domain list on first expand
- add per-domain quick-scope state

Validation:

- first expand does not trigger full-domain fetch/render
- user can choose a scope before loading assets

Why independent:

- fixes the biggest first-click UX problem

### 2. add scoped filter state for map panel queries

Goal:

- separate intended subset from raw layer visibility

Files:

- `frontend/src/store/useMapStore.ts`
- `frontend/src/App.tsx`
- `frontend/src/types/track.ts`

Backend:

- none

Frontend:

- add `domainScope`, `scopeFilters`, `resultLimit`
- stop using layer visibility alone as the query driver

Validation:

- changing scope updates query intent, not just render opacity

Why independent:

- establishes the required state model

### 3. add pre-render count previews for scoped queries

Goal:

- show “how many assets would this load?” before apply

Files:

- `frontend/src/components/SourcePanel.tsx`
- `api/routers/tracks.py`

Backend:

- add lightweight scoped count/preview endpoint

Frontend:

- quick scopes show projected counts
- large scopes require deliberate confirmation

Validation:

- user sees count before heavy load

Why independent:

- adds a safe guardrail before server-side scoped loading is complete

### 4. add shortlist mode to track panel

Goal:

- make scoped results land in a manageable working set

Files:

- `frontend/src/components/SourcePanel.tsx`
- `frontend/src/store/useMapStore.ts`

Backend:

- none

Frontend:

- add shortlist, pin, clear shortlist
- show shortlist before raw scoped result list

Validation:

- pinned/selected assets persist across scope changes

Why independent:

- introduces an operational browsing model

### 5. add server-side scoped live queries for track panel

Goal:

- fetch narrowed subsets only

Files:

- `api/routers/tracks.py`
- `frontend/src/App.tsx`
- `frontend/src/components/SourcePanel.tsx`

Backend:

- support scope/filter params:
  - classification
  - operator/feed
  - constellation/function
  - watchlist
  - alert-linked scope
  - result limit

Frontend:

- Track Panel scopes drive backend fetches

Validation:

- applying `Watchlist` or `Military` does not load the full domain

Why independent:

- largest performance gain after the new interaction model exists

### 6. make space panel watchlist and constellation first

Goal:

- make Space usable by default

Files:

- `frontend/src/components/SourcePanel.tsx`
- grouping helpers
- `api/routers/tracks.py`

Backend:

- ensure watchlist / constellation / function filters are supported cleanly

Frontend:

- Space opens with:
  - Watchlist
  - Priority constellations
  - By function
  - By constellation
- full catalog is advanced-only

Validation:

- first click on Space does not create a 17k-asset workflow

Why independent:

- Space is the highest-density domain and needs explicit treatment

### 7. separate selected pinned and investigation rendering

Goal:

- make important assets visually distinct from background context

Files:

- `frontend/src/components/MapCanvas.tsx`
- `frontend/src/store/useMapStore.ts`

Backend:

- none

Frontend:

- separate render lanes for selected, pinned, and investigation assets
- background assets remain cheap and dim

Validation:

- selection remains stable across filter changes

Why independent:

- improves usability without changing query behavior

### 8. demote show-all to advanced mode

Goal:

- make massive loads deliberate

Files:

- `frontend/src/components/SourcePanel.tsx`

Backend:

- optional count-warning threshold

Frontend:

- `Show all` moved behind advanced disclosure
- show projected count before enabling

Validation:

- novice user cannot accidentally trigger the heaviest path

Why independent:

- simple safeguard with high UX value

## Explicit Examples

### If a user clicks Space

1. open Space quick scopes
2. highlight `Watchlist`
3. show preview count
4. apply scope
5. load shortlist-sized result set
6. render shortlist plus optional background context

### If a user wants military aircraft

1. click Air
2. choose `Military`
3. optionally refine by viewport/operator
4. load only that subset
5. browse shortlist

### If a user wants only one constellation

1. click Space
2. choose `By constellation`
3. pick a constellation
4. preview count
5. apply subset
6. render only that constellation plus selected/pinned items

## Recommended First Implementation Block

Start with commits 1 through 5.

That is the minimum set needed to transform the Track Panel from:

- a domain toggle browser

into:

- a progressive narrowing tool

which is the core UX correction required.

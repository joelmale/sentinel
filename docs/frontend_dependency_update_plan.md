# Frontend Dependency Update Crosswalk

Generated from:

- [`frontend/package.json`](/Users/JoelN/Coding/sentinel/frontend/package.json)
- [`frontend/package-lock.json`](/Users/JoelN/Coding/sentinel/frontend/package-lock.json)
- `npm outdated --long --json`
- `npm view <package> version`

Date:

- 2026-03-14

## Summary

Sentinel's frontend dependencies fall into three buckets:

1. Safe patch/minor updates with low upgrade risk
2. Major updates that are likely worth doing soon, but in isolated slices
3. Major platform jumps that should be deferred until you explicitly want to move the stack:
   - React 18 -> 19
   - Vite 5 -> 8
   - ESLint 8 / typescript-eslint 7 -> ESLint 10 / typescript-eslint 8
   - Tailwind 3 -> 4

The immediate low-risk win is to update the packages already on the same major line.

## Cross Listing

### Production Dependencies

| Package | Declared Range | Locked Current | Latest | Delta | Recommendation |
|---|---:|---:|---:|---|---|
| `@deck.gl/core` | `^9.0.0` | `9.2.11` | `9.2.11` | none | keep |
| `@deck.gl/geo-layers` | `^9.0.0` | `9.2.11` | `9.2.11` | none | keep |
| `@deck.gl/layers` | `^9.0.0` | `9.2.11` | `9.2.11` | none | keep |
| `@deck.gl/react` | `^9.0.0` | `9.2.11` | `9.2.11` | none | keep |
| `@tanstack/react-query` | `^5.40.0` | `5.90.21` | `5.90.21` | none | keep |
| `date-fns` | `^3.6.0` | `3.6.0` | `4.1.0` | major | defer to dedicated slice |
| `maplibre-gl` | `^5.20.0` | `5.20.0` | `5.20.1` | patch | update now |
| `react` | `^18.3.1` | `18.3.1` | `19.2.4` | major | defer |
| `react-dom` | `^18.3.1` | `18.3.1` | `19.2.4` | major | defer with React |
| `react-map-gl` | `^8.1.0` | `8.1.0` | `8.1.0` | none | keep |
| `recharts` | `^2.12.7` | `2.15.4` | `3.8.0` | major | defer unless chart work is active |
| `zustand` | `^4.5.4` | `4.5.7` | `5.0.11` | major | defer to isolated state slice |

### Development Dependencies

| Package | Declared Range | Locked Current | Latest | Delta | Recommendation |
|---|---:|---:|---:|---|---|
| `@types/node` | `^20.14.9` | `20.19.37` | `25.5.0` | major | defer until Node/TS baseline is raised intentionally |
| `@types/react` | `^18.3.3` | `18.3.28` | `19.2.14` | major | defer with React 19 |
| `@types/react-dom` | `^18.3.0` | `18.3.7` | `19.2.3` | major | defer with React 19 |
| `@typescript-eslint/eslint-plugin` | `^7.15.0` | `7.18.0` | `8.57.0` | major | defer with ESLint migration |
| `@typescript-eslint/parser` | `^7.15.0` | `7.18.0` | `8.57.0` | major | defer with ESLint migration |
| `@vitejs/plugin-react` | `^4.3.1` | `4.7.0` | `6.0.1` | major | defer with Vite migration |
| `autoprefixer` | `^10.4.19` | `10.4.27` | `10.4.27` | none | keep |
| `eslint` | `^8.57.0` | `8.57.1` | `10.0.3` | major | defer |
| `eslint-plugin-react-hooks` | `^4.6.2` | `4.6.2` | `7.0.1` | major | defer with ESLint/React toolchain |
| `postcss` | `^8.4.39` | `8.5.8` | `8.5.8` | none | keep |
| `tailwindcss` | `^3.4.6` | `3.4.19` | `4.2.1` | major | defer |
| `typescript` | `^5.5.3` | `5.9.3` | `5.9.3` | none | keep |
| `vite` | `^5.3.4` | `5.4.21` | `8.0.0` | major | defer |

## Recommended Upgrade Order

### Phase 1: low-risk refresh

These are worth doing first because they should not force architectural changes:

1. `maplibre-gl` `5.20.0 -> 5.20.1`

Validation:

- `npm install`
- `npm --prefix frontend run type-check`
- `npm --prefix frontend run lint`
- `npm --prefix frontend run dev`
- smoke-test map interactions and globe mode

### Phase 2: targeted major upgrades with contained blast radius

Only do these if you want incremental modernization without platform churn:

1. `date-fns` `3.6.0 -> 4.1.0`
2. `zustand` `4.5.7 -> 5.0.11`
3. `recharts` `2.15.4 -> 3.8.0`

Recommended order inside this phase:

1. `date-fns`
2. `recharts`
3. `zustand`

Reasoning:

- `date-fns` is usually contained and easy to validate
- `recharts` affects fewer surfaces than state management
- `zustand` touches the app architecture and should be isolated

### Phase 3: platform/toolchain migration block

Treat this as one coordinated modernization project, not a casual update:

1. `react` / `react-dom` `18 -> 19`
2. `@types/react` / `@types/react-dom` `18 -> 19`
3. `vite` `5 -> 8`
4. `@vitejs/plugin-react` `4 -> 6`
5. `eslint` `8 -> 10`
6. `@typescript-eslint/*` `7 -> 8`
7. `eslint-plugin-react-hooks` `4 -> 7`
8. optionally `@types/node` `20 -> 25`

This phase will likely require:

- config changes
- lint rule updates
- React compatibility review
- plugin compatibility checks

### Phase 4: styling system migration

Only do this if you explicitly want to modernize Tailwind usage:

1. `tailwindcss` `3 -> 4`

This should be its own work block because Tailwind 4 is not a simple drop-in upgrade for every setup.

## Suggested Commit-by-Commit Upgrade Plan

## Completed

- [x] `maplibre-gl` -> `5.20.1`
- [x] `date-fns` -> `4.1.0`
- [x] `recharts` -> `3.8.0`
- [x] `zustand` -> `5.0.11`
- [x] `react` / `react-dom` / typings -> React 19
- [x] `vite` -> `8.0.0`
- [x] `@vitejs/plugin-react` -> `6.0.1`
- [x] `eslint` -> `10.0.3`
- [x] `@typescript-eslint/*` -> `8.57.0`
- [x] `eslint-plugin-react-hooks` -> `7.0.1`
- [x] `tailwindcss` -> `4.2.1`
- [x] `@tailwindcss/postcss` added for Tailwind 4 CSS processing
- [x] `@types/node` -> `25.5.0`

Completed commits:

1. `4fb1747` `update maplibre-gl to 5.20.1`
2. `bb5f62a` `update date-fns to 4.1.0`
3. `cd42b0b` `update recharts to 3.8.0`
4. `a5d3a80` `update zustand to 5.0.11`
5. `2ea284c` `update react to 19.2.0`

## RSC Note

React 19 does not, by itself, make Sentinel a native React Server Components app.

Current Sentinel frontend architecture:

- Vite SPA
- client-rendered React app
- FastAPI backend

That stack can run React 19, but it does not provide the server/runtime model needed for native RSC delivery.

To use true RSC in production, Sentinel would need an RSC-capable app/runtime layer, for example:

- Next.js App Router
- React Router's RSC stack
- another RSC-capable server/build integration

So the correct interpretation is:

- React 19 upgrade: implemented
- native RSC capability: not unlocked yet by this slice

If you want RSC for operational performance later, that should be a separate architectural phase, not bundled into the React runtime upgrade.

### 1. update low-risk map dependency

Goal:

- move `maplibre-gl` to latest patch

Packages:

- `maplibre-gl`

Validation:

- `npm install`
- `npm --prefix frontend run type-check`
- `npm --prefix frontend run lint`
- map smoke test

### 2. update date-fns to v4

Goal:

- move time/date helpers to current major

Packages:

- `date-fns`

Validation:

- `npm --prefix frontend run type-check`
- `npm --prefix frontend run lint`
- verify formatting/parsing in:
  - header clock
  - timeline
  - overview cards

### 3. update recharts to v3

Goal:

- modernize charting without changing the core rendering stack

Packages:

- `recharts`

Validation:

- `npm --prefix frontend run type-check`
- `npm --prefix frontend run lint`
- inspect overview/activity dashboards

### 4. update zustand to v5

Goal:

- modernize state management with one isolated state migration slice

Packages:

- `zustand`

Validation:

- `npm --prefix frontend run type-check`
- `npm --prefix frontend run lint`
- smoke test:
  - map selection
  - track panel scopes
  - overview navigation
  - playback/investigation

### 5. platform migration prep

Goal:

- create a branch/block for React/Vite/ESLint modernization

Packages:

- `react`
- `react-dom`
- `@types/react`
- `@types/react-dom`
- `vite`
- `@vitejs/plugin-react`
- `eslint`
- `@typescript-eslint/eslint-plugin`
- `@typescript-eslint/parser`
- `eslint-plugin-react-hooks`

Validation:

- full frontend lint/type-check
- Vite dev server startup
- route and map smoke tests

## Next Major Phases

These should each be handled as their own work block and commit series, not mixed together.

### Phase A: React 19

Goal:

- move the runtime and typings to React 19

Primary packages:

- `react`
- `react-dom`
- `@types/react`
- `@types/react-dom`

Expected work:

- update package versions
- resolve new JSX/type behavior
- review third-party compatibility:
  - `react-map-gl`
  - `@tanstack/react-query`
  - `recharts`
  - `@deck.gl/react`
- rerun all state-heavy screens for subtle render behavior changes

Validation:

- `npm --prefix frontend run type-check`
- `npm --prefix frontend run lint`
- `npm --prefix frontend run dev`
- smoke test:
  - overview
  - map
  - track panel scopes
  - investigation flow

Recommended commit sequence:

1. update React runtime and typings
2. fix compile/lint issues
3. smoke-test render-critical screens

Status:

- complete

### Phase B: Vite 8

Goal:

- move the frontend build/runtime toolchain from Vite 5 to Vite 8

Primary packages:

- `vite`
- `@vitejs/plugin-react`

Expected work:

- update Vite and plugin versions together
- review config compatibility in:
  - [`frontend/vite.config.ts`](/Users/JoelN/Coding/sentinel/frontend/vite.config.ts)
- verify dev proxy behavior and HMR
- check any env/type changes that affect local dev

Validation:

- `npm --prefix frontend run dev`
- confirm proxy routes still work:
  - `/api/...`
  - websocket path
- `npm --prefix frontend run type-check`
- `npm --prefix frontend run lint`

Recommended commit sequence:

1. update Vite and React plugin
2. fix config/proxy regressions
3. verify dev startup and proxying

### Phase C: ESLint 10

Goal:

- modernize the lint toolchain without changing app behavior

Primary packages:

- `eslint`
- `@typescript-eslint/eslint-plugin`
- `@typescript-eslint/parser`
- `eslint-plugin-react-hooks`

Expected work:

- update lint packages together
- adjust rule compatibility
- update ESLint config if required by new major behavior
- resolve any new hook/type strictness surfaced by the upgrade

Validation:

- `npm --prefix frontend run lint`
- `npm --prefix frontend run type-check`

Recommended commit sequence:

1. update lint stack
2. fix config breakages
3. fix newly surfaced lint violations

### Phase D: Tailwind 4

Goal:

- migrate the styling toolchain only after the platform/tooling stack is stable

Primary packages:

- `tailwindcss`

Expected work:

- verify whether Sentinel actually uses Tailwind build output actively or only carries it as a dependency
- if active, migrate config and entry CSS as needed
- if largely unused, decide whether to remove it instead of upgrading it

Validation:

- CSS build succeeds
- no missing utility output
- visual regression pass on overview, map chrome, panels, cards

Recommended commit sequence:

1. confirm Tailwind usage footprint
2. upgrade/migrate or remove intentionally
3. run visual regression sweep

### 6. tailwind migration block

Goal:

- migrate to Tailwind 4 only after the platform stack is stable

Packages:

- `tailwindcss`

Validation:

- visual regression sweep
- CSS build and utility resolution checks

## Recommended “Do Now” vs “Defer”

### Do now

- `maplibre-gl` patch update
- document and stage the rest of the plan

### Do soon

- `date-fns` v4
- `recharts` v3
- `zustand` v5

### Defer until you explicitly want a platform migration

- native RSC architecture
- broader lint-rule tightening for React Compiler / purity rules

## Why not update everything immediately

Because the current frontend is already carrying:

- heavy map/render logic
- custom state orchestration
- performance-sensitive workflows

The risky updates are not just version bumps. They can change:

- React typing behavior
- store subscription semantics
- lint rules
- Vite plugin behavior
- CSS pipeline behavior

That should be done intentionally, not as a bulk dependency sweep.

## Recommended Next Action

If you want a practical next work block now, the package migration plan is effectively complete.

The remaining frontend work is no longer package-version work. It is architectural and policy work:

1. decide whether Sentinel should adopt a true RSC-capable runtime
2. decide whether to opt into the stricter React Compiler-oriented lint rules
3. continue performance work in data loading, map LOD, and workflow design

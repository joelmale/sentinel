# Sentinel – Project Workability & Traceability Recommendations

*Written March 2026. Tailored to the current stack: React/Vite/TypeScript frontend, FastAPI backend, multi-collector ingest pipeline, TimescaleDB + Redis, Docker Compose.*

---

## 1. Establish Conventional Commits — now, before the history grows

`AGENTS.md` notes "Git history is empty on master, so there is no established commit convention yet." This is exactly the right moment.

**Adopt [Conventional Commits](https://www.conventionalcommits.org):**
```
feat(map): add GPS-jam heat layer with hex drilldown
fix(maplibre): force pre-bundle via optimizeDeps to prevent Map undefined error
chore(deps): upgrade maplibre-gl 4.7.1 → 5.20.0
refactor(SourcePanel): extract useResizePanel hook for 2D drag-resize
```

The `type(scope)` prefix acts like a type tag on a commit — it makes `git log --oneline` scannable and enables automated tooling. Add **[git-cliff](https://git-cliff.org/)** (a single Rust binary, no config needed to start) to generate `CHANGELOG.md` from these prefixes. This creates instant traceability between a changelog entry and the exact commit that caused it — the same property you'd want in a database schema (foreign key from change → cause).

**Minimal setup:**
```bash
# Install git-cliff (or use npx conventional-changelog-cli)
brew install git-cliff

# Add to Makefile:
changelog:
    git-cliff -o CHANGELOG.md
```

---

## 2. Structured issue tracking with labels + milestones

GitHub Issues with a consistent label taxonomy is enough for a project this size. Suggested labels:

| Label | Meaning |
|---|---|
| `bug` | Something broken |
| `regression` | Was working, now broken (always link the breaking commit) |
| `perf` | Performance degradation |
| `domain:air` / `domain:maritime` / `domain:space` | Domain-scoped feature work |
| `infra` | Docker, CI, deps |
| `good-first-issue` | Low-complexity entry points |

Every bug report should follow a template:
```markdown
**Observed:** TypeError: Cannot read properties of undefined (reading 'Map')
**Expected:** Map renders normally
**Reproduce:** docker compose down && docker compose up && open http://localhost:5173
**Environment:** maplibre-gl 4.7.1, Vite 5.3.4, Chrome 123
**Relevant logs:** [paste browser console]
**Related commits / PRs:** (link)
```

The "environment" field is what saved us during the maplibre-gl debugging — knowing the exact package version immediately narrowed the root cause.

---

## 3. Tag releases — even pre-1.0

Version tags are your bisection anchors. Tagging `v0.1.0`, `v0.2.0`, etc. costs nothing but means you can run `git bisect v0.1.0 HEAD` to find a regression in minutes rather than hours.

**Suggested cadence:** tag after every significant feature batch lands on `main`.

```bash
git tag -a v0.3.0 -m "GPS jam heatmap, group exclusion filter, panel 2D resize"
git push origin --tags
```

Combine with git-cliff: `git-cliff v0.2.0..v0.3.0 -o CHANGELOG.md` generates only the delta.

---

## 4. Add a `/api/version` endpoint

The API has a health router. Extend it with a version endpoint:

```python
# api/routers/health.py
import subprocess, os

@router.get("/version")
def version():
    sha = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"],
                                  cwd="/app").decode().strip()
    return {"git_sha": sha, "build_time": os.environ.get("BUILD_TIME", "dev")}
```

Set `BUILD_TIME` in your Docker build:
```dockerfile
ARG BUILD_TIME
ENV BUILD_TIME=${BUILD_TIME}
```

This means that when a bug is reported from a deployed environment you can immediately answer "which version is this?" rather than guessing from deployment logs.

---

## 5. Structured logging with correlation IDs across collectors → API

Right now, if a vessel's AIS track disappears from the UI, you'd need to manually grep across the AIS collector logs, the FastAPI ingest log, the WebSocket push log, and the TimescaleDB row — all hoping the timestamps align.

A **correlation ID** (a UUID added at ingest time) carried through every log line collapses that grep into a single query:

```python
# collectors/base/base_collector.py
import uuid, structlog

log = structlog.get_logger()

def ingest_record(self, record):
    cid = str(uuid.uuid4())[:8]  # short 8-char prefix is enough
    log.info("ingest", cid=cid, domain=self.domain, track_id=record["track_id"])
    # pass cid to API call / DB write
```

Use **[structlog](https://www.structlog.org/)** instead of stdlib `logging` for this — it outputs structured JSON that TimescaleDB or any log aggregator can index. Think of it as the difference between `printf` debugging and a proper query language over your logs.

---

## 6. React Error Boundaries around heavy components

The maplibre-gl bug caused a blank screen with no explanation. React Error Boundaries are the `try/catch` of component trees — they catch runtime errors and render a fallback instead of a white void.

```tsx
// src/components/MapErrorBoundary.tsx
import { Component, ReactNode } from 'react'

interface State { hasError: boolean; error?: Error }

export class MapErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error } }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full bg-neutral-900 text-red-400 p-8">
          <div>
            <p className="font-mono text-sm">Map failed to initialise.</p>
            <p className="text-xs text-neutral-500 mt-2">{this.state.error?.message}</p>
            <button onClick={() => window.location.reload()} className="mt-4 text-xs underline">
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
```

Wrap `<MapCanvas />` in `App.tsx`:
```tsx
<MapErrorBoundary>
  <MapCanvas ... />
</MapErrorBoundary>
```

---

## 7. Add Vitest for frontend unit tests — start with the store and utility functions

`AGENTS.md` notes no frontend test runner is configured yet. For a project with calculated alpha values, group-exclusion logic, and airline/country classification functions, even a small test suite catches regressions in the logic layer before they reach the map.

**Install:**
```bash
npm install -D vitest @vitest/ui
```

**Add to `vite.config.ts`:**
```ts
test: {
  globals: true,
  environment: 'jsdom',
}
```

**Start with utility functions (zero DOM required):**
```ts
// src/lib/__tests__/getAirlineGroup.test.ts
import { getAirlineGroup } from '../getAirlineGroup'
import { describe, it, expect } from 'vitest'

describe('getAirlineGroup', () => {
  it('groups SWA123 as Southwest', () => {
    expect(getAirlineGroup('SWA123', null)).toBe('Southwest Airlines')
  })
  it('returns "Other" for unknown callsign', () => {
    expect(getAirlineGroup('UNKNOWN', null)).toBe('Other')
  })
})
```

Add `make test-frontend` to the Makefile: `cd frontend && npx vitest run`.

---

## 8. Dependency hygiene: Renovate bot + explicit pinning for major versions

The maplibre-gl 4→5 jump was a major version with a packaging change that broke Vite's pre-bundler in a non-obvious way. The pattern isn't unique to maplibre — deck.gl, React, TypeScript all have breaking major versions.

**Two-part solution:**

First, enable **[Renovate](https://docs.renovatebot.com/)** (free for public and private GitHub repos) to open automated PRs for dependency updates. This means updates are never silently accumulated — each one is a discrete, reviewable change. Configure it to auto-merge patch/minor updates but require manual review for major bumps.

Second, pin the exact versions that are known-good in `package.json` rather than using `^` ranges for the mapping stack:
```json
"maplibre-gl": "5.20.0",
"@vis.gl/react-maplibre": "8.1.0",
"@deck.gl/core": "9.1.x"
```

Think of `^5.20.0` as "this variable is `>=`" — it's fine for leaf utilities but dangerous for the rendering stack where inter-package compatibility is tight.

---

## 9. Add a `docs/known-issues.md` runbook

Several of the issues encountered in this project were environmental and non-obvious. A running known-issues doc with cause + fix dramatically speeds up the next occurrence:

```markdown
## Vite: "Cannot read properties of undefined (reading 'Map')"

**Cause:** maplibre-gl is loaded via a runtime dynamic import inside
@vis.gl/react-maplibre. If Vite's dep scanner doesn't discover it, the UMD
bundle is served raw to the browser before esbuild converts it to ESM.

**Fix:** vite.config.ts must include:
  optimizeDeps: { include: ['maplibre-gl'] }
Also clear node_modules/.vite/ after any maplibre-gl version change.

**Introduced:** maplibre-gl >=5.0 (packaging restructure)
**Fixed in:** vite.config.ts commit <sha>
```

---

## Priority order (highest impact first)

1. **Conventional Commits + git tags** — zero cost, immediate bisection power
2. **Error Boundaries** — prevents blank-screen failures, 30 min to add
3. **`/api/version` endpoint** — know exactly what's deployed, 15 min
4. **Renovate bot** — stops silent dependency drift, 10 min to configure
5. **`docs/known-issues.md`** — already have two solid entries to start with
6. **Vitest** — invest here once the feature set stabilises
7. **Structured logging + correlation IDs** — high value as collectors scale
8. **GitHub Issues labels + templates** — formalise as the team/scope grows

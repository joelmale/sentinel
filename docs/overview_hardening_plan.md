# Overview Hardening Plan

Status: In progress

This file tracks the overview-hardening work block. Implementation stops after Phase 6 for review before any Phase 7+ work.

## Phase Checklist

- [x] Phase 1: Capability handshake and degraded fallback
- [ ] Phase 2: Split overview core vs pivots
- [ ] Phase 3: Precomputed domain summary source
- [ ] Phase 4: Real alert queue semantics
- [ ] Phase 5: Trustworthy ops panel data
- [ ] Phase 6: Section-level failure reporting and panel isolation
- [ ] Phase 7: Fast pivots real vs deferred
- [ ] Phase 8: Overview-specific perf instrumentation
- [ ] Phase 9: Explicit multi-worker cache strategy

## Planned Phases

### Phase 1
Goal:
- Prevent stale-backend `404` failures from turning the entire landing screen into a hard error.

Planned work:
- Add API capability/version metadata.
- Check overview capability before querying overview endpoints.
- Render a clear degraded fallback when overview is unsupported.

Validation:
- Health/capability endpoint responds with overview support.
- Frontend renders fallback without a route error if overview is unavailable.

### Phase 2
Goal:
- Reduce cold-start work by separating essential overview data from secondary pivots.

Planned work:
- Split overview API into `core` and `pivots`.
- Load `core` immediately and `pivots` lazily.

Validation:
- Both endpoints return valid payloads.
- Landing page remains usable before pivots resolve.

### Phase 3
Goal:
- Make domain summary fast and operationally correct.

Planned work:
- Replace raw `track_events` landing-page distinct scans with a precomputed or materialized summary source.
- Keep freshness windows aligned with the live model.

Validation:
- Overview domain counts align with live summary semantics.
- Query cost is lower than the old direct aggregate path.

### Phase 4
Goal:
- Make overview alert rows true investigation entry points instead of placeholders.

Planned work:
- Return actual severity, triage/status, and evidence summary.
- Align overview alert semantics with the existing investigation model.

Validation:
- Alert drill-through preserves scope and opens investigation correctly.

### Phase 5
Goal:
- Replace placeholder ops data with trustworthy operational health signals.

Planned work:
- Use real source lag/error state.
- Stop hardcoding connection-style fields in backend payloads.

Validation:
- Ops panel changes with source health conditions.

### Phase 6
Goal:
- Ensure one failed overview section degrades locally instead of blanking the page.

Planned work:
- Return per-section status/error metadata.
- Render panel-level degraded states in the overview UI.

Validation:
- A broken section shows a local degraded state while others still render.

## Phase Log

### Phase 1
Status: Completed

Completed work:
- Added overview capability metadata to `/health`.
- Added frontend capability check before querying overview routes.
- Added degraded overview fallback copy when backend overview support is unavailable.

### Phase 2
Status: Pending

### Phase 3
Status: Pending

### Phase 4
Status: Pending

### Phase 5
Status: Pending

### Phase 6
Status: Pending

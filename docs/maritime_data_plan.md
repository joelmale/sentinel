# Maritime Data Plan

## Goals

- Keep Sentinel maritime identity data open-source-friendly and low-cost.
- Stop showing bare MMSIs as the primary vessel label when better names are known.
- Persist vessel identity knowledge so transient feed gaps do not erase names.
- Normalize maritime data into a stable backend contract for UI and analytics.
- Treat scraping as fallback enrichment, not the primary source of truth.

## Current State

- Live vessel motion comes primarily from `AISStream`.
- Historical/supplemental maritime inputs can also come from `AccessAIS` and `GlobalFishingWatch`.
- Stable maritime attributes are already persisted in:
  - `entity_identifiers`
    - keyed by `mmsi`, `imo`, and feed-local IDs
  - `entity_enrichments`
    - stable ship metadata and free-form JSON metadata
  - `entities.display_name`
    - canonical label for the entity
- MarineTraffic enrichment exists today, but it is best-effort and can be incomplete or blocked.

## Normalized Maritime Identity Model

The backend should treat these as the canonical maritime identity fields:

- `display_name`
  - the best human-readable label for the vessel
- `display_name_source`
  - `vessel_name`, `radio_callsign`, or `track_id`
- `mmsi`
  - primary AIS track identity
- `imo`
  - stable vessel identity when available
- `ship_id`
  - provider-specific vessel key when present
- `vessel_name`
  - normalized vessel name
- `radio_callsign`
  - radio callsign if present
- `ship_type`
- `flag`
- `destination`
- `operator`
- `owner`
- `country_code`
- `primary_identity_key`
  - prefer `imo:<imo>`, otherwise `mmsi:<mmsi>`
- `identity_keys`
  - all durable lookup keys currently known

This data should be exposed alongside the raw metadata, not replace it.

## Display Name Rules

Maritime labels should follow this precedence:

1. `vessel_name`
2. `radio_callsign` when it is not just the MMSI/IMO/track ID
3. `track_id`

This keeps the UI readable while preserving a deterministic fallback.

## Identity Cache Strategy

The identity cache should be implemented with existing canonical tables, not a new ad hoc store.

### Cache Keys

- `entity_identifiers`
  - `mmsi`
  - `imo`
- `asset_identity_resolutions`
  - maps feed-local `(source_domain, source_feed, track_id)` to `entity_id`
- `entity_enrichments`
  - stores normalized vessel identity and enrichment metadata
- `entities.display_name`
  - stores the best-known canonical vessel label

### Cache Behavior

- When a feed provides `mmsi`, resolve or create the entity.
- If `imo` is present, attach it as a durable secondary identifier.
- If a better `vessel_name` is learned later, update:
  - `entities.display_name`
  - `entity_enrichments.metadata`
- Never let a later low-quality label overwrite a better existing name.
  - bare MMSI should not replace a known vessel name
  - empty values should not replace known values

### Why This Works

- MMSI is often available first, but vessel names may arrive later.
- IMO is more stable across some changes and helps cross-feed matching.
- Persisting both means Sentinel can remember names even when live messages become sparse.

## Source Strategy

### Base Source

- `AISStream`
  - primary live global motion feed

### Free / Open Friendly Backfill

- `AccessAIS`
  - historical/import path where available
- `GlobalFishingWatch`
  - useful supplemental maritime identity for fishing fleets
- `MarineCadastre`
  - historical U.S.-focused backfill, not live global identity
- `USCG VIVS`
  - useful for U.S. static vessel data coverage where applicable
- `AISHub`
  - optional if Sentinel operators contribute receiver data

### Scraping Policy

Scraping commercial vessel sites should be treated as:

- optional
- low-confidence
- rate-limited
- provenance-tagged
- easy to disable

Scrapers should not be required for normal operation.

## Enrichment Confidence and Provenance

Each maritime identity payload should retain:

- `provider`
- `fetched_at`
- `marinetraffic_status` or equivalent source status
- source-specific raw payload under namespaced metadata
- confidence notes when multiple sources disagree

If two sources disagree on vessel name:

- prefer the most recent trusted source
- retain both in raw metadata
- keep the chosen canonical `display_name`

## Recommended Backend Shape

Short term:

- Continue exposing `callsign` for backward compatibility.
- Add `display_name` and `maritime_identity` to live/detail payloads.
- Flatten common maritime identity fields into the response for easy UI use.

Medium term:

- Migrate frontend display logic from `callsign || track_id` to `display_name`.
- Add normalized domain identity blocks for Air and Space too.
- Reserve raw provider payloads for detail views and forensic debugging.

## Phased Delivery Plan

### Phase 1: Completed in this change

- Add a backend maritime identity/display-name resolver.
- Expose normalized maritime identity in track payloads.
- Prefer stored vessel names over raw MMSIs in live/detail API responses.
- Preserve learned names by avoiding low-quality display-name overwrites in collector persistence.

### Phase 2: Canonical Maritime Cache Hardening

- Add a dedicated refresh job that revisits maritime entities missing names.
- Resolve entities across feeds using `mmsi` and `imo`.
- Backfill `entities.display_name` from `entity_enrichments.metadata` where missing.
- Add metrics:
  - maritime assets with vessel names
  - maritime assets with IMO
  - maritime assets still showing numeric fallback only

### Phase 3: Source Expansion

- Add optional adapters for additional free or operator-contributed sources.
- Normalize all external payloads into the same maritime identity schema.
- Rank sources by trust and freshness.

### Phase 4: Frontend Migration

- Replace maritime label rendering with `display_name`.
- Show MMSI/IMO as identifiers, not titles.
- Add maritime search over:
  - `display_name`
  - `mmsi`
  - `imo`
  - `radio_callsign`
  - destination / flag / ship type

## Risks

- Vessel names can change; stale names should not be treated as permanent truth.
- Scraped sources can break without warning.
- MMSI reuse and bad upstream data can create identity collisions.
- Fishing and government vessels may have sparse or intentionally inconsistent identity data.

## Suggested Next Engineering Steps

1. Add a backend maintenance job to repair maritime `display_name` from cached enrichment rows.
2. Add API/browser search support for `imo` and `radio_callsign`.
3. Add a maritime identity health panel to show coverage gaps.
4. Extend the same normalization pattern to Air and Space so the UI has one stable `display_name` contract across all domains.

# Space Identity And Dedupe Plan

## Goal

Add a canonical identity layer for space objects so the system can ingest and reconcile data from:

- Space-Track
- CelesTrak
- N2YO
- SatNOGS
- future supplemental sources

without assuming every object is cleanly keyed by `norad_id`.

This is necessary to support:

- SatNOGS-managed identities such as `sat_id`
- provisional or partial records
- alias preservation
- multi-source provenance
- safe deduplication across sources

## Current Limitation

The current space pipeline is still centered on:

- `satellite_catalog.norad_id`
- `satellite_tles.norad_id`
- `track_id = norad_id` for space tracks

That works well for Space-Track and CelesTrak, but it makes SatNOGS-only or partially matched objects second-class citizens.

## Recommendation

Implement the identity layer incrementally.

Do not start with fuzzy dedupe.

Start with:

1. canonical identity tables
2. deterministic exact-match resolution
3. dual-write support in the collector
4. later candidate matching and review workflow

## Target Data Model

### `space_objects`

Canonical object table.

Suggested fields:

- `id` UUID primary key
- `canonical_name` text
- `object_class` text
- `status` text
- `classification` text
- `metadata` jsonb
- `review_status` text
- `created_at`
- `updated_at`

Purpose:

- one internal record per real satellite or tracked space object

### `space_object_ids`

External identifier mapping table.

Suggested fields:

- `id` bigserial or UUID
- `space_object_id` FK to `space_objects`
- `source` text
- `id_type` text
- `id_value` text
- `is_primary` boolean
- `confidence` numeric or text
- `created_at`
- `updated_at`

Examples:

- `source=spacetrack`, `id_type=norad_cat_id`, `id_value=25544`
- `source=satnogs`, `id_type=satnogs_sat_id`, `id_value=XSKZ-...`
- `source=global`, `id_type=intl_designator`, `id_value=1998-067A`
- `source=alias`, `id_type=name_alias`, `id_value=ISS`

Purpose:

- preserve all source-native IDs
- support reverse lookup
- support multi-source matching

### `space_object_tles`

Canonical TLE history table.

Suggested fields:

- `space_object_id` FK
- `epoch`
- `tle_line1`
- `tle_line2`
- `source`
- `source_object_id` nullable
- `ingested_at`

Purpose:

- TLE history attached to canonical objects rather than only NORAD IDs

### Optional: `space_object_links`

For duplicate candidates or analyst-reviewed relationships.

Suggested fields:

- `space_object_id`
- `related_space_object_id`
- `link_type`
- `confidence`
- `status`
- `notes`

Purpose:

- represent "possible duplicate", "confirmed same", or "related mission" edges

## Matching Strategy

Use deterministic rules first.

Only use fuzzy matching for review candidates.

### Auto-merge rules

Allowed for automatic reconciliation:

1. exact `norad_cat_id`
2. exact `satnogs_sat_id`
3. exact `intl_designator`
4. exact TLE object number with compatible epoch and compatible name
5. SatNOGS `norad_follow_id` maps to an existing canonical object

### Candidate-only rules

Do not auto-merge on these alone:

- normalized name similarity
- operator overlap
- country overlap
- launch date proximity
- similar orbit and TLE characteristics

These should create a candidate link or review queue item.

### Hard rule

Never auto-merge on name alone.

## Source Trust Model

Different sources should be trusted differently by field.

Recommended precedence:

- orbital data: `spacetrack` > `satnogs` > `n2yo` > `celestrak`
- radio/transmitter metadata: `satnogs` > others
- curated display naming: local overrides > stable source names
- aliases: preserve all, do not overwrite

This should be implemented per field, not as a blanket "best source wins everything".

## Collector Changes

The space collector needs a resolver stage before persistence.

Instead of:

- ingest source record
- key by `norad_id`
- upsert directly

the new flow should be:

1. ingest source record
2. extract all identifiers
3. resolve to existing `space_object`
4. if no exact match exists, create a new canonical object
5. write source identifiers into `space_object_ids`
6. write TLEs into `space_object_tles`
7. continue emitting live tracks

Track events should carry:

- canonical `space_object_id`
- source-native identifier metadata

## API Changes

Add canonical object APIs without immediately removing NORAD-based endpoints.

Suggested additions:

- `GET /api/space/objects`
- `GET /api/space/objects/{space_object_id}`
- `GET /api/space/objects/{space_object_id}/tles`
- `GET /api/space/objects/{space_object_id}/ids`

Compatibility:

- keep existing NORAD-based routes
- add reverse lookup from NORAD to canonical object

## Frontend Changes

Frontend changes should follow backend stabilization.

Eventually:

- selected space asset should use canonical `space_object_id`
- detail panels should show:
  - canonical name
  - aliases
  - source mappings
  - provenance
  - confidence or review state

This is a smaller effort than the backend/model work.

## Recommended Delivery Phases

### Phase 1

Schema and backfill foundation.

Deliver:

- `space_objects`
- `space_object_ids`
- migration to backfill current `satellite_catalog` NORAD rows into canonical records
- deterministic identity resolver for exact IDs only

Outcome:

- canonical identity exists
- current NORAD-backed data remains functional

### Phase 2

Dual-write collector support.

Deliver:

- collector writes to both old tables and new canonical tables
- reverse lookup helpers
- exact-match resolver in live ingestion

Outcome:

- no frontend breakage
- new identity model receives real data

### Phase 3

Supplemental-source reconciliation.

Deliver:

- SatNOGS-only and N2YO supplemental objects flow through canonical tables
- duplicate candidate generation
- provenance-aware field merge logic

Outcome:

- partial and non-NORAD-first objects become first-class

### Phase 4

API and UI migration.

Deliver:

- canonical-object API endpoints
- frontend migration from NORAD-only assumptions
- detail views for aliases, source IDs, and provenance

Outcome:

- user-facing model reflects real source complexity

### Phase 5

Review workflow and fuzzy matching.

Deliver:

- candidate review queue
- analyst merge/reject actions
- audited link resolution

Outcome:

- safe handling of ambiguous identities

## Effort Assessment

This is not a one-file change.

Rough effort shape:

- schema and migrations: medium
- collector resolver and dual-write flow: medium to large
- API compatibility layer: medium
- review workflow: medium

## Practical First Slice

If implementation begins later, the recommended first slice is:

1. add `space_objects`
2. add `space_object_ids`
3. backfill current NORAD catalog rows
4. keep existing `satellite_catalog`, `satellite_tles`, and track APIs working
5. resolve exact IDs only

This gets most of the structural benefit without taking on fuzzy dedupe risk too early.

## Non-Goals For The First Slice

Do not include these in the first implementation:

- fuzzy merge by name similarity
- analyst review UI
- replacing all NORAD-based endpoints immediately
- frontend-wide migration to canonical IDs in one pass

## Final Recommendation

Build the identity layer incrementally.

Start with canonical tables and exact-match resolution only.

Treat fuzzy dedupe and review tooling as a later phase, not part of the foundation.

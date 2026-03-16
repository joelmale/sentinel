# Table Catalog

This appendix summarizes the current major tables and materialized views defined in [docker/timescaledb/init.sql](/Users/JoelN/Coding/sentinel/docker/timescaledb/init.sql).

## Canonical entity model

| Name | Purpose | Key | Time column | Geometry | Primary writers | Primary readers |
| --- | --- | --- | --- | --- | --- | --- |
| `entities` | Canonical real-world entities across asset/disruption domains | `entity_id` | `updated_at` | none | [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) | routes, collectors |
| `entity_identifiers` | External identifiers and aliases per entity | `id` | `last_seen` | none | [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) | identity resolution, future detail APIs |
| `asset_identity_resolutions` | Feed-local track to canonical entity mapping | `(source_domain, source_feed, track_id)` | `last_resolved_at` | none | [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) | collector write path, live routes |
| `entity_assertions` | Time-series attribute assertions with provenance | `assertion_id` | `asserted_at` | none | collectors/base enrichment path | future conflict-aware reads |
| `entity_impacts` | Relationship edges between entities | `impact_id` | `updated_at` | none | disruption correlation paths | disruption analysis |
| `entity_enrichments` | Stable normalized enrichment fields | `entity_id` | `updated_at` | none | collectors, enrichment services | detail routes, asset cards |
| `sources` | Registered source feeds | `source_feed` | `updated_at` | none | [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) | overview, ops panels |
| `source_runs` | Collector run lifecycle and health | `run_id` | `started_at` | none | [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) | overview, ops telemetry |

## Tracking and current state

| Name | Purpose | Key | Time column | Geometry | Primary writers | Primary readers |
| --- | --- | --- | --- | --- | --- | --- |
| `asset_observations` | Raw normalized asset evidence | `observation_id` | `observed_at` | `position` | [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) | future audit/evidence paths |
| `track_events` | Historical track samples for replay/history | `event_id` | `timestamp` | `position` | [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) | [api/routers/tracks.py](/Users/JoelN/Coding/sentinel/api/routers/tracks.py), overview aggregates |
| `asset_source_states` | Feed-scoped latest known state | `id` | `last_seen` | `position` | [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) | fusion logic, alert/overview reads |
| `asset_current_state` | Fused current state per canonical entity | `entity_id` | `last_seen` | `position` | [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) | [api/routers/tracks.py](/Users/JoelN/Coding/sentinel/api/routers/tracks.py), alerts, overview |
| `asset_states` | Legacy compatibility current-state cache | `id` | `last_seen` | `position` | [BaseCollector](/Users/JoelN/Coding/sentinel/collectors/base/base_collector.py) | compatibility fallbacks |

## Analyst workflow

| Name | Purpose | Key | Time column | Geometry | Primary writers | Primary readers |
| --- | --- | --- | --- | --- | --- | --- |
| `annotations` | Analyst annotations linked to map/time context | `id` | `created_at` | `position` | [api/routers/annotations.py](/Users/JoelN/Coding/sentinel/api/routers/annotations.py) | frontend annotation UI |
| `regions_of_interest` | Saved AOIs | `id` | `created_at` | `geometry` | API/admin paths | alert rules, future AOI workflows |
| `alert_rules` | Alert rule definitions | `id` | `created_at` | none | alert management paths | alert evaluator |
| `alert_events` | Fired alert history | composite hypertable row | `triggered_at` | none | [api/alert_evaluator.py](/Users/JoelN/Coding/sentinel/api/alert_evaluator.py) | [api/routers/alerts.py](/Users/JoelN/Coding/sentinel/api/routers/alerts.py), overview |

## Disruptions and environment

| Name | Purpose | Key | Time column | Geometry | Primary writers | Primary readers |
| --- | --- | --- | --- | --- | --- | --- |
| `disruption_events` | Latest canonical disruption state | `id` | `last_seen` | `geometry`, `centroid` | collector disruption paths | [api/routers/disruptions.py](/Users/JoelN/Coding/sentinel/api/routers/disruptions.py), dashboards |
| `disruption_observations` | Time-series disruption evidence | observation key | `observed_at` | geometry payload | collector disruption paths | disruption history |

## Space-specific

| Name | Purpose | Key | Time column | Geometry | Primary writers | Primary readers |
| --- | --- | --- | --- | --- | --- | --- |
| `satellite_catalog` | Persistent satellite metadata | `norad_id` | `last_updated` | none | [collectors/space/collector.py](/Users/JoelN/Coding/sentinel/collectors/space/collector.py) | [api/routers/satellites.py](/Users/JoelN/Coding/sentinel/api/routers/satellites.py), asset detail |
| `satellite_tles` | Historical TLE snapshots | `(norad_id, epoch)` | `epoch` | none | [collectors/space/collector.py](/Users/JoelN/Coding/sentinel/collectors/space/collector.py) | [api/routers/satellites.py](/Users/JoelN/Coding/sentinel/api/routers/satellites.py) |
| `space_watchlist_status` | Curated watchlist health/status | `watch_id` | `updated_at` | none | [collectors/space/collector.py](/Users/JoelN/Coding/sentinel/collectors/space/collector.py) | space dashboard |

## Aggregates

| Name | Purpose | Key | Time column | Geometry | Primary writers | Primary readers |
| --- | --- | --- | --- | --- | --- | --- |
| `track_events_1min` | 1-minute activity aggregate | bucket/domain | `bucket` | none | Timescale continuous aggregate policy | overview/activity surfaces |
| `track_events_hourly` | 1-hour activity aggregate | bucket/domain | `bucket` | none | Timescale continuous aggregate policy | historical trend surfaces |

## Notes

- `track_events`, `asset_observations`, `entity_assertions`, and `alert_events` are hypertables or time-series-backed structures.
- `asset_current_state` is the intended fused live-state surface.
- `asset_states` should be treated as transitional compatibility storage.

# Disruption Sources Roadmap

## Overall Approach

Build the disruption stack in phases, starting with sources that are operationally credible, easy to correlate, and structurally useful across domains.

The goal is not to add the most feeds. The goal is to create a system that can answer:

- what happened
- where
- when
- how severe
- what else was affected
- what likely caused it

The right architecture is:

- `signal -> normalized event -> correlation -> operator workflow`

Do not treat every source as just another map layer.

## Phase 1: Core Disruption Baseline

Objective: establish reliable first-party disruption events with immediate operational value.

### Sources

- NOAA / NWS alerts and weather observations
- USGS earthquake feeds
- GPSJam as inferred GNSS interference
- IODA for internet outage detection

### Why First

- These are high-signal and broadly explanatory.
- They cover weather, seismic, connectivity, and GNSS interference, which already explain a large percentage of operational disruption patterns.

### Build

- `disruption_events` table
- `disruption_tiles` or gridded overlay table for heatmap-style products like GPSJam
- source adapters for:
  - polygon alerts
  - point events
  - grid/heat layers
- common fields:
  - `event_id`
  - `source`
  - `event_type`
  - `category`
  - `severity`
  - `confidence`
  - `start_time`
  - `end_time`
  - `geometry`
  - `metadata`
  - `raw_source_ref`

### Event Types To Support Immediately

- `weather_alert`
- `earthquake`
- `gps_interference`
- `internet_outage`

### Alert Logic

- trigger on new high-severity weather polygons intersecting tracked regions
- trigger on GPSJam threshold exceedance
- trigger on IODA outage onset or large drop event
- trigger on earthquakes above configurable magnitude within monitored AOIs

### UI Outcome

- disruption overlay toggle group
- timeline markers for disruption events
- basic event card with geometry, severity, start/end, source, confidence

## Phase 2: Aviation And Maritime Operational Impact

Objective: connect disruption signals to transport operations, not just show hazards.

### Sources

- FAA NOTAM / GNSS interference / nav outage context
- AISStream live maritime
- ADS-B feeds already present
- optional marine weather warnings if not already covered through NWS marine products

### Build

- NOTAM ingestion focused on:
  - GPS/GNSS interference
  - navaid outages
  - airport operational restrictions
- correlation jobs:
  - GNSS interference vs ADS-B track thinning
  - weather vs airport disruption
  - maritime weather vs vessel density drop
  - internet outage vs airport/port region degradation

### Derived Event Types

- `aviation_navigation_disruption`
- `airport_operational_constraint`
- `maritime_density_anomaly`

### Detection Rules

- if GPSJam exceeds threshold and FAA GNSS-related NOTAM exists in same region/time, increase confidence
- if ADS-B density drops sharply without weather, flag as suspicious degradation
- if AIS density drops near coast/port alongside weather or outage, classify probable environmental disruption

### UI Outcome

- incident detail panel gains:
  - related airports
  - related ports
  - impacted flights/vessels count
  - confidence ladder
- map can pivot from disruption-first to asset-impact-first

## Phase 3: Infrastructure And Grid Context

Objective: explain whether the disruption is environmental, cyber-physical, utility-related, or multi-system.

### Sources

- EIA power operational data
- public outage aggregators like PowerOutage.us
- Cloudflare Radar Outage Center
- continue IODA

### Build

- normalized infra event types:
  - `power_grid_stress`
  - `customer_power_outage`
  - `internet_outage`
  - `traffic_anomaly`
- region/entity models:
  - balancing authorities
  - utilities
  - ASNs / countries / metros
- correlation rules:
  - internet outage + customer outage + weather = likely storm-driven
  - internet outage without power/weather = possible telecom/routing incident
  - grid stress + cellular/internet degradation = systemic infrastructure event

### Priority Logic

- official/system telemetry outranks public outage counts
- public outage counts are supporting evidence, not primary truth

### UI Outcome

- infrastructure status panel
- regional outage summary cards
- likely-cause suggestions based on multi-source correlation

## Phase 4: Historical Analysis And Incident Reconstruction

Objective: make Sentinel useful for after-action review, pattern analysis, and recurring event detection.

### Build

- event stitching service
  - groups related source records into one incident
- incident model:
  - `incident_id`
  - primary cause hypothesis
  - contributing factors
  - affected domains
  - impacted area
  - timeline of evidence
- before/during/after analytics
- replay overlays:
  - disruption onset
  - asset behavior change
  - outage spread
  - recovery

### Correlation Products

- GPS interference preceded ADS-B degradation by 12 minutes
- internet outage began 7 minutes after balancing authority stress spike
- earthquake likely driver of telecom and power disruption

### UI Outcome

- true Incident Review screen
- event timeline with linked evidence
- saved investigations and analyst annotations

## Phase 5: Advanced Network And RF Intelligence

Objective: deepen technical attribution where needed.

### Sources

- RIPE RIS Live
- optional BGPStream-style routing feeds
- GPSWise / Stanford / additional GNSS and RF sources
- possibly FCC / DIRS if operational access is available

### Build

- routing anomaly event types:
  - `bgp_leak`
  - `route_withdrawal_spike`
  - `asn_isolation`
- RF-specific event types:
  - `spoofing_suspected`
  - `jamming_suspected`
- confidence fusion:
  - inferred-only
  - inferred + official notice
  - inferred + operational impact
  - multi-source confirmed

### UI Outcome

- advanced network/RF analysis panel
- operator-selectable confidence filters
- deeper technical evidence view for specialist users

## Phase 6: Watchlists, Prioritization, And Operational Workflows

Objective: turn the disruption stack into a real monitoring system.

### Build

- AOI watchlists
- infrastructure watchlists
- airport/port/watch asset bundles
- alert policies:
  - threshold-based
  - correlation-based
  - persistence-based
- triage workflow:
  - new
  - acknowledged
  - investigating
  - escalated
  - resolved

### Alert Examples

- High-confidence GNSS disruption affecting monitored airport cluster
- Regional internet outage overlapping tracked naval corridor
- Weather + power + telecom cascade in watch region

### UI Outcome

- alert queue
- watchlist health panels
- incident workbench
- cross-domain impact summaries

## Data Model Recommendations

Add these core tables early:

- `disruption_events`
- `disruption_observations`
- `incidents`
- `incident_links`
- `watch_regions`
- `watch_entities`
- `source_health_status`

Keep `disruption_events` as normalized records and `disruption_observations` as source-native evidence. Do not collapse all raw feeds directly into one event row without preserving provenance.

## Source Priority And Trust

Use this trust order:

- Official restrictions and hazard notices:
  - FAA
  - NWS
  - USGS
- System telemetry:
  - EIA
  - IODA
  - Cloudflare Radar
- Inferred interference:
  - GPSJam
  - Stanford
  - GPSWise
- Public aggregation:
  - PowerOutage.us

Confidence should be computed, not hardcoded.

Examples:

- single inferred source: low to medium
- inferred + official notice: high
- inferred + official + observed transport degradation: very high

## Suggested Implementation Order In This Repo

1. Add normalized disruption schema and source adapters for NWS, USGS, GPSJam, IODA.
2. Build map/timeline support for disruption events.
3. Add FAA NOTAM correlation for GNSS and navigation outages.
4. Add Cloudflare Radar and EIA.
5. Build incident stitching and historical review.
6. Add advanced routing/RF sources.

## Near-Term Delivery Plan

### Sprint 1

- schema
- NWS
- USGS
- GPSJam normalization
- basic disruption map/timeline

### Sprint 2

- IODA
- first disruption alerts
- AOI intersection logic
- event detail cards

### Sprint 3

- FAA NOTAM
- ADS-B/AIS correlation
- aviation/maritime impact summaries

### Sprint 4

- Cloudflare Radar
- EIA / public outage overlay
- incident stitching v1

### Sprint 5

- saved investigations
- cross-domain incident review
- confidence scoring improvements

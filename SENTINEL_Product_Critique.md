# SENTINEL — Product Strategy Critique

**Date:** 2026-03-09
**Status:** Prototype evaluation
**Reviewer posture:** Opinionated product strategist / OSINT platform architect

---

## 1. Product Thesis Assessment

Sentinel's implicit thesis is: *"A self-hosted, open-source common operating picture that fuses multi-domain OSINT feeds into a single map with time-travel playback."*

That thesis is structurally sound but currently lacks a verb — it describes what the platform *shows* but not what it helps someone *do*. The strongest operational tools aren't dashboards; they're workflow accelerators. A COP that only displays is a screensaver with an API key budget. The thesis needs to evolve from "see everything" to "notice what matters and act on it."

The technical architecture, however, is significantly ahead of where most prototypes land at this stage. The choice of TimescaleDB with hypertables, PostGIS spatial indexing, Redis Streams for real-time fan-out, and a collector-per-domain microservice pattern is not toy architecture — it's the skeleton of a production system. The database schema in particular (compression policies, retention windows, materialized rollup views, alert_rules with JSONB conditions) shows someone thinking about the operational lifecycle, not just the demo.

The gap is between what the infrastructure can support and what the product actually delivers to a user sitting in front of it. Right now Sentinel is a well-plumbed building with no furniture.

**Verdict:** The thesis is 70% there. The remaining 30% is the difference between "multi-domain situational awareness" (a capability) and a specific operational workflow that makes someone's job measurably easier.

---

## 2. Best-Fit User Personas Today

Given what's actually built — live ADS-B and AIS ingestion, a map with layer toggling, an asset detail card, and time-range historical queries — the prototype is most immediately useful to:

**Primary: The OSINT hobbyist-analyst.** Someone who already monitors ADS-B Exchange or MarineTraffic in separate browser tabs and wants a unified view. They track military refueling tankers, unusual maritime patterns near contested waters, or satellite overflight windows. They're technically capable (comfortable with Docker, API keys, terminal commands). They don't need polish — they need data density and the ability to correlate across domains. This person is your most honest beta tester because they already do this workflow manually and can tell you exactly what's missing.

**Secondary: The small-team SIGINT/GEOINT watch floor.** Think a 3–8 person operations cell at an NGO doing maritime domain awareness (illegal fishing, sanctions evasion), a conflict monitoring organization, or a private security firm tracking assets in a region. They need a shared operational picture but can't afford Palantir or BAE Systems pricing. They're willing to self-host. They care about historical playback because their workflow is often retrospective — "what happened in this area last Tuesday?"

**Not yet viable for:** Enterprise SOCs, military C2 systems, or anyone who needs certification, audit trails, role-based access, or integration with classified networks. Keycloak is stubbed but not wired; the audit_log table exists but nothing writes to it; there's no concept of user sessions or shared annotations.

---

## 3. Best-Fit User Personas Later

**Near-term (3–6 months):** Maritime domain awareness teams. This is where the product-market signal is strongest in open-source OSINT right now. AIS data is the richest freely available domain, the workflows are well-understood (dark vessel detection, sanctions screening, fishing zone enforcement), and the competition at the self-hosted tier is weak. If Sentinel becomes the best open-source tool for "show me every vessel in this bounding box for the last 72 hours, flag the ones that went dark, and overlay GPS jamming data," it has a real user base.

**Medium-term (6–12 months):** Conflict monitoring and humanitarian organizations. Groups like Bellingcat, C4ADS, the Global Fishing Watch community, or ACLED-adjacent researchers. They need temporal correlation (did military flights increase before this incident?), annotation workflows (tag, label, share findings), and exportable evidence packages. This requires the annotation system and alert rules to be fully functional.

**Long-term (12+ months):** Commercial security operations centers. Port security, supply chain monitoring, insurance underwriters tracking vessel risk. This requires multi-tenancy, SSO, API access for integration with existing tools, and probably a managed hosting option.

---

## 4. What the Prototype Already Gets Right

**The collector architecture is genuinely good.** The BaseCollector pattern — async lifecycle, exponential backoff, batch writes to TimescaleDB plus Redis Stream publish — is exactly the right abstraction. Each collector is an independent service with its own Dockerfile, which means you can scale, restart, or replace any single feed without touching the rest. This is the kind of foundation that's painful to retrofit later, and it's already done correctly.

**The database schema is overbuilt in the right way.** Hypertable partitioning by day with 7-day compression and 90-day retention is a real operational choice, not a tutorial default. The materialized views for 1-minute and hourly rollups show someone thinking about query performance at scale. The GIST spatial indexes on both track_events and asset_states mean bounding-box queries will be fast even with millions of rows. The alert_rules table with JSONB conditions is flexible enough to support complex rule evaluation without schema migrations.

**Real-time data pipeline works end-to-end.** Collector → TimescaleDB → Redis Stream → WebSocket → browser is a complete loop. The useLiveStream hook handles reconnection with backoff. The Zustand store cleanly separates concerns (assets, layers, playback, selection, panels). This is not a mock-up — data actually flows.

**The AIS collector is surprisingly complete.** It handles three ingestion modes (WebSocket live, historical CSV/ZIP, AISHub placeholder), does vessel classification by ship type code, converts units properly, and handles flexible column names in CSV imports. This level of robustness in a single collector suggests the developer has actually tried to use their own tool with real data.

**Docker Compose with profiles is the right deployment model.** Making Keycloak and Grafana opt-in via `--profile auth` and `--profile monitoring` is a small but important decision. It means the default `docker compose up` starts only what's needed, which reduces the barrier to first run. The Makefile targets (psql, redis-cli, shell-api, reset-db) show someone who's actually developing against this stack daily.

---

## 5. Product Gaps and Scope Problems

### The Five-Domain Trap

Sentinel tries to cover Air, Maritime, Space, GPS, and Infrastructure simultaneously. Three of these five collectors are stubs. The frontend only renders one domain's data as actual map layers (Air via ScatterplotLayer). This means the product is nominally "multi-domain" but functionally "ADS-B with an AIS sidecar."

This isn't a code problem — it's a scope problem. Each domain has different data shapes, update frequencies, visualization needs, and user mental models. Aircraft are point objects moving fast. Vessels are point objects moving slowly with complex identity metadata. Satellites are orbital objects with predicted tracks. GPS jamming is a hexagonal heatmap. Infrastructure outages are regional polygons. Trying to render all five well on the same map, with the same layer controls, same timeline, same asset card — that's five visualization products wearing a trenchcoat.

**Recommendation:** Pick two domains and make them excellent. Air + Maritime is the natural pair. They share the same geographic canvas (the map), have complementary update rates, and their correlation is operationally interesting (vessel near an unusual aircraft pattern, helicopter approaching a vessel). GPS jamming is the best third domain because it overlays contextually onto both.

### No Alerting Loop

The database has alert_rules and alert_events tables. The WebSocket protocol includes an `alert` message type. But there is no code that evaluates rules, generates alerts, or delivers notifications. This is the single biggest product gap because alerting is what turns a dashboard into a tool. Without it, Sentinel requires a human to stare at the screen — and humans are terrible at sustained monitoring. The entire value proposition of a COP is "tell me when something changes that I care about."

### No Correlation Engine

The data model stores events per domain independently. There's no mechanism to say "this aircraft and this vessel were in proximity at time T" or "GPS jamming increased in this region while these flights were overhead." Cross-domain correlation is the entire reason to build a multi-domain platform. Without it, you have five separate single-domain trackers sharing a database.

### Playback Is Aspirational

The TimelinePanel has a live mode that works and a replay mode with UI controls, but the actual replay pipeline — fetching historical data for a time window, feeding it to deck.gl TripsLayer, synchronizing playback across domains — is not implemented. The store has `tickPlayback()` which advances time, but nothing consumes that time to drive visualization. This is architecturally hard because it requires time-windowed queries to the API, client-side event buffering, and synchronized layer rendering. It's also the most compelling demo feature, so it needs to work well or not be shown at all.

### Annotation Workflow Is Incomplete

The API has CRUD for annotations and the database schema is solid, but there's no frontend annotation UI. You can't click the map and drop a note. You can't link an annotation to a track. The AssetCard has an "Annotate" button that's labeled as Phase 5 TODO. For an intelligence platform, annotation is the primary output — it's how analysts record findings. Deferring it to Phase 5 means the platform can't produce any durable analytical output.

### No Data Export

There is no way to export a track's history, a time window of events, or a set of annotations as CSV, GeoJSON, or KML. For OSINT analysts, export is a core workflow — they need to take findings out of the tool and into reports, share them with colleagues, or feed them into other analysis tools. This is a low-effort, high-value gap to close.

---

## 6. Recommended Focus for the Next Version

The next version should answer one question convincingly: **"Can Sentinel help me detect and investigate something I would have missed otherwise?"**

That means three things need to work:

**A. Alerting (geofence + classification triggers).** Implement the simplest useful alert: "Notify me when a military-classified aircraft enters this bounding box" or "Notify me when a vessel goes dark (stops transmitting AIS) inside this region." The alert_rules table already supports this — the missing piece is a rule evaluation loop. Run it as a lightweight service (or a periodic task in the API) that queries asset_states against active rules and publishes matches to the WebSocket and optionally to a webhook.

**B. Historical playback for Air + Maritime.** Make the TripsLayer work for ADS-B and AIS trails. Fetch track history from the API for a selected time window, render trails with time-decay coloring (recent = bright, old = dim), and let the scrubber control the visible time slice. This is the "rewind the tape" feature that makes retrospective investigation possible. It doesn't need to be frame-perfect — a 1-minute granularity replay with smooth interpolation is sufficient.

**C. Basic data export.** Add a "Download" button to the track history query results. GeoJSON is the format that matters most (it's natively spatial, can be opened in QGIS, and round-trips through the API). CSV as a secondary format for spreadsheet users. This can be a simple API endpoint — `/api/tracks/export?format=geojson&t_start=...&t_end=...&domain=...&bbox=...`.

---

## 7. Features to Defer or Remove

**Defer:**

- **Space collector and visualization.** Satellite tracking requires TLE propagation with a library like Skyfield, which is a significant implementation effort for a niche audience. The operational payoff (knowing when an imaging satellite overflies a location) is real but narrow. Defer until the Air + Maritime experience is polished.

- **Infrastructure outage collector.** IODA and PowerOutage.us data is useful context but it's not actionable on its own. It becomes valuable only when correlated with other events ("internet went down in this region while these vessels were nearby"). Defer until the correlation engine exists.

- **Keycloak / multi-user auth.** Single-user self-hosted is the right target for now. Auth adds complexity to every API endpoint and every frontend interaction. When users start asking for shared instances, that's the signal to build it.

- **Grafana operational dashboards.** The provisioning paths are set up, but no one needs Grafana dashboards for a prototype. The TimescaleDB materialized views (1-min and hourly rollups) are the right foundation — add Grafana later when you need to debug collector throughput in production.

- **Annotation linking to tracks.** Simple map annotations (click to pin, add a label) should come first. Linking annotations to specific tracks at specific timestamps is a harder UX problem and should be tackled after basic annotation works.

**Remove (or reclassify as plugins):**

- **AISHub collector mode.** It's intentionally disabled because it requires a reciprocal feed. Remove the code path entirely — it adds confusion and maintenance burden for zero current value.

- **collector-ais-history as a separate Docker service.** Historical AIS import is a one-shot batch operation, not a running service. Make it a CLI command (`python -m collectors.ais.import_csv path/to/data.csv`) rather than a Docker service with a profile. This simplifies the compose file and makes the import operation more discoverable.

---

## 8. 30-Day Product Priorities

**Week 1–2: Alerting MVP**

Implement the simplest alert pipeline: a background task (asyncio loop in the API service, or a new lightweight `alert-evaluator` service) that runs every 30 seconds, queries `asset_states` against `alert_rules` where `enabled = true`, evaluates JSONB conditions (domain match, bbox containment via PostGIS, classification match), and writes matches to `alert_events` + publishes to the WebSocket `alert` channel.

Frontend: Add an alert badge/indicator to the header. Show a slide-in notification when an alert fires. Link the notification to the relevant asset in the AssetCard.

Don't build a rule editor UI yet — seed rules via SQL or a simple API call. The point is to prove the evaluation loop works.

**Week 2–3: TripsLayer Playback**

Wire up the replay pipeline: when the user sets a time window and hits play, fetch `/api/tracks/history` for that window, transform the result into deck.gl TripsLayer format (`{path: [[lon,lat,alt],...], timestamps: [ms,...]}` per track_id), and render with `currentTime` driven by `tickPlayback()`. Start with ADS-B only — it has the highest data density and the most visually compelling trails.

Add a "breadcrumb" mode: instead of animated playback, just show the full trail for a selected track colored by time. This is simpler to implement and arguably more useful for investigation.

**Week 3–4: Export + Map Annotations**

Add `/api/tracks/export` endpoint (GeoJSON + CSV). Add a "Download" button to the SourcePanel or a new export dialog.

Implement basic map annotations: click the map to place a pin, enter a label and optional body text, save via the existing annotations API. Render annotation markers as a deck.gl TextLayer or IconLayer. This closes the loop from "see something" to "record something."

---

## 9. 90-Day Product Direction

By day 90, Sentinel should be a credible maritime domain awareness tool that also happens to show aircraft.

**Month 1 (above):** Alerting, playback, export, annotations.

**Month 2: Maritime focus features.**

- Vessel identity enrichment: when an AIS message includes an MMSI, resolve it to vessel name, flag state, ship type, and IMO number via a local lookup table (ITU publishes MMSI ranges by country; community databases like MarineTraffic's open data or the EU vessel registry provide mappings). Display these in the AssetCard.

- "Dark vessel" detection: identify vessels that stop transmitting AIS while inside a region of interest. This is the simplest useful anomaly detector and a core maritime surveillance workflow. Implementation: track last-seen timestamps in `asset_states`, run a periodic check for assets where `last_seen` exceeds a threshold (configurable, default 30 minutes), generate an alert if the vessel was inside an active ROI when it went dark.

- GPS jamming overlay: implement the GPSJam collector (H3 hex tiles) and render as an H3HexagonLayer with color-coded severity. This is valuable because GPS jamming correlates with both maritime and air domain anomalies — vessels spoofing their positions often appear in areas with GPS interference.

**Month 3: Investigation workflow.**

- Track history timeline: for a selected asset, show a vertical timeline of all events (position reports, alert triggers, annotations) in the AssetCard. This replaces "go query the database" with "click the track, scroll through its story."

- Saved views / bookmarks: let users save a viewport + time window + layer configuration + active filters as a named view. This is the primitive for "monitoring a specific situation." Implementation: a new `saved_views` table with viewport JSON, layer state JSON, and time window.

- Shareable investigation URLs: encode the current view state (viewport, time window, selected track, layers) in the URL hash or query params. This lets analysts share a specific moment by pasting a link. No auth needed for single-user instances.

- Basic correlation query: "show me all assets within N km of this point during time window T." This is the first cross-domain correlation primitive — it answers "what else was nearby?" which is the most common investigative question.

---

## 10. Hard Truths / Uncomfortable Recommendations

**You're building five products and finishing none.** Five collector domains, five visualization layer types, five sets of domain-specific metadata in the AssetCard — but only one domain actually renders on the map with real data flowing. Users don't care about architecture; they care about whether the tool shows them something they can act on. Ship Air + Maritime as complete experiences, with trails, alerts, and export, before touching Space, GPS, or Infra.

**The "common operating picture" framing is a trap.** COP is a military concept that implies shared situational awareness across a command structure. That requires authentication, role-based views, shared annotations, audit trails, and real-time collaboration. Sentinel has none of these. Calling it a COP sets expectations you can't meet. Call it what it actually is right now: a multi-source OSINT monitor with temporal replay. That's still compelling — it just doesn't carry the baggage of implying institutional readiness.

**Playback is your demo, but alerting is your product.** The ability to rewind and replay is visually impressive and great for investigation. But the feature that makes someone keep Sentinel running 24/7 is alerting — "tell me when something interesting happens so I don't have to watch." If you have to choose between polishing playback and shipping alerting, ship alerting.

**The frontend needs a loading state and an empty state.** Right now, if no data is flowing (no API keys configured, collector down, network issue), the user sees an empty map with zero feedback about what's wrong. The first-run experience is critical for an open-source project. Add a status panel that shows collector health, last-received timestamps per domain, and clear messages about what's missing ("No ADS-B data. Configure OPENSKY_USERNAME in .env to enable aircraft tracking.").

**You need a "first 10 minutes" experience.** A new user who clones the repo, runs `make up`, and opens the browser should see something useful within 10 minutes. Right now that requires configuring API keys for external services, which means reading docs, creating accounts, waiting for approvals. Consider bundling a small sample dataset (a few hours of ADS-B + AIS data as a SQL dump or CSV) that auto-loads on first run, so the platform shows historical data immediately while the user configures live feeds. This is the difference between "cool, it works" and "I'll come back to this later" (they won't).

**Test coverage is zero.** pytest and eslint are configured but no tests exist. For a data pipeline platform, the highest-value tests are integration tests on the collectors (does the ADS-B parser handle OpenSky's actual response format, including edge cases like null positions?) and on the spatial queries (does the bbox filter actually return the right tracks?). You don't need 90% coverage — you need 10 tests that catch the failures that would make the platform silently wrong.

**The Makefile is your user interface.** For a self-hosted tool targeting technical users, the Makefile is more important than the web UI for onboarding. Add `make seed-sample-data`, `make check-health` (curl all health endpoints and report status), and `make watch-collector DOMAIN=adsb` (tail logs for a specific collector with human-readable formatting). These are 30-minute tasks that dramatically improve the developer experience.

---

*This document is a point-in-time assessment. The architectural foundation is strong. The risk is not technical — it's scope discipline. Sentinel doesn't need more features; it needs fewer features that work completely.*

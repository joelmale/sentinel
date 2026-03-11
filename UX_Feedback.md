Overall UX Assessment
  Sentinel is a strong visualization prototype, but it is not yet a strong operational workflow. The current UX centers the map as the primary object
  and treats analysis as secondary. That works for situational awareness demos, but it breaks down for real monitoring, investigation, and incident
  reconstruction.

  The current structure suggests this operator loop: watch the map, click a track, inspect a detail card, scrub time, toggle a few layers. That is
  useful for seeing activity, but too shallow for answering harder ISR questions such as: what changed, why does this matter, what is abnormal, what
  is correlated across domains, and what should I act on next.

  The prototype is visually coherent and already has the right basic primitives, but it needs to evolve from “map with supporting widgets” into
  “analyst workspace with a map as one instrument.” The current composition in App.tsx, SourcePanel.tsx, TimelinePanel.tsx, and AssetCard.tsx shows
  good intent, but still prioritizes display over investigation.

  What The Current Prototype Gets Right

  - The product already thinks in operational domains rather than one generic asset list. That is the correct frame for ISR/C2.
  - The header and timeline establish live vs replay as first-class modes. That is essential and correctly directional in TimelinePanel.tsx.
  - The left-side source panel is denser than a typical consumer map UI and already supports per-domain toggles, search, and classification filters in
    SourcePanel.tsx.
  - The right-side asset card is not just a tooltip. It is moving toward an object dossier, which is the right pattern in AssetCard.tsx.
  - The map rendering stack already distinguishes live positions, history, trails, and orbital paths in MapCanvas.tsx. That is analytically useful.
  - The new Space watch dashboard direction is good because it introduces monitored system state rather than only plotted tracks.

  Top Workflow Problems

  - The information architecture is track-centric, not task-centric. Operators investigate incidents, regions, anomalies, and alert queues, not just
    individual tracks.
  - The map is doing too much conceptual work. It is the default entry point for everything, but many analytical tasks should begin from alerts,
    watchlists, event clusters, or temporal changes.
  - The source panel mixes layer control, search, filtering, and entity browsing in one vertical surface. That is workable at prototype scale, but it
    will collapse under real data volume.
  - Filtering is too local and too passive. Current classification chips are basically visibility masks. They do not feel like analytical filters that
    reshape the whole workspace.
  - Live and replay modes exist, but they are not operational modes yet. They are time states, not workflow states.
  - The selected asset card is useful once an operator already knows what to click, but the system does not help operators discover what is worth
    clicking.
  - Alerts appear to be notifications rather than investigation objects. A serious ISR workflow needs alert triage, grouping, acknowledgment, context,
    and escalation.
  - The current UI still answers “where is it?” better than “what changed?”, “what is unusual?”, and “what should I look at next?”

  Recommended Primary Screens/Panels
  Sentinel should evolve toward five primary operational surfaces.

  - 1. Live Operations View
    Purpose: continuous monitoring, active alert triage, watchlist status, current anomalies.
    Keep the map, but make alert queue and watchlist state equal peers to it.
  - 2. Incident Review View
    Purpose: understand a detected event in a bounded time window and geography.
    This should pivot around the event, not around whichever track was clicked first.
  - 3. Historical Analysis View
    Purpose: replay, compare time windows, correlate multi-domain activity, and inspect before/during/after patterns.
    This needs stronger event density and temporal summarization than the current scrubber-centric replay.
  - 4. Watchlist / Collection Health View
    Purpose: curated assets, source freshness, source coverage, stale tracks, missing feeds, degraded pipelines.
    The new Space dashboard is the start of this pattern and should generalize.
  - 5. Alert Queue / Investigation Workbench
    Purpose: triage alerts, assign severity, inspect linked assets, save annotations, and build an evidence trail.

  In the current UI, I would add these panels before adding more map ornamentation:

  - a left-center alert queue panel
  - a bottom-center event density lane above the timeline
  - a right-side investigation panel distinct from the asset card
  - a top or side watchlist/health strip for source confidence and stale feeds

  Recommended Map / Layer / Filter Behavior
  The map should remain central, but it should become a controlled viewport into analysis, not the only analytic surface.

  - Layers should be grouped by function, not just by domain.
    Use groups such as:
      - live tracks
      - trails/history
      - disruption overlays
      - areas/ROIs
      - alerts/incidents
      - infrastructure/context
  - Filters should be global analytical constraints, not local row toggles.
    A filter action should affect:
      - map
      - track list
      - alert list
      - timeline
      - stats
      - detail panel
  - Domain toggles should support three states:
      - visible and active
      - muted/context-only
      - hidden
        Right now the behavior is too binary.
  - Layer priority and decluttering need stronger control.
    In dense areas the system should support:
      - aggregate mode
      - symbol thinning
      - anomaly-first rendering
      - “selected entities only” overlays
  - Disruption layers should not sit beside normal layers as equal visual decorations.
    They should be analytical modifiers with threshold controls, opacity controls, and event correlation hooks.
  - The map needs explicit analytical modes:
      - monitor
      - investigate
      - compare
      - annotate
        The same map should behave differently in each mode.

  Recommended Timeline And Playback Behavior
  The current timeline is more mature than the rest of the workflow, but it still behaves like a media player more than an analysis instrument.

  - The timeline should show activity density by domain, not just a scrubber.
  - Alerts and annotations should be visible on the time axis as markers.
  - Playback should support “jump to event” and “jump to next anomaly,” not only manual scrub.
  - Analysts need bookmarkable time slices:
      - before event
      - event window
      - after event
  - Historical analysis should support side-by-side or overlaid comparison of two windows.
  - Replay should preserve filters and selected investigation context, not reset the user into generic browsing.
  - Time controls should support linked map behavior:
      - freeze selected tracks
      - show last-known positions
      - ghost prior states
      - highlight entrants/exits to a region

  The current replay bar in TimelinePanel.tsx is strong as a foundation, but it needs event density and correlation overlays to become operationally
  credible.

  Recommended Alert And Investigation Workflow
  This is the biggest missing operational layer.

  A serious workflow should be:

  1. Alert appears in a queue with severity, source, confidence, affected domains, and region.
  2. Operator opens the alert into an investigation context.
  3. System pivots the map, timeline, filters, and related asset list to that alert automatically.
  4. Operator sees:
      - triggering conditions
      - related assets
      - nearby correlated events
      - disruption overlays active at that time
      - recent annotations in the same region
  5. Operator acknowledges, annotates, escalates, or dismisses.
  6. The investigation state becomes persistent and shareable.

  What is missing today:

  - alert queue as a first-class panel
  - alert grouping and deduplication
  - investigation state
  - saved views / saved queries
  - correlation suggestions
  - explicit severity/confidence treatment

  Right now alerts appear closer to toast notifications than case objects. That is fine for a prototype, but it is not enough for operations.

  What To Remove Or Simplify

  - Do not keep adding domain-specific visual badges in the asset card unless they support decision-making. Some of the current card richness is
    informative but not operationally essential.
  - Do not let the source panel become the place where every control goes. It already risks becoming a vertical junk drawer.
  - Avoid consumer-style “everything visible at once” behavior on the map. Dense ISR tools need controlled suppression and prioritization.
  - Reduce the number of places where counts are shown without context. Counts are useful only if tied to change, anomaly, or threshold.
  - Do not over-invest in decorative map polish before adding investigation structure.

  What To Add Next

  - A real alert queue panel with triage state.
  - A multi-domain event strip above the timeline.
  - A region-of-interest panel with saved operational areas and entry/exit logic.
  - A watchlist panel that spans all domains, not just space.
  - Investigation mode with a bounded context:
      - selected incident
      - related assets
      - time window
      - overlays
      - notes
  - Cross-domain correlation cues:
      - “GPS jamming increase overlaps with vessel loitering and ADS-B thinning”
      - “satellite pass coincides with RF event”
  - Source confidence and freshness indicators at the object level, not only in health dashboards.

  Near-Term UX Roadmap

  - Phase 1: Operational Structure
    Add alert queue, event markers on timeline, and a proper investigation context panel. This is the highest-value change.
  - Phase 2: Filter And Layer Discipline
    Convert filters into workspace-wide analytical constraints and add tri-state layer behavior plus decluttering modes.
  - Phase 3: Time-As-Analysis
    Upgrade replay with event density, bookmarks, jump-to-event, and before/during/after comparison.
  - Phase 4: Watchlists And Collection Health
    Expand the new watch dashboard pattern across domains and connect watchlists to alerting and incident review.
  - Phase 5: Analyst Persistence
    Add saved investigations, shared views, pinned objects, and persistent hypotheses/annotations.

  My blunt assessment: the prototype is already beyond a demo-grade map toy, but it is still optimized more for seeing tracks than for conducting
  analysis. The next step is not “more layers.” It is building the workflows that help an operator decide what matters, investigate it quickly, and
  preserve that work.
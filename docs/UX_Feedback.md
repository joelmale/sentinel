Overall UX Assessment
  Sentinel has moved meaningfully closer to an operational workflow since this feedback was first written. The UI is no longer just a map with a few
  controls attached to it: it now has a real alert queue, an investigation context, tri-state layer visibility, and timeline activity density.

  The remaining gap is not basic capability. It is workflow discipline. The app still leans too heavily on a track-browser mental model, especially in
  the left panel and the selected asset card. The next round of UX work should focus on reducing generic browsing behavior and strengthening the
  analyst loop: detect, focus, correlate, decide, preserve.

Current State Versus Earlier Feedback

  Completed since the original critique:

  - alert queue as a first-class panel now exists
  - alert triage and investigation context now exist
  - legacy alert toasts have been removed from the primary workflow
  - a distinct investigation context panel now exists beside the queue and asset card
  - tri-state domain visibility exists
  - timeline activity density by domain already exists

  Still true from the original critique:

  - the information architecture is still more track-centric than task-centric
  - the source panel still mixes too many responsibilities
  - filters still read more like local visibility controls than workspace constraints
  - the timeline is stronger, but still needs event-aware investigation actions
  - investigation context exists, but it is not yet persistent or collaborative

What The Current Prototype Gets Right

  - Operational domains remain the right organizing principle.
  - Live and replay are first-class modes in the timeline.
  - Alert triage now behaves more like a work surface than a notification stream.
  - Investigation can now pivot the workspace and hold bounded context.
  - The timeline already provides cross-domain activity density, which is the right foundation for time-based analysis.
  - Health/dashboard surfaces are starting to expand beyond “just draw more tracks.”

What Was Just Changed

  - Removed the old toast-style alert notifications so the alert queue is the single primary alert surface.
  - Added a compact investigation context panel so an active case is explicit and remains visible apart from the asset card.

Recommended Changes Still Remaining

  Highest impact for relatively small or moderate effort:

  - Add alert markers to the timeline and make “jump to event” a first-class action.
  - Add bookmarkable investigation windows such as before, during, and after.
  - Surface source freshness and confidence more explicitly at object and investigation level.
  - Continue tightening the source panel, but as refinement rather than a major rewrite.
    The app already has browse/workspace modes and clearer constraint language. The remaining work is to reduce residual overload, especially by moving
    overlay/settings concerns away from the analytical browsing surface.
  - Make workspace constraints more visibly global.
    The language is improving, but the system should make it more obvious that constraints affect queue, map, list, and replay together.

  Higher effort but strategically important:

  - Alert grouping and deduplication beyond raw alert IDs.
  - Region-of-interest workflows with saved operational areas.
  - Cross-domain correlation hints and anomaly explanations.
  - Saved investigations, saved views, annotations, and evidence persistence.

Critical Assessment Of The Remaining Items

  The biggest remaining UX weakness is no longer “there are not enough workflow surfaces.” The system now has those surfaces:

  - alert queue
  - investigation context
  - replay timeline
  - workspace constraints
  - domain health dashboards

  The real gap is that these surfaces are still not tightly orchestrated around the event itself. The operator can detect, browse, and pivot, but the
  app still makes them do too much manual navigation after an alert or anomaly appears.

  Specific assessment:

  - Timeline event navigation is now the highest-value missing capability.
    The timeline already has domain density and replay control. It should become the primary way to move through alerts and anomalies in time, not just
    a scrubber.

  - Investigation windows are a low-risk, high-return addition.
    The current investigation workflow already snaps to a replay range. Formal before/during/after bookmarks are a natural extension and will improve
    repeatability without requiring backend redesign.

  - Source freshness and confidence should be treated as decision support, not dashboard decoration.
    The system already has domain status and watchlist health, but freshness and confidence are not yet surfaced clearly where analysts decide whether
    a track, disruption, or alert should be trusted.

  - The source panel still has too many responsibilities, but this is no longer a justification for a full panel rewrite.
    It already has browse/workspace tabs and explicit constraints framing. The remaining problem is mainly residual overload and placement of controls,
    especially overlays/settings that do not belong in the same surface as analytical triage.

  - Alert grouping and deduplication are worth doing, but not before event navigation is stronger.
    A smarter queue matters less if the operator still lacks fast event-to-timeline movement and bounded investigation windows.

  - Region-of-interest workflows are useful, but only after investigation and constraint semantics feel stable.
    Saved AOIs make more sense when the product is ready to support recurring operational monitoring rather than ad hoc exploration.

  - Cross-domain correlation hints and anomaly explanations are strategically important but premature as a major UX initiative.
    They depend on backend logic, entity linkage, and evidence quality that are not fully mature yet.

  - Full persistence and collaboration should wait until the investigation object is more stable.
    Notes and annotations already exist in some form. A large saved-investigations workflow is better done after the app’s case model settles.

Recommended Implementation Order

  1. Timeline markers and jump actions

  - Add alert markers directly to the timeline.
  - Add jump-to-alert and next-event controls.
  - Treat the timeline as an investigation navigator, not just playback chrome.

  2. Investigation window presets

  - Add before, event window, and after presets.
  - Make these presets bookmarkable inside the active investigation context.
  - Preserve them while moving through replay.

  3. Freshness and confidence in decision surfaces

  - Add object-level freshness and confidence chips to asset and investigation views.
  - Reuse existing dashboard logic where possible rather than inventing new metrics.
  - Make stale or degraded data visually obvious when the user is about to act on it.

  4. Source panel refinement rather than rewrite

  - Move map overlays/settings out of the analytical browse surface.
  - Keep workspace constraints explicit and global.
  - Reduce residual “track browser” feel without destabilizing the panel.

  5. Alert grouping and deduplication

  - Group related alerts by rule/domain/track/time proximity first.
  - Do not attempt ambitious case clustering before the basic queue behavior improves.

  6. Saved investigations and saved views

  - Persist investigative context only after the workflow object is clearer.
  - Start with a lightweight local restore model before collaboration/handoff features.

  7. Region-of-interest workflows

  - Add saved AOIs and entry/exit monitoring once the investigation loop is stronger.

  8. Correlation hints and anomaly explanation UX

  - Add these after more of the backend evidence model exists.

What Is Not Worth Implementing Right Now

  - A full source panel rewrite.
  - Full collaborative investigation persistence and handoff workflow.
  - Heavy explanation UX before correlation logic is more mature.
  - More generic badges, counts, and overlays inside existing cards.

  Those efforts would consume significant time without solving the most immediate analyst-friction points.

Phased Plan

  Phase 1: Time-Based Investigation

  - Add alert markers directly to the timeline.
  - Add jump-to-alert and jump-to-next-event actions.
  - Add before, event window, and after investigation presets.
  - Preserve investigation context while moving through replay.

  Phase 2: Decision Support And Panel Discipline

  - Add freshness and confidence indicators to asset and investigation views.
  - Move overlay/settings controls out of the analytical browse surface.
  - Continue reducing generic counts that are not tied to change, anomaly, or threshold.
  - Keep the asset card focused on decision-relevant information rather than accumulating more badges.

  Phase 3: Queue Intelligence

  - Group and deduplicate alerts beyond raw IDs.
  - Improve queue semantics so related activity behaves more like a case cluster.
  - Add a watchlist and collection-health strip spanning all domains, not just space.

  Phase 4: Operational Context And Persistence

  - Add region-of-interest workflows for saved areas and entry/exit monitoring.
  - Save investigations and restore them later.
  - Add shared or pinned views only after the saved-investigation object is stable.

  Phase 5: Correlation

  - Group related alerts into case-like clusters instead of flat rows.
  - Add cross-domain correlation cues linking disruptions, tracks, and temporal anomalies.
  - Improve escalation logic so operators see why the system thinks something matters.

Current Recommendation

  Do not spend the next cycle adding more visual overlays or richer badges to existing cards. The highest-value path is to make the current workflow
  surfaces feel more intentional: alert queue, investigation context, source/filter discipline, and time-based navigation. That is the shortest path
  from a strong visualization prototype to a genuinely usable analyst workspace.

External Project Consideration: `news08`

  Repository reviewed:

  - GitHub repository: <https://github.com/kliewerdaniel/news08>
  - raw `README.md`: <https://raw.githubusercontent.com/kliewerdaniel/news08/master/README.md>
  - raw `main.py`: <https://raw.githubusercontent.com/kliewerdaniel/news08/master/main.py>

  High-level assessment:

  `news08` is not a strong fit to adopt directly as part of Sentinel in its current form. It is built as a standalone automated news-broadcast script
  with:

  - RSS ingestion
  - local Ollama summarization
  - clustering and scoring
  - optional TTS/audio playback
  - SQLite caching

  The underlying idea is useful for Sentinel. The product shape is not.

  Recommendation:

  - Do not integrate `news08` as a broadcast/audio feature.
  - Do adapt its ingestion, summarization, clustering, and local-LLM pattern into a Sentinel-aligned intelligence-context service.

  Why it is still interesting:

  - You already have Ollama running locally.
  - You have a GPU available, which makes local summarization and reranking practical.
  - Sentinel would benefit from machine-curated OSINT context attached to alerts, disruptions, domains, and investigations.

  How it should be tailored for Sentinel:

  - Remove audio and TTS from the initial design.
  - Do not keep SQLite as the persistence layer.
  - Rebuild it as a background service, for example `collector-intel` or `intel-briefing`.
  - Ingest curated domain-relevant feeds:
    - aviation and NOTAM/TFR sources
    - maritime/shipping/security feeds
    - space launch/satellite/space-weather reporting
    - GPS/RF interference reporting
    - telecom, infrastructure, sanctions, and conflict reporting
  - Use Ollama for:
    - article summarization
    - topic/domain classification
    - entity extraction
    - cluster labeling
    - optional relevance scoring against an investigation or watchlist
  - Persist structured outputs in Sentinel tables rather than a standalone cache file.

  Suggested Sentinel integration shape:

  - `intel_items`
    - normalized article records, timestamps, source metadata, content hashes
  - `intel_clusters`
    - grouped themes or rolling developing stories
  - `intel_links`
    - links from items/clusters to:
      - domains
      - AOIs
      - disruptions
      - watchlist entities
      - tracked assets or future canonical identities
  - API surfaces for:
    - latest briefs by domain
    - investigation-adjacent briefs by time window
    - AOI-linked briefs
    - “why this alert matters” contextual brief cards

  Best first use inside Sentinel:

  - investigation context sidecar
  - domain briefing cards
  - alert context enrichment
  - daily or rolling operational brief panel

  Least valuable first use:

  - audio news playback
  - broad generic newsroom UI
  - trying to make news ingestion a primary alerting engine before entity-linking is stronger

  Bottom line:

  `news08` is worth treating as inspiration for a local LLM-powered OSINT context pipeline, not as a drop-in feature. The most effective adaptation is
  to turn it into structured contextual intelligence that strengthens investigation, not into a broadcast layer bolted onto the map.

Concrete Roadmap

  This roadmap translates the current UX recommendations into implementation slices that fit the existing codebase. It intentionally defers the items
  previously assessed as lower-value or premature. Those deferred items are listed at the end and are not yet fleshed out into detailed execution
  steps.

Roadmap Principles

  - Prioritize workflow acceleration over visual expansion.
  - Build on the surfaces that already exist rather than re-platforming them.
  - Prefer small end-to-end slices that improve the analyst loop immediately.
  - Avoid major persistence or collaboration work until the core investigation object is more stable.

Roadmap Now

  Track A: Time-Based Investigation

  Goal:

  Make the timeline the primary event-navigation surface for analysts in replay and live investigation.

  Slice A1: Timeline alert markers

  - Render alert/event markers directly on the timeline.
  - Distinguish severity/domain visually without overloading the bar.
  - Reuse existing alert queue and investigation timestamps rather than introducing a second event model.

  Implementation targets:

  - [`TimelinePanel.tsx`](/Users/JoelN/Coding/sentinel/frontend/src/components/TimelinePanel.tsx)
  - [`useMapStore.ts`](/Users/JoelN/Coding/sentinel/frontend/src/store/useMapStore.ts)
  - alert/investigation store selectors already used by the queue

  Acceptance criteria:

  - analysts can see where alerts occurred within the active replay window
  - markers stay aligned as the time window changes
  - selected/investigated alert is visually distinct

  Slice A2: Jump-to-event controls

  - Add jump-to-alert from the timeline surface itself.
  - Add next-event / previous-event controls for the current replay window.
  - Keep the current investigation context active while moving through time.

  Implementation targets:

  - [`TimelinePanel.tsx`](/Users/JoelN/Coding/sentinel/frontend/src/components/TimelinePanel.tsx)
  - investigation state in [`useMapStore.ts`](/Users/JoelN/Coding/sentinel/frontend/src/store/useMapStore.ts)

  Acceptance criteria:

  - user can move between alerts without returning to the alert queue
  - replay time updates cleanly without dropping selection or investigation state

  Slice A3: Investigation window presets

  - Add `before`, `event`, and `after` window presets to the investigation workflow.
  - Make these presets recenter the replay range relative to the active alert or investigation timestamp.
  - Preserve a clear visual indication of which preset is active.

  Implementation targets:

  - [`InvestigationPanel.tsx`](/Users/JoelN/Coding/sentinel/frontend/src/components/InvestigationPanel.tsx)
  - [`TimelinePanel.tsx`](/Users/JoelN/Coding/sentinel/frontend/src/components/TimelinePanel.tsx)
  - investigation/time state in [`useMapStore.ts`](/Users/JoelN/Coding/sentinel/frontend/src/store/useMapStore.ts)

  Acceptance criteria:

  - one-click shift to a bounded “before”, “during”, or “after” frame
  - presets work consistently for both queue-driven and manually selected investigations

  Track B: Decision Support In Existing Surfaces

  Goal:

  Make confidence and freshness visible where analysts decide what to trust.

  Slice B1: Asset-level freshness

  - Show freshness state in the asset card using existing `last_seen` and domain timing conventions.
  - Use simple states such as fresh, aging, stale rather than introducing a detailed telemetry taxonomy.
  - Ensure stale state is visible without turning the card into a dashboard.

  Implementation targets:

  - [`AssetCard.tsx`](/Users/JoelN/Coding/sentinel/frontend/src/components/AssetCard.tsx)
  - detail/current-state APIs already providing `last_seen`

  Acceptance criteria:

  - stale or aging tracks are obvious at a glance
  - no new backend API is required for the first slice

  Slice B2: Investigation-level confidence

  - Show a compact confidence/freshness summary in the investigation panel.
  - Pull from existing source/domain status where possible.
  - Use it to explain why nearby context or selected evidence may be weak.

  Implementation targets:

  - [`InvestigationPanel.tsx`](/Users/JoelN/Coding/sentinel/frontend/src/components/InvestigationPanel.tsx)
  - existing dashboard/domain freshness endpoints where useful

  Acceptance criteria:

  - analyst can quickly assess whether the current case is operating on weak, stale, or healthy data
  - confidence messaging stays compact and case-oriented

  Track C: Source Panel Refinement

  Goal:

  Reduce residual source-panel overload without rewriting the whole panel.

  Slice C1: Separate overlays/settings from browse workflow

  - Move map overlays and renderer-mode controls out of the main analytical browse surface.
  - Keep them accessible, but not interleaved with domain/entity workflow.
  - This can be done by moving them into top-level settings or a dedicated map controls surface.

  Implementation targets:

  - [`SourcePanel.tsx`](/Users/JoelN/Coding/sentinel/frontend/src/components/SourcePanel.tsx)
  - [`App.tsx`](/Users/JoelN/Coding/sentinel/frontend/src/App.tsx)

  Acceptance criteria:

  - browse/workspace views focus on entities and constraints
  - map presentation controls do not compete with analytical controls

  Slice C2: Stronger global constraint feedback

  - Make it more obvious that workspace constraints affect queue, map, list, and replay together.
  - Improve the wording and summary surfaces rather than adding more filters.
  - Avoid introducing new filtering dimensions in this pass.

  Implementation targets:

  - [`SourcePanel.tsx`](/Users/JoelN/Coding/sentinel/frontend/src/components/SourcePanel.tsx)
  - alert queue/timeline labels only if needed for consistency

  Acceptance criteria:

  - users can tell what is globally constrained and what is only visually dimmed
  - muted/hidden/excluded semantics remain understandable

  Track D: Queue Intelligence

  Goal:

  Make alert triage more case-like without introducing a full case system.

  Slice D1: Lightweight alert grouping

  - Group alerts by simple, explainable heuristics:
    - same rule
    - same domain
    - same track
    - close time adjacency
  - Do not attempt broad cross-domain clustering in the first pass.

  Implementation targets:

  - [`AlertQueuePanel.tsx`](/Users/JoelN/Coding/sentinel/frontend/src/components/AlertQueuePanel.tsx)
  - alert selectors in [`useMapStore.ts`](/Users/JoelN/Coding/sentinel/frontend/src/store/useMapStore.ts)
  - optional backend support only if grouping needs server-side pagination later

  Acceptance criteria:

  - repeated alert bursts feel grouped rather than spammy
  - grouping logic is transparent enough that an analyst can predict it

  Slice D2: Group-aware investigation handoff

  - Let grouped alerts share context in the queue and investigation surfaces.
  - Preserve the primary selected alert while still showing related items.
  - Keep this lightweight; no saved case object yet.

  Acceptance criteria:

  - queue browsing becomes faster during bursts
  - related alerts are visible without losing the single active investigation focus

Roadmap Later

  These items are intentionally deferred and should not be broken into detailed execution work yet.

  Deferred 1: Full source panel rewrite

  - Revisit only if iterative refinement fails to reduce overload.

  Deferred 2: Full collaborative investigation persistence and handoff

  - Revisit after the investigation model and case semantics stabilize.

  Deferred 3: Heavy correlation and explanation UX

  - Revisit when backend evidence-linking and anomaly logic are more mature.

  Deferred 4: Region-of-interest workflows

  - Revisit after the investigation loop and global constraints model are stronger.

  Deferred 5: `news08`-style intelligence enrichment

  - Revisit after the core UX loop above is tighter.
  - When revisited, treat it as a structured local-LLM OSINT context service for investigations, not as an audio/news feature.

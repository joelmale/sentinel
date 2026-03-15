/**
 * Global map + playback state — managed by Zustand.
 *
 * Zustand works like a singleton React context without the boilerplate.
 * Think of the store as a shared whiteboard: any component can read from
 * it or write to it, and all subscribers re-render only when their watched
 * slice changes.
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { useLiveDataStore } from '@/store/useLiveDataStore'
import type {
  DomainQuickScopeId,
  DomainScopeState,
  PlaybackMode,
  SourceDomain,
  TimeWindow,
  TrackEventProperties,
} from '@/types/track'

// ── Alert model ───────────────────────────────────────────────────
// Triage lifecycle: new → investigating | acknowledged → closed
// Think of it like a ticket system: alerts start as "new", get assigned
// to an investigator (investigating), acknowledged as known, or closed.
export type AlertTriage = 'new' | 'acknowledged' | 'investigating' | 'closed'

export interface AlertItem {
  alertId: string
  ruleId: string
  ruleName?: string
  trackId: string
  domain: SourceDomain
  triggeredAt: string
  triage: AlertTriage
}

// Investigation context — set when an operator opens an alert for analysis.
// Drives the workspace pivot: map flies to track, timeline snaps to ±30 min
// around the event, asset card opens. Think of it as "locking onto a target."
export interface InvestigationContext {
  alertId: string
  trackId: string
  domain: SourceDomain
  triggeredAt: string
  ruleName?: string
}

export type InvestigationWindowPreset = 'before' | 'during' | 'after'

export interface UnderseaLandingPointSelection {
  id: string
  name: string
  lon: number
  lat: number
}

export type MapMode = 'full' | 'simple' | 'outline' | 'none'

// ── Layer state ───────────────────────────────────────────────────
// Three-state visibility — think of it like a monitor dimmer switch:
//   active  = full brightness, in track list, in alerts (was: enabled=true)
//   muted   = dim context layer — still on map at ~25% opacity, excluded from
//             active filtering, shown greyed in track list
//   hidden  = completely off — not on map, not in track list, not in alerts
export type LayerVisibility = 'active' | 'muted' | 'hidden'

export interface LayerState {
  visibility: LayerVisibility
  opacity: number   // 0–1 base opacity (muted applies an additional 0.25× factor)
}

export type LayerMap = Record<SourceDomain | 'Annotations', LayerState>

const DEFAULT_LAYERS: LayerMap = {
  Air:         { visibility: 'hidden', opacity: 0.9 },
  Maritime:    { visibility: 'hidden', opacity: 0.9 },
  Space:       { visibility: 'muted', opacity: 0.8 },
  GPS:         { visibility: 'hidden', opacity: 0.7 },
  Infra:       { visibility: 'hidden', opacity: 0.6 },
  Annotations: { visibility: 'hidden', opacity: 1.0 },
}

const DEFAULT_DOMAIN_SCOPES: Record<SourceDomain, DomainScopeState> = {
  Air: {
    selectedQuickScope: 'military',
    appliedQuickScope: null,
    resultLimit: 50,
    customOperator: '',
    customConstellation: '',
    customPurpose: '',
    advancedOpen: false,
  },
  Maritime: {
    selectedQuickScope: 'major_routes',
    appliedQuickScope: null,
    resultLimit: 50,
    customOperator: '',
    customConstellation: '',
    customPurpose: '',
    advancedOpen: false,
  },
  Space: {
    selectedQuickScope: 'watchlist',
    appliedQuickScope: null,
    resultLimit: 50,
    customOperator: '',
    customConstellation: '',
    customPurpose: '',
    advancedOpen: false,
  },
  GPS: {
    selectedQuickScope: 'active_disruptions',
    appliedQuickScope: null,
    resultLimit: 50,
    customOperator: '',
    customConstellation: '',
    customPurpose: '',
    advancedOpen: false,
  },
  Infra: {
    selectedQuickScope: 'active_disruptions',
    appliedQuickScope: null,
    resultLimit: 50,
    customOperator: '',
    customConstellation: '',
    customPurpose: '',
    advancedOpen: false,
  },
}

// ── Viewport ──────────────────────────────────────────────────────
export interface Viewport {
  longitude: number
  latitude: number
  zoom: number
  bearing: number
  pitch: number
}

export interface ViewBounds {
  west: number
  south: number
  east: number
  north: number
}

const DEFAULT_VIEWPORT: Viewport = {
  longitude: 0,
  latitude: 20,
  zoom: 2,
  bearing: 0,
  pitch: 0,
}

// ── Playback ──────────────────────────────────────────────────────
export interface PlaybackState {
  mode: PlaybackMode
  currentTime: Date
  timeWindow: TimeWindow
  speedMultiplier: 1 | 5 | 30 | 60
}

const now = new Date()
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)

const DEFAULT_PLAYBACK: PlaybackState = {
  mode: 'live',
  currentTime: now,
  timeWindow: { start: yesterday, end: now },
  speedMultiplier: 1,
}

function investigationWindowFromPreset(triggeredAt: string, preset: InvestigationWindowPreset): TimeWindow {
  const trigger = new Date(triggeredAt)
  if (preset === 'before') {
    return {
      start: new Date(trigger.getTime() - 30 * 60_000),
      end: trigger,
    }
  }
  if (preset === 'during') {
    return {
      start: new Date(trigger.getTime() - 15 * 60_000),
      end: new Date(trigger.getTime() + 15 * 60_000),
    }
  }
  return {
    start: trigger,
    end: new Date(trigger.getTime() + 30 * 60_000),
  }
}

// ── Store interface ───────────────────────────────────────────────
interface MapStore {
  // Live asset data — shared across all panels so no prop drilling
  liveAssets: Map<string, TrackEventProperties>
  upsertAssets: (events: TrackEventProperties[]) => void
  replaceDomainAssets: (domain: SourceDomain, events: TrackEventProperties[]) => void
  clearAssets: () => void

  // Trail buffer: last 60 positions per track for live trail rendering
  trailBuffer: Map<string, Array<{ lon: number; lat: number; timestamp: number }>>
  clearTrailBuffer: () => void
  selectedTrackHistory: Array<{ lon: number; lat: number; timestamp: number }>
  setSelectedTrackHistory: (points: Array<{ lon: number; lat: number; timestamp: number }>) => void
  clearSelectedTrackHistory: () => void

  // Layer visibility — tri-state (active / muted / hidden)
  layers: LayerMap
  // cycleLayerVisibility: active → muted → hidden → active (called by TriStateToggle)
  cycleLayerVisibility: (domain: keyof LayerMap) => void
  // setLayerEnabled: compat shim — maps true→active, false→hidden (used by legacy callers)
  setLayerEnabled: (domain: keyof LayerMap, enabled: boolean) => void
  setLayerOpacity: (domain: keyof LayerMap, opacity: number) => void

  // Workspace-wide search — drives MapCanvas declutter + SourcePanel list
  workspaceSearch: string
  setWorkspaceSearch: (q: string) => void

  // Track-panel scope-first browsing
  domainScopes: Record<SourceDomain, DomainScopeState>
  setSelectedQuickScope: (domain: SourceDomain, quickScope: DomainQuickScopeId | null) => void
  applyDomainScope: (domain: SourceDomain) => void
  clearDomainScope: (domain: SourceDomain) => void
  setDomainScopeResultLimit: (domain: SourceDomain, resultLimit: number) => void
  setDomainScopeAdvancedOpen: (domain: SourceDomain, open: boolean) => void
  setDomainScopeOperator: (domain: SourceDomain, customOperator: string) => void
  setDomainScopeConstellation: (domain: SourceDomain, customConstellation: string) => void
  setDomainScopePurpose: (domain: SourceDomain, customPurpose: string) => void

  // Declutter mode: when on + search active, non-matching tracks dim to ~10% on map
  declutterMode: boolean
  toggleDeclutterMode: () => void

  // Viewport
  viewport: Viewport
  viewportBounds: ViewBounds | null
  setViewport: (viewport: Partial<Viewport>) => void
  setViewportBounds: (bounds: ViewBounds | null) => void
  flyTo: (lon: number, lat: number, zoom?: number) => void

  // Playback
  playback: PlaybackState
  setPlaybackMode: (mode: PlaybackMode) => void
  setCurrentTime: (t: Date) => void
  setTimeWindow: (window: TimeWindow) => void
  setSpeedMultiplier: (speed: PlaybackState['speedMultiplier']) => void
  tickPlayback: () => void

  // Selected asset
  selectedTrackId: string | null
  selectedDomain: SourceDomain | null
  selectAsset: (trackId: string, domain: SourceDomain) => void
  clearSelection: () => void
  selectedLandingPoint: UnderseaLandingPointSelection | null
  selectLandingPoint: (point: UnderseaLandingPointSelection) => void
  clearLandingPointSelection: () => void

  // Alerts — full triage lifecycle
  pendingAlerts: AlertItem[]
  addAlert: (alert: Omit<AlertItem, 'triage'>) => void
  dismissAlert: (alertId: string) => void
  triageAlert: (alertId: string, triage: AlertTriage) => void

  // Investigation context — set when analyst opens an alert
  investigationContext: InvestigationContext | null
  investigationWindowPreset: InvestigationWindowPreset | null
  setInvestigationWindowPreset: (preset: InvestigationWindowPreset | null) => void
  applyInvestigationWindowPreset: (preset: InvestigationWindowPreset, triggeredAt?: string) => void
  focusAlert: (alert: AlertItem, options?: { preserveWindow?: boolean }) => void
  openInvestigation: (alert: AlertItem) => void
  closeInvestigation: () => void

  // Panel open/close
  sourcePanelOpen: boolean
  assetCardOpen: boolean
  toggleSourcePanel: () => void
  setAssetCardOpen: (open: boolean) => void

  // UI settings
  mapMode: MapMode
  showTrails: boolean
  showFilteredTrackGhosts: boolean
  showCocom: boolean
  showUnderseaCables: boolean
  globeView: boolean
  setMapMode: (mode: MapMode) => void
  toggleShowTrails: () => void
  toggleShowFilteredTrackGhosts: () => void
  toggleCocom: () => void
  toggleUnderseaCables: () => void
  toggleGlobeView: () => void

  // Classification filter — maps domain name → list of HIDDEN classification strings
  // An empty array (or absent key) means "show all" for that domain.
  classFilter: Partial<Record<string, string[]>>
  setClassFilter: (domain: string, hidden: string[]) => void

  // Group filter — maps domain name → list of hidden grouping keys from SourcePanel
  hiddenGroupFilters: Partial<Record<SourceDomain, string[]>>
  toggleHiddenGroupFilter: (domain: SourceDomain, key: string) => void
  clearHiddenGroupFilters: (domain: SourceDomain) => void
  hiddenSpaceConstellations: string[]
  toggleHiddenSpaceConstellation: (constellation: string) => void
  clearHiddenSpaceConstellations: () => void

  // Group exclusion — set of 'domain:track_id' keys that should be dimmed on the map.
  // Unlike hiddenGroupFilters (which removes tracks entirely), these remain visible but
  // rendered at ~10% alpha. Populated by SourcePanel via badge-click exclusion.
  groupExcludedTracks: Set<string>
  setGroupExcludedTracks: (s: Set<string>) => void

  // Space track duration selector
  spaceTrackDuration: '1h' | '24h' | 'orbit'
  setSpaceTrackDuration: (d: '1h' | '24h' | 'orbit') => void
  spacePriorityOnly: boolean
  toggleSpacePriorityOnly: () => void
  expandedSpaceConstellations: Set<string>
  toggleExpandedSpaceConstellation: (constellation: string) => void
  watchedSpaceTrackIds: Set<string>
  setWatchedSpaceTrackIds: (ids: Set<string>) => void

  // Orbital track points for selected Space asset (populated by App.tsx query)
  selectedOrbitPoints: Array<{ lon: number; lat: number; alt_km?: number; timestamp: number }>
  setSelectedOrbitPoints: (pts: Array<{ lon: number; lat: number; alt_km?: number; timestamp: number }>) => void
  clearSelectedOrbitPoints: () => void
}

// ── Store implementation ──────────────────────────────────────────
export const useMapStore = create<MapStore>()(
  devtools((set, get) => ({

    // ── Assets ──────────────────────────────────────────────────
    liveAssets: new Map(),
    upsertAssets: (events) =>
      set((s) => {
        const next = new Map(s.liveAssets)
        const nextTrailBuffer = new Map(s.trailBuffer)

        for (const e of events) {
          next.set(`${e.source_domain}:${e.track_id}`, e)

          // Update trail buffer if lon/lat are valid numbers
          if (typeof e.lon === 'number' && typeof e.lat === 'number') {
            const key = `${e.source_domain}:${e.track_id}`
            const trail = nextTrailBuffer.get(key) ?? []

            // Parse timestamp to get numeric value
            const timestamp = new Date(e.timestamp).getTime()

            // Add new position
            trail.push({ lon: e.lon, lat: e.lat, timestamp })

            // Keep max 60 entries per track (FIFO)
            if (trail.length > 60) {
              trail.shift()
            }

            nextTrailBuffer.set(key, trail)
          }
        }

        return { liveAssets: next, trailBuffer: nextTrailBuffer }
      }),
    replaceDomainAssets: (domain, events) =>
      set((s) => {
        const next = new Map(s.liveAssets)
        for (const key of next.keys()) {
          if (key.startsWith(`${domain}:`)) {
            next.delete(key)
          }
        }
        for (const event of events) {
          next.set(`${event.source_domain}:${event.track_id}`, event)
        }
        return { liveAssets: next }
      }),
    clearAssets: () => set({ liveAssets: new Map() }),

    // ── Trail buffer ────────────────────────────────────────────
    trailBuffer: new Map(),
    clearTrailBuffer: () => set({ trailBuffer: new Map() }),
    selectedTrackHistory: [],
    setSelectedTrackHistory: (points) => set({ selectedTrackHistory: points }),
    clearSelectedTrackHistory: () => set({ selectedTrackHistory: [] }),

    // ── Layers ──────────────────────────────────────────────────
    layers: DEFAULT_LAYERS,
    cycleLayerVisibility: (domain) =>
      set((s) => {
        const CYCLE: Record<LayerVisibility, LayerVisibility> = { active: 'muted', muted: 'hidden', hidden: 'active' }
        const next = CYCLE[s.layers[domain].visibility]
        return { layers: { ...s.layers, [domain]: { ...s.layers[domain], visibility: next } } }
      }),
    setLayerEnabled: (domain, enabled) =>
      set((s) => ({
        layers: { ...s.layers, [domain]: { ...s.layers[domain], visibility: enabled ? 'active' : 'hidden' } },
      })),
    setLayerOpacity: (domain, opacity) =>
      set((s) => ({
        layers: { ...s.layers, [domain]: { ...s.layers[domain], opacity } },
      })),

    // ── Workspace search & declutter ────────────────────────────
    workspaceSearch: '',
    setWorkspaceSearch: (q) => set({ workspaceSearch: q }),
    domainScopes: DEFAULT_DOMAIN_SCOPES,
    setSelectedQuickScope: (domain, selectedQuickScope) =>
      set((state) => ({
        domainScopes: {
          ...state.domainScopes,
          [domain]: {
            ...state.domainScopes[domain],
            selectedQuickScope,
          },
        },
      })),
    applyDomainScope: (domain) =>
      set((state) => ({
        domainScopes: {
          ...state.domainScopes,
          [domain]: {
            ...state.domainScopes[domain],
            appliedQuickScope: state.domainScopes[domain].selectedQuickScope,
          },
        },
      })),
    clearDomainScope: (domain) =>
      set((state) => ({
        domainScopes: {
          ...state.domainScopes,
          [domain]: {
            ...state.domainScopes[domain],
            appliedQuickScope: null,
          },
        },
      })),
    setDomainScopeResultLimit: (domain, resultLimit) =>
      set((state) => ({
        domainScopes: {
          ...state.domainScopes,
          [domain]: {
            ...state.domainScopes[domain],
            resultLimit,
          },
        },
      })),
    setDomainScopeAdvancedOpen: (domain, advancedOpen) =>
      set((state) => ({
        domainScopes: {
          ...state.domainScopes,
          [domain]: {
            ...state.domainScopes[domain],
            advancedOpen,
          },
        },
      })),
    setDomainScopeOperator: (domain, customOperator) =>
      set((state) => ({
        domainScopes: {
          ...state.domainScopes,
          [domain]: {
            ...state.domainScopes[domain],
            customOperator,
          },
        },
      })),
    setDomainScopeConstellation: (domain, customConstellation) =>
      set((state) => ({
        domainScopes: {
          ...state.domainScopes,
          [domain]: {
            ...state.domainScopes[domain],
            customConstellation,
          },
        },
      })),
    setDomainScopePurpose: (domain, customPurpose) =>
      set((state) => ({
        domainScopes: {
          ...state.domainScopes,
          [domain]: {
            ...state.domainScopes[domain],
            customPurpose,
          },
        },
      })),
    declutterMode: false,
    toggleDeclutterMode: () => set((s) => ({ declutterMode: !s.declutterMode })),

    // ── Viewport ────────────────────────────────────────────────
    viewport: DEFAULT_VIEWPORT,
    viewportBounds: null,
    setViewport: (viewport) =>
      set((s) => ({ viewport: { ...s.viewport, ...viewport } })),
    setViewportBounds: (viewportBounds) => set({ viewportBounds }),
    flyTo: (lon, lat, zoom = 8) =>
      set({ viewport: { ...get().viewport, longitude: lon, latitude: lat, zoom } }),

    // ── Playback ─────────────────────────────────────────────────
    playback: DEFAULT_PLAYBACK,
    setPlaybackMode: (mode) =>
      set((s) => ({ playback: { ...s.playback, mode } })),
    setCurrentTime: (currentTime) =>
      set((s) => ({ playback: { ...s.playback, currentTime } })),
    setTimeWindow: (timeWindow) =>
      set((s) => ({ playback: { ...s.playback, timeWindow } })),
    setSpeedMultiplier: (speedMultiplier) =>
      set((s) => ({ playback: { ...s.playback, speedMultiplier } })),
    tickPlayback: () => {
      const { playback } = get()
      if (playback.mode !== 'replay') return
      const newTime = new Date(
        playback.currentTime.getTime() + 1000 * playback.speedMultiplier
      )
      if (newTime >= playback.timeWindow.end) {
        set((s) => ({
          playback: { ...s.playback, mode: 'paused', currentTime: s.playback.timeWindow.end },
        }))
      } else {
        set((s) => ({ playback: { ...s.playback, currentTime: newTime } }))
      }
    },

    // ── Selection ────────────────────────────────────────────────
    selectedTrackId: null,
    selectedDomain: null,
    selectedLandingPoint: null,
    selectAsset: (trackId, domain) =>
      set({
        selectedTrackId: trackId,
        selectedDomain: domain,
        selectedLandingPoint: null,
        assetCardOpen: true,
      }),
    clearSelection: () =>
      set({
        selectedTrackId: null,
        selectedDomain: null,
        assetCardOpen: false,
        selectedTrackHistory: [],
      }),
    selectLandingPoint: (point) =>
      set({
        selectedLandingPoint: point,
        selectedTrackId: null,
        selectedDomain: null,
        assetCardOpen: false,
        selectedTrackHistory: [],
      }),
    clearLandingPointSelection: () => set({ selectedLandingPoint: null }),

    // ── Alerts ────────────────────────────────────────────────────
    pendingAlerts: [],
    addAlert: (alert) =>
      set((s) => ({
        // Upsert: if alert already exists, keep it; otherwise add as 'new'
        pendingAlerts: s.pendingAlerts.some((a) => a.alertId === alert.alertId)
          ? s.pendingAlerts
          : [...s.pendingAlerts, { ...alert, triage: 'new' as AlertTriage }].slice(-200),
      })),
    dismissAlert: (alertId) =>
      set((s) => ({ pendingAlerts: s.pendingAlerts.filter((a) => a.alertId !== alertId) })),
    triageAlert: (alertId, triage) =>
      set((s) => ({
        pendingAlerts: s.pendingAlerts.map((a) =>
          a.alertId === alertId ? { ...a, triage } : a
        ),
      })),

    // ── Investigation context ─────────────────────────────────────
    investigationContext: null,
    investigationWindowPreset: null,
    setInvestigationWindowPreset: (investigationWindowPreset) => set({ investigationWindowPreset }),
    applyInvestigationWindowPreset: (preset, triggeredAt) => {
      const target = triggeredAt ?? get().investigationContext?.triggeredAt
      if (!target) return
      set((s) => ({
        investigationWindowPreset: preset,
        playback: {
          ...s.playback,
          mode: 'replay',
          currentTime: new Date(target),
          timeWindow: investigationWindowFromPreset(target, preset),
        },
      }))
    },
    focusAlert: (alert, options) => {
      const {
        flyTo,
        selectAsset,
        setTimeWindow,
        setCurrentTime,
        setPlaybackMode,
        triageAlert,
        investigationWindowPreset,
      } = get()
      const { viewportAssets, selectedAssetDetail } = useLiveDataStore.getState()
      // Fly to the track's last known position
      const assetKey = `${alert.domain}:${alert.trackId}`
      const asset = selectedAssetDetail?.track_id === alert.trackId && selectedAssetDetail.source_domain === alert.domain
        ? selectedAssetDetail
        : viewportAssets.get(assetKey)
      if (asset && typeof asset.lon === 'number' && typeof asset.lat === 'number') {
        flyTo(asset.lon, asset.lat, 9)
      }
      // Open the asset card for this track
      selectAsset(alert.trackId, alert.domain)
      const alertTime = new Date(alert.triggeredAt)
      if (!options?.preserveWindow) {
        const nextWindow = investigationWindowPreset
          ? investigationWindowFromPreset(alert.triggeredAt, investigationWindowPreset)
          : {
            start: new Date(alertTime.getTime() - 30 * 60_000),
            end: new Date(Math.max(alertTime.getTime() + 30 * 60_000, Date.now())),
          }
        const windowStart = nextWindow.start
        const windowEnd = nextWindow.end
        setTimeWindow({ start: windowStart, end: windowEnd })
      }
      setCurrentTime(alertTime)
      setPlaybackMode('replay')
      // Advance triage state
      triageAlert(alert.alertId, 'investigating')
      // Record the active investigation
      set({
        investigationContext: {
          alertId:     alert.alertId,
          trackId:     alert.trackId,
          domain:      alert.domain,
          triggeredAt: alert.triggeredAt,
          ruleName:    alert.ruleName,
        },
      })
    },
    openInvestigation: (alert) => get().focusAlert(alert),
    closeInvestigation: () => set({ investigationContext: null, investigationWindowPreset: null }),

    // ── Panels ──────────────────────────────────────────────────
    sourcePanelOpen: true,
    assetCardOpen: false,
    toggleSourcePanel: () => set((s) => ({ sourcePanelOpen: !s.sourcePanelOpen })),
    setAssetCardOpen: (open) => set({ assetCardOpen: open }),

    // ── UI settings ────────────────────────────────────────────
    mapMode: 'outline',
    showTrails: true,
    showFilteredTrackGhosts: false,
    showCocom: false,
    showUnderseaCables: false,
    globeView: false,
    setMapMode: (mapMode) => set({ mapMode }),
    toggleShowTrails: () => set((s) => ({ showTrails: !s.showTrails })),
    toggleShowFilteredTrackGhosts: () => set((s) => ({ showFilteredTrackGhosts: !s.showFilteredTrackGhosts })),
    toggleCocom: () => set((s) => ({ showCocom: !s.showCocom })),
    toggleUnderseaCables: () => set((s) => ({ showUnderseaCables: !s.showUnderseaCables })),
    toggleGlobeView: () => set((s) => ({ globeView: !s.globeView })),

    // ── Classification filter ───────────────────────────────────
    classFilter: {},
    setClassFilter: (domain, hidden) =>
      set((s) => ({ classFilter: { ...s.classFilter, [domain]: hidden } })),

    // ── Group filter ────────────────────────────────────────────
    hiddenGroupFilters: {},
    toggleHiddenGroupFilter: (domain, key) =>
      set((s) => {
        const current = s.hiddenGroupFilters[domain] ?? []
        const next = current.includes(key)
          ? current.filter((item) => item !== key)
          : [...current, key]
        return { hiddenGroupFilters: { ...s.hiddenGroupFilters, [domain]: next } }
      }),
    clearHiddenGroupFilters: (domain) =>
      set((s) => ({ hiddenGroupFilters: { ...s.hiddenGroupFilters, [domain]: [] } })),
    hiddenSpaceConstellations: [],
    toggleHiddenSpaceConstellation: (constellation) =>
      set((s) => {
        const next = s.hiddenSpaceConstellations.includes(constellation)
          ? s.hiddenSpaceConstellations.filter((item) => item !== constellation)
          : [...s.hiddenSpaceConstellations, constellation]
        return { hiddenSpaceConstellations: next }
      }),
    clearHiddenSpaceConstellations: () => set({ hiddenSpaceConstellations: [] }),

    // ── Group exclusion (dim on map) ─────────────────────────────
    groupExcludedTracks: new Set<string>(),
    setGroupExcludedTracks: (s) => set({ groupExcludedTracks: s }),

    // ── Space track duration ─────────────────────────────────────
    spaceTrackDuration: '1h',
    setSpaceTrackDuration: (spaceTrackDuration) => set({ spaceTrackDuration }),
    spacePriorityOnly: false,
    toggleSpacePriorityOnly: () => set((s) => ({ spacePriorityOnly: !s.spacePriorityOnly })),
    expandedSpaceConstellations: new Set<string>(),
    toggleExpandedSpaceConstellation: (constellation) =>
      set((s) => {
        const next = new Set(s.expandedSpaceConstellations)
        if (next.has(constellation)) next.delete(constellation)
        else next.add(constellation)
        return { expandedSpaceConstellations: next }
      }),
    watchedSpaceTrackIds: new Set<string>(),
    setWatchedSpaceTrackIds: (ids) => set({ watchedSpaceTrackIds: ids }),

    // ── Orbital track points ─────────────────────────────────────
    selectedOrbitPoints: [],
    setSelectedOrbitPoints: (pts) => set({ selectedOrbitPoints: pts }),
    clearSelectedOrbitPoints: () => set({ selectedOrbitPoints: [] }),
  }))
)

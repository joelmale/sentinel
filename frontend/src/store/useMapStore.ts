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
import type { PlaybackMode, SourceDomain, TimeWindow, TrackEventProperties } from '@/types/track'

// ── Layer state ───────────────────────────────────────────────────
export interface LayerState {
  enabled: boolean
  opacity: number   // 0–1
}

export type LayerMap = Record<SourceDomain | 'Annotations', LayerState>

const DEFAULT_LAYERS: LayerMap = {
  Air:         { enabled: true,  opacity: 0.9 },
  Maritime:    { enabled: true,  opacity: 0.9 },
  Space:       { enabled: true,  opacity: 0.8 },
  GPS:         { enabled: true,  opacity: 0.7 },
  Infra:       { enabled: true,  opacity: 0.6 },
  Annotations: { enabled: true,  opacity: 1.0 },
}

// ── Viewport ──────────────────────────────────────────────────────
export interface Viewport {
  longitude: number
  latitude: number
  zoom: number
  bearing: number
  pitch: number
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

// ── Store interface ───────────────────────────────────────────────
interface MapStore {
  // Live asset data — shared across all panels so no prop drilling
  liveAssets: Map<string, TrackEventProperties>
  upsertAssets: (events: TrackEventProperties[]) => void
  clearAssets: () => void

  // Trail buffer: last 60 positions per track for live trail rendering
  trailBuffer: Map<string, Array<{ lon: number; lat: number; timestamp: number }>>
  clearTrailBuffer: () => void
  selectedTrackHistory: Array<{ lon: number; lat: number; timestamp: number }>
  setSelectedTrackHistory: (points: Array<{ lon: number; lat: number; timestamp: number }>) => void
  clearSelectedTrackHistory: () => void

  // Layer visibility
  layers: LayerMap
  setLayerEnabled: (domain: keyof LayerMap, enabled: boolean) => void
  setLayerOpacity: (domain: keyof LayerMap, opacity: number) => void

  // Viewport
  viewport: Viewport
  setViewport: (viewport: Partial<Viewport>) => void
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

  // Alerts
  pendingAlerts: Array<{ alertId: string; ruleId: string; trackId: string; domain: SourceDomain; triggeredAt: string }>
  addAlert: (alert: { alertId: string; ruleId: string; trackId: string; domain: SourceDomain; triggeredAt: string }) => void
  dismissAlert: (alertId: string) => void

  // Panel open/close
  sourcePanelOpen: boolean
  assetCardOpen: boolean
  toggleSourcePanel: () => void
  setAssetCardOpen: (open: boolean) => void

  // UI settings
  simpleMap: boolean
  showTrails: boolean
  showCocom: boolean
  globeView: boolean
  toggleSimpleMap: () => void
  toggleShowTrails: () => void
  toggleCocom: () => void
  toggleGlobeView: () => void

  // Classification filter — maps domain name → list of HIDDEN classification strings
  // An empty array (or absent key) means "show all" for that domain.
  classFilter: Partial<Record<string, string[]>>
  setClassFilter: (domain: string, hidden: string[]) => void

  // Space track duration selector
  spaceTrackDuration: '1h' | '24h' | 'orbit'
  setSpaceTrackDuration: (d: '1h' | '24h' | 'orbit') => void

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
    clearAssets: () => set({ liveAssets: new Map() }),

    // ── Trail buffer ────────────────────────────────────────────
    trailBuffer: new Map(),
    clearTrailBuffer: () => set({ trailBuffer: new Map() }),
    selectedTrackHistory: [],
    setSelectedTrackHistory: (points) => set({ selectedTrackHistory: points }),
    clearSelectedTrackHistory: () => set({ selectedTrackHistory: [] }),

    // ── Layers ──────────────────────────────────────────────────
    layers: DEFAULT_LAYERS,
    setLayerEnabled: (domain, enabled) =>
      set((s) => ({
        layers: { ...s.layers, [domain]: { ...s.layers[domain], enabled } },
      })),
    setLayerOpacity: (domain, opacity) =>
      set((s) => ({
        layers: { ...s.layers, [domain]: { ...s.layers[domain], opacity } },
      })),

    // ── Viewport ────────────────────────────────────────────────
    viewport: DEFAULT_VIEWPORT,
    setViewport: (viewport) =>
      set((s) => ({ viewport: { ...s.viewport, ...viewport } })),
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
    selectAsset: (trackId, domain) =>
      set({ selectedTrackId: trackId, selectedDomain: domain, assetCardOpen: true }),
    clearSelection: () =>
      set({
        selectedTrackId: null,
        selectedDomain: null,
        assetCardOpen: false,
        selectedTrackHistory: [],
      }),

    // ── Alerts ────────────────────────────────────────────────────
    pendingAlerts: [],
    addAlert: (alert) =>
      set((s) => ({ pendingAlerts: [...s.pendingAlerts, alert] })),
    dismissAlert: (alertId) =>
      set((s) => ({ pendingAlerts: s.pendingAlerts.filter((a) => a.alertId !== alertId) })),

    // ── Panels ──────────────────────────────────────────────────
    sourcePanelOpen: true,
    assetCardOpen: false,
    toggleSourcePanel: () => set((s) => ({ sourcePanelOpen: !s.sourcePanelOpen })),
    setAssetCardOpen: (open) => set({ assetCardOpen: open }),

    // ── UI settings ────────────────────────────────────────────
    simpleMap: false,
    showTrails: true,
    showCocom: false,
    globeView: false,
    toggleSimpleMap: () => set((s) => ({ simpleMap: !s.simpleMap })),
    toggleShowTrails: () => set((s) => ({ showTrails: !s.showTrails })),
    toggleCocom: () => set((s) => ({ showCocom: !s.showCocom })),
    toggleGlobeView: () => set((s) => ({ globeView: !s.globeView })),

    // ── Classification filter ───────────────────────────────────
    classFilter: {},
    setClassFilter: (domain, hidden) =>
      set((s) => ({ classFilter: { ...s.classFilter, [domain]: hidden } })),

    // ── Space track duration ─────────────────────────────────────
    spaceTrackDuration: '1h',
    setSpaceTrackDuration: (spaceTrackDuration) => set({ spaceTrackDuration }),

    // ── Orbital track points ─────────────────────────────────────
    selectedOrbitPoints: [],
    setSelectedOrbitPoints: (pts) => set({ selectedOrbitPoints: pts }),
    clearSelectedOrbitPoints: () => set({ selectedOrbitPoints: [] }),
  }))
)

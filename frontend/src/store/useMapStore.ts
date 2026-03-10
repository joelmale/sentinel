/**
 * Global map + playback state — managed by Zustand.
 *
 * Zustand works like a singleton React context without the
 * boilerplate. Think of the store as a shared whiteboard:
 * any component can read from it or write to it, and all
 * subscribers re-render only when their watched slice changes.
 *
 * State slices:
 *   - activeLayers: which domain overlays are visible
 *   - playback: live vs replay, current time, speed
 *   - viewport: map center + zoom
 *   - selectedAsset: the track_id currently focused in detail panel
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { PlaybackMode, SourceDomain, TimeWindow } from '@/types/track'

// ── Layer state ───────────────────────────────────────────────────
export interface LayerState {
  enabled: boolean
  opacity: number         // 0-1
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
  // Layer visibility
  layers: LayerMap
  setLayerEnabled: (domain: keyof LayerMap, enabled: boolean) => void
  setLayerOpacity: (domain: keyof LayerMap, opacity: number) => void

  // Viewport
  viewport: Viewport
  setViewport: (viewport: Partial<Viewport>) => void

  // Playback
  playback: PlaybackState
  setPlaybackMode: (mode: PlaybackMode) => void
  setCurrentTime: (t: Date) => void
  setTimeWindow: (window: TimeWindow) => void
  setSpeedMultiplier: (speed: PlaybackState['speedMultiplier']) => void
  tickPlayback: () => void   // advance currentTime by (interval * speedMultiplier)

  // Selected asset
  selectedTrackId: string | null
  selectedDomain: SourceDomain | null
  selectAsset: (trackId: string, domain: SourceDomain) => void
  clearSelection: () => void

  // Sidebar panels
  layerPanelOpen: boolean
  detailPanelOpen: boolean
  toggleLayerPanel: () => void
  toggleDetailPanel: () => void
}

// ── Store implementation ──────────────────────────────────────────
export const useMapStore = create<MapStore>()(
  devtools((set, get) => ({
    // ── Layers ──
    layers: DEFAULT_LAYERS,
    setLayerEnabled: (domain, enabled) =>
      set((s) => ({
        layers: { ...s.layers, [domain]: { ...s.layers[domain], enabled } },
      })),
    setLayerOpacity: (domain, opacity) =>
      set((s) => ({
        layers: { ...s.layers, [domain]: { ...s.layers[domain], opacity } },
      })),

    // ── Viewport ──
    viewport: DEFAULT_VIEWPORT,
    setViewport: (viewport) =>
      set((s) => ({ viewport: { ...s.viewport, ...viewport } })),

    // ── Playback ──
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
      const TICK_MS = 1000  // 1 real second
      const newTime = new Date(
        playback.currentTime.getTime() + TICK_MS * playback.speedMultiplier
      )
      // Stop at end of window
      if (newTime >= playback.timeWindow.end) {
        set((s) => ({
          playback: {
            ...s.playback,
            mode: 'paused',
            currentTime: s.playback.timeWindow.end,
          },
        }))
      } else {
        set((s) => ({
          playback: { ...s.playback, currentTime: newTime },
        }))
      }
    },

    // ── Selection ──
    selectedTrackId: null,
    selectedDomain: null,
    selectAsset: (trackId, domain) =>
      set({ selectedTrackId: trackId, selectedDomain: domain, detailPanelOpen: true }),
    clearSelection: () =>
      set({ selectedTrackId: null, selectedDomain: null }),

    // ── Panels ──
    layerPanelOpen: true,
    detailPanelOpen: false,
    toggleLayerPanel: () =>
      set((s) => ({ layerPanelOpen: !s.layerPanelOpen })),
    toggleDetailPanel: () =>
      set((s) => ({ detailPanelOpen: !s.detailPanelOpen })),
  }))
)

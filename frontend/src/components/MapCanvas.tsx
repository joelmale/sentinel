/**
 * MapCanvas — the primary map rendering component.
 *
 * Uses react-map-gl (MapLibre) as the base map and deck.gl
 * as the data visualization layer system.
 *
 * Architecture: deck.gl renders as a WebGL canvas overlaid
 * on the MapLibre canvas. The two share the same camera state
 * (viewport) via the DeckGL/MapLibre interop. Think of it as
 * a transparent OHP projector sheet over a traditional map.
 *
 * Two rendering modes:
 *   Flat map  — MapLibre provides base tiles (vector or OSM raster)
 *   Globe view — deck.gl GlobeView + TileLayer provides base tiles;
 *                MapLibre is removed. Paths curve along Earth's surface.
 *
 * Layer rendering order (bottom to top):
 *   1. MapLibre base tiles OR Globe TileLayer (when globe mode)
 *   2. COCOM boundary fills + lines (GeoJsonLayer, when enabled)
 *   3. COCOM labels (TextLayer, when enabled)
 *   4. Maritime vessels (TextLayer — black ⚓)
 *   5. Maritime trails (PathLayer)
 *   6. Maritime history (PathLayer, selected)
 *   7. Aircraft (TextLayer — classification-coloured ✈)
 *   8. Aircraft trails (PathLayer)
 *   9. Aircraft history (PathLayer, selected)
 *  10. Space / satellites (TextLayer — 🛰)
 *  11. Orbital track (PathLayer, selected Space asset)
 *  12. Annotations (TextLayer + IconLayer)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
// GlobeView is an experimental API in deck.gl v9 — prefixed with underscore
import { _GlobeView as GlobeView, WebMercatorViewport } from '@deck.gl/core'
import { ScatterplotLayer, PathLayer, TextLayer, GeoJsonLayer, BitmapLayer } from '@deck.gl/layers'
import { TileLayer } from '@deck.gl/geo-layers'
import type { MapViewState, Layer } from '@deck.gl/core'
import MapLibreMap from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'

import { usePerfStore } from '@/store/usePerfStore'
import { useMapStore } from '@/store/useMapStore'
import { COCOM_GEOJSON_URL, COCOM_LABELS, getCocomColors } from '@/data/cocom'
import { UNDERSEA_CABLES_GEOJSON_URL, UNDERSEA_CABLE_LANDING_POINTS_GEOJSON_URL } from '@/data/underseaCables'
import type { DisruptionEvent, TrackEventProperties } from '@/types/track'
import { getAirlineGroup, getConstellation, getMmsiCountry, normalizeObjectType, normalizeOrbitClass } from '@/data/grouping'
import { useShallow } from 'zustand/react/shallow'

const CLASSIFICATION_COLORS: Record<string, [number, number, number]> = {
  Commercial: [100, 181, 246],
  Military:   [244,  67,  54],
  Government: [255, 193,   7],
  Unknown:    [158, 158, 158],
}

// MapLibre free vector tile source (no API key required)
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
const SIMPLE_MAP_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: 'raster' as const,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'] as string[],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    { id: 'background', type: 'background' as const, paint: { 'background-color': '#f8fafc' } },
    {
      id: 'osm',
      type: 'raster' as const,
      source: 'osm',
      paint: {
        'raster-saturation': -0.75,
        'raster-contrast': 0.3,
        'raster-brightness-min': 0.15,
        'raster-brightness-max': 0.92,
        'raster-opacity': 0.92,
      },
    },
  ],
}

// OSM tiles used when globe view is active (deck.gl TileLayer, not MapLibre)
const GLOBE_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const WORLD_BOUNDARIES_URL = 'https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json'
const LANDING_POINT_INTERACTIVE_ZOOM = 4
const OUTLINE_GRATICULE = {
  type: 'FeatureCollection' as const,
  features: [
    ...Array.from({ length: 11 }, (_, index) => {
      const lat = -75 + (index * 15)
      return {
        type: 'Feature' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: Array.from({ length: 73 }, (_, step) => [-180 + (step * 5), lat]),
        },
        properties: { kind: 'parallel' },
      }
    }),
    ...Array.from({ length: 24 }, (_, index) => {
      const lon = -180 + (index * 15)
      return {
        type: 'Feature' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: Array.from({ length: 37 }, (_, step) => [lon, -90 + (step * 5)]),
        },
        properties: { kind: 'meridian' },
      }
    }),
  ],
}
const UNDERSEA_NETWORK_FOCUS_VIEW = {
  longitude: 18,
  latitude: 8,
  zoom: 2.3,
  bearing: 0,
  pitch: 0,
}

interface MapCanvasProps {
  liveAssets: TrackEventProperties[]
  disruptions: DisruptionEvent[]
  onMapClick?: (lon: number, lat: number) => void
  active?: boolean
}

type HoverObject =
  | { kind: 'track'; item: TrackEventProperties }
  | { kind: 'disruption'; item: DisruptionEvent }
  | { kind: 'underseaCable'; item: { name?: string; id?: string } }
  | { kind: 'landingPoint'; item: { name?: string; id?: string; lon?: number; lat?: number } }
const VIEWPORT_CULL_MARGIN_RATIO = 0.18

type ViewBounds = {
  west: number
  south: number
  east: number
  north: number
}

type TrailPoint = {
  lon: number
  lat: number
  altitude_m?: number
  timestamp: number
}

type VisibleTrail = {
  key: string
  positions: TrailPoint[]
  visibility: 'visible' | 'ghost' | 'hidden'
}

function clampZoom(nextZoom: number): number {
  return Math.max(1.5, Math.min(18, nextZoom))
}

function niceDistance(meters: number): number {
  const steps = [1, 2, 5]
  const exponent = Math.floor(Math.log10(meters))
  const magnitude = 10 ** exponent
  const normalized = meters / magnitude
  const step = steps.find((candidate) => normalized <= candidate) ?? 10
  return step * magnitude
}

function formatScaleDistance(meters: number): string {
  if (meters >= 1000) {
    const km = meters / 1000
    return Number.isInteger(km) ? `${km} km` : `${km.toFixed(1)} km`
  }
  return `${Math.round(meters)} m`
}

function normalizeLongitude(lon: number): number {
  if (!Number.isFinite(lon)) return lon
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

function getLongitudeSpan(bounds: ViewBounds): number {
  if (!Number.isFinite(bounds.west) || !Number.isFinite(bounds.east)) return 360
  const rawSpan = bounds.east - bounds.west
  if (Math.abs(rawSpan) >= 360) return 360
  const normalized = ((rawSpan % 360) + 360) % 360
  return normalized === 0 ? 360 : normalized
}

function expandBounds(bounds: ViewBounds, ratio: number): ViewBounds {
  const lonSpan = getLongitudeSpan(bounds)
  const latSpan = Math.max(0.1, bounds.north - bounds.south)
  const lonMargin = Math.min(160, Math.max(8, lonSpan * ratio))
  const latMargin = Math.min(45, Math.max(4, latSpan * ratio))
  const expandedLonSpan = Math.min(360, lonSpan + (lonMargin * 2))
  const south = Math.max(-90, bounds.south - latMargin)
  const north = Math.min(90, bounds.north + latMargin)

  if (expandedLonSpan >= 355) {
    return {
      west: -180,
      east: 180,
      south,
      north,
    }
  }

  return {
    west: normalizeLongitude(bounds.west - lonMargin),
    east: normalizeLongitude(bounds.east + lonMargin),
    south,
    north,
  }
}

function isLonInBounds(lon: number, bounds: ViewBounds): boolean {
  if (getLongitudeSpan(bounds) >= 355) return true
  const normalizedLon = normalizeLongitude(lon)
  const west = normalizeLongitude(bounds.west)
  const east = normalizeLongitude(bounds.east)
  if (west <= east) return normalizedLon >= west && normalizedLon <= east
  return normalizedLon >= west || normalizedLon <= east
}

function isPointInBounds(lon: number | undefined, lat: number | undefined, bounds: ViewBounds | null): boolean {
  if (!bounds || typeof lon !== 'number' || typeof lat !== 'number') return false
  return lat >= bounds.south && lat <= bounds.north && isLonInBounds(lon, bounds)
}

function getRenderPosition(
  lon: number | undefined,
  lat: number | undefined,
  altitudeM: number | undefined,
  useAltitude: boolean,
): [number, number] | [number, number, number] {
  const x = lon ?? 0
  const y = lat ?? 0
  if (!useAltitude) return [x, y]
  const z = typeof altitudeM === 'number' && Number.isFinite(altitudeM) ? Math.max(0, altitudeM) : 0
  return [x, y, z]
}

function deriveVisibleTrails(
  trailBuffer: Map<string, TrailPoint[]>,
  prefix: string,
  cullBounds: ViewBounds | null,
  getTrailVisibilityMode: (trackKey: string) => 'visible' | 'ghost' | 'hidden',
): VisibleTrail[] {
  return Array.from(trailBuffer.entries())
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, positions]) => ({ key, positions, visibility: getTrailVisibilityMode(key) }))
    .filter((trail) => (
      trail.visibility !== 'hidden' &&
      trail.positions.length >= 2 &&
      trail.positions.some((point) => isPointInBounds(point.lon, point.lat, cullBounds))
    ))
}

export function MapCanvas({ liveAssets, disruptions, onMapClick, active = true }: MapCanvasProps) {
  const {
    viewport,
    setViewport,
    setViewportBounds,
    layers,
    mapMode,
    showTrails,
    showFilteredTrackGhosts,
    showCocom,
    showUnderseaCables,
    globeView,
    classFilter,
    hiddenGroupFilters,
    hiddenSpaceConstellations,
    workspaceSearch,
    declutterMode,
    selectAsset,
    selectLandingPoint,
    clearLandingPointSelection,
    trailBuffer,
    selectedTrackId,
    selectedDomain,
    selectedLandingPoint,
    selectedTrackHistory,
    selectedOrbitPoints,
    spaceTrackDuration,
    pendingAlerts,
    investigationContext,
    watchedSpaceTrackIds,
    pinnedTrackKeys: userPinnedTrackKeys,
  } = useMapStore(useShallow((state) => ({
    viewport: state.viewport,
    setViewport: state.setViewport,
    setViewportBounds: state.setViewportBounds,
    layers: state.layers,
    mapMode: state.mapMode,
    showTrails: state.showTrails,
    showFilteredTrackGhosts: state.showFilteredTrackGhosts,
    showCocom: state.showCocom,
    showUnderseaCables: state.showUnderseaCables,
    globeView: state.globeView,
    classFilter: state.classFilter,
    hiddenGroupFilters: state.hiddenGroupFilters,
    hiddenSpaceConstellations: state.hiddenSpaceConstellations,
    workspaceSearch: state.workspaceSearch,
    declutterMode: state.declutterMode,
    selectAsset: state.selectAsset,
    selectLandingPoint: state.selectLandingPoint,
    clearLandingPointSelection: state.clearLandingPointSelection,
    trailBuffer: state.trailBuffer,
    selectedTrackId: state.selectedTrackId,
    selectedDomain: state.selectedDomain,
    selectedLandingPoint: state.selectedLandingPoint,
    selectedTrackHistory: state.selectedTrackHistory,
    selectedOrbitPoints: state.selectedOrbitPoints,
    spaceTrackDuration: state.spaceTrackDuration,
    pendingAlerts: state.pendingAlerts,
    investigationContext: state.investigationContext,
    watchedSpaceTrackIds: state.watchedSpaceTrackIds,
    pinnedTrackKeys: state.pinnedTrackKeys,
  })))
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; object: HoverObject } | null>(null)
  const [renderWarning, setRenderWarning] = useState<string | null>(null)
  const [rendererDisabled, setRendererDisabled] = useState(false)
  const [cocomFailed, setCocomFailed] = useState(false)
  const [localViewport, setLocalViewport] = useState(viewport)
  const [containerSize, setContainerSize] = useState({ width: 1, height: 1 })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const faultHandledRef = useRef(false)
  const resizeFaultSeenRef = useRef(false)
  const interactionActiveRef = useRef(false)
  const shuttingDownRef = useRef(false)

  useEffect(() => {
    if (interactionActiveRef.current) return
    setLocalViewport(viewport)
  }, [viewport])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return

    const updateSize = () => {
      if (shuttingDownRef.current) return
      const rect = node.getBoundingClientRect()
      setContainerSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      })
    }

    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (active) {
      shuttingDownRef.current = false
      return
    }

    shuttingDownRef.current = true
    interactionActiveRef.current = false
    setHoverInfo(null)
    setRenderWarning(null)
    setContainerSize({ width: 1, height: 1 })
  }, [active])

  const viewState = useMemo<MapViewState>(() => ({
    longitude: localViewport.longitude,
    latitude: localViewport.latitude,
    zoom: localViewport.zoom,
    bearing: localViewport.bearing,
    pitch: localViewport.pitch,
  }), [localViewport.bearing, localViewport.latitude, localViewport.longitude, localViewport.pitch, localViewport.zoom])

  const effectiveContainerSize = useMemo(() => {
    if (containerSize.width >= 240 && containerSize.height >= 180) return containerSize
    if (typeof window === 'undefined') return containerSize
    return {
      width: Math.max(containerSize.width, window.innerWidth),
      height: Math.max(containerSize.height, window.innerHeight),
    }
  }, [containerSize])
  const deckRendererReady = effectiveContainerSize.width >= 32 && effectiveContainerSize.height >= 32

  const cullBounds = useMemo(() => {
    try {
      const mercator = new WebMercatorViewport({
        width: effectiveContainerSize.width,
        height: effectiveContainerSize.height,
        longitude: localViewport.longitude,
        latitude: localViewport.latitude,
        zoom: localViewport.zoom,
        bearing: localViewport.bearing,
        pitch: localViewport.pitch,
      })
      const [west, south, east, north] = mercator.getBounds() as [number, number, number, number]
      return expandBounds({ west, south, east, north }, VIEWPORT_CULL_MARGIN_RATIO)
    } catch {
      return null
    }
  }, [effectiveContainerSize.height, effectiveContainerSize.width, localViewport])

  useEffect(() => {
    setViewportBounds(cullBounds)
  }, [cullBounds, setViewportBounds])

  const pinnedTrackKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const key of userPinnedTrackKeys) {
      keys.add(key)
    }
    if (selectedDomain && selectedTrackId) {
      keys.add(`${selectedDomain}:${selectedTrackId}`)
    }
    if (investigationContext) {
      keys.add(`${investigationContext.domain}:${investigationContext.trackId}`)
    }
    for (const alert of pendingAlerts) {
      keys.add(`${alert.domain}:${alert.trackId}`)
    }
    for (const watchedId of watchedSpaceTrackIds) {
      keys.add(`Space:${watchedId}`)
    }
    return keys
  }, [investigationContext, pendingAlerts, selectedDomain, selectedTrackId, userPinnedTrackKeys, watchedSpaceTrackIds])

  // Filter assets: hidden layers and filtered classifications are excluded entirely.
  // Muted layers pass through (rendered dimmed). Think of hidden=off, muted=context.
  const filteredAssets = useMemo(() => {
    const isHiddenByGroup = (asset: TrackEventProperties): boolean => {
      const domain = asset.source_domain
      const hidden = hiddenGroupFilters[domain] ?? []
      if (hidden.length === 0) return false

      const keys: string[] = []
      if (domain === 'Air') {
        keys.push(`Air:${getAirlineGroup(asset.callsign, asset.classification)}`)
      } else if (domain === 'Maritime') {
        keys.push(`Maritime:${getMmsiCountry(asset.track_id)}`)
      } else if (domain === 'Space') {
        const objectType = normalizeObjectType(asset.object_type)
        const orbitClass = normalizeOrbitClass(asset.orbit_class, asset.orbital_period_min)
        const constellation = getConstellation(asset.callsign, asset.object_type)
        keys.push(
          `Space:${objectType}`,
          `Space:${objectType}:${orbitClass}`,
          `Space:${objectType}:${orbitClass}:${constellation}`,
        )
      }

      return keys.some((key) => hidden.includes(key))
    }

    return liveAssets.filter((a) => {
      const assetKey = `${a.source_domain}:${a.track_id}`
      if (pinnedTrackKeys.has(assetKey)) return true
      const layerState = layers[a.source_domain as keyof typeof layers]
      if (layerState?.visibility === 'hidden') return false
      if (a.source_domain === 'Space' && hiddenSpaceConstellations.includes(getConstellation(a.callsign, a.object_type))) return false
      // Classification filter — hide assets whose classification is in the "hidden" list
      const hidden = classFilter[a.source_domain] ?? []
      if (hidden.length > 0 && a.classification && hidden.includes(a.classification)) return false
      if (isHiddenByGroup(a)) return false
      return true
    })
  }, [liveAssets, layers, hiddenSpaceConstellations, classFilter, hiddenGroupFilters, pinnedTrackKeys])

  const viewportAssets = useMemo(() => (
    filteredAssets.filter((asset) => isPointInBounds(asset.lon, asset.lat, cullBounds))
  ), [filteredAssets, cullBounds])

  const visibleTrackKeySet = useMemo(() => {
    const keys = new Set<string>()
    for (const asset of filteredAssets) {
      keys.add(`${asset.source_domain}:${asset.track_id}`)
    }
    return keys
  }, [filteredAssets])

  const ghostTrailKeySet = useMemo(() => {
    if (!showFilteredTrackGhosts) return new Set<string>()
    const keys = new Set<string>()
    for (const asset of liveAssets) {
      const assetKey = `${asset.source_domain}:${asset.track_id}`
      if (pinnedTrackKeys.has(assetKey)) continue
      if (visibleTrackKeySet.has(assetKey)) continue
      if (layers[asset.source_domain]?.visibility === 'hidden') continue
      keys.add(assetKey)
    }
    return keys
  }, [showFilteredTrackGhosts, liveAssets, pinnedTrackKeys, visibleTrackKeySet, layers])

  const visibleDisruptions = useMemo(() => (
    disruptions.filter((event) => {
      if (layers[event.source_domain]?.visibility === 'hidden') return false
      const centroid = event.centroid?.coordinates
      if (centroid) return isPointInBounds(centroid[0], centroid[1], cullBounds)
      return true
    })
  ), [disruptions, layers, cullBounds])

  // Workspace search match set — drives declutter opacity on map.
  // Like a spotlight: when declutter mode is on, non-matching tracks dim to ~10%.
  const searchMatchSet = useMemo<Set<string> | null>(() => {
    const q = workspaceSearch.trim().toLowerCase()
    if (!q) return null
    const set = new Set<string>()
    for (const a of filteredAssets) {
      if (
        a.track_id.toLowerCase().includes(q) ||
        (a.callsign ?? '').toLowerCase().includes(q) ||
        (a.classification ?? '').toLowerCase().includes(q)
      ) {
        set.add(`${a.source_domain}:${a.track_id}`)
      }
    }
    return set
  }, [filteredAssets, workspaceSearch])

  const spacePriorityKeys = useMemo(() => {
    const keys = new Set<string>()
    if (selectedDomain === 'Space' && selectedTrackId) {
      keys.add(`Space:${selectedTrackId}`)
    }
    if (investigationContext?.domain === 'Space') {
      keys.add(`Space:${investigationContext.trackId}`)
    }
    for (const alert of pendingAlerts) {
      if (alert.domain === 'Space') keys.add(`Space:${alert.trackId}`)
    }
    for (const watchedId of watchedSpaceTrackIds) {
      keys.add(`Space:${watchedId}`)
    }
    if (searchMatchSet !== null) {
      for (const key of searchMatchSet) {
        if (key.startsWith('Space:')) keys.add(key)
      }
    }
    return keys
  }, [selectedDomain, selectedTrackId, investigationContext, pendingAlerts, watchedSpaceTrackIds, searchMatchSet])

  // Per-asset alpha helper: applies search-based declutter dimming
  const getAlpha = useCallback((d: TrackEventProperties, baseAlpha = 255): number => {
    if (declutterMode && searchMatchSet !== null) {
      return searchMatchSet.has(`${d.source_domain}:${d.track_id}`) ? baseAlpha : 25
    }
    return baseAlpha
  }, [declutterMode, searchMatchSet])

  const getTrailVisibilityMode = useCallback((trackKey: string): 'visible' | 'ghost' | 'hidden' => {
    if (pinnedTrackKeys.has(trackKey) || visibleTrackKeySet.has(trackKey)) return 'visible'
    if (ghostTrailKeySet.has(trackKey)) return 'ghost'
    return 'hidden'
  }, [ghostTrailKeySet, pinnedTrackKeys, visibleTrackKeySet])

  // Per-domain effective opacity: muted domains render at 25% of their base opacity
  const domainOpacity = useCallback((domain: string): number => {
    const ls = layers[domain as keyof typeof layers]
    if (!ls) return 1
    return ls.visibility === 'muted' ? ls.opacity * 0.25 : ls.opacity
  }, [layers])

  const useSpaceAltitude = globeView
  const hoveredLandingPoint = useMemo(() => (
    hoverInfo?.object.kind === 'landingPoint' ? hoverInfo.object.item : null
  ), [hoverInfo])

  const maritimeViewportAssets = useMemo(() => (
    viewportAssets.filter((asset) => asset.source_domain === 'Maritime' && typeof asset.lon === 'number' && typeof asset.lat === 'number')
  ), [viewportAssets])
  const airViewportAssets = useMemo(() => (
    viewportAssets.filter((asset) => asset.source_domain === 'Air' && typeof asset.lon === 'number' && typeof asset.lat === 'number')
  ), [viewportAssets])
  const spaceViewportAssets = useMemo(() => (
    viewportAssets.filter((asset) => asset.source_domain === 'Space' && typeof asset.lon === 'number' && typeof asset.lat === 'number')
  ), [viewportAssets])

  const focusMaritimeAssets = useMemo(() => (
    maritimeViewportAssets.filter((asset) => pinnedTrackKeys.has(`Maritime:${asset.track_id}`))
  ), [maritimeViewportAssets, pinnedTrackKeys])
  const backgroundMaritimeAssets = useMemo(() => (
    maritimeViewportAssets.filter((asset) => !pinnedTrackKeys.has(`Maritime:${asset.track_id}`))
  ), [maritimeViewportAssets, pinnedTrackKeys])
  const focusAirAssets = useMemo(() => (
    airViewportAssets.filter((asset) => pinnedTrackKeys.has(`Air:${asset.track_id}`))
  ), [airViewportAssets, pinnedTrackKeys])
  const backgroundAirAssets = useMemo(() => (
    airViewportAssets.filter((asset) => !pinnedTrackKeys.has(`Air:${asset.track_id}`))
  ), [airViewportAssets, pinnedTrackKeys])
  const prioritySpaceAssets = useMemo(() => (
    spaceViewportAssets.filter((asset) => (
      spacePriorityKeys.has(`Space:${asset.track_id}`) || pinnedTrackKeys.has(`Space:${asset.track_id}`)
    ))
  ), [spaceViewportAssets, spacePriorityKeys, pinnedTrackKeys])
  const backgroundSpaceAssets = useMemo(() => (
    spaceViewportAssets.filter((asset) => (
      !spacePriorityKeys.has(`Space:${asset.track_id}`) && !pinnedTrackKeys.has(`Space:${asset.track_id}`)
    ))
  ), [spaceViewportAssets, spacePriorityKeys, pinnedTrackKeys])

  const selectedMaritimeAsset = useMemo(() => (
    selectedDomain === 'Maritime'
      ? maritimeViewportAssets.find((asset) => asset.track_id === selectedTrackId)
      : undefined
  ), [maritimeViewportAssets, selectedDomain, selectedTrackId])
  const selectedAirAsset = useMemo(() => (
    selectedDomain === 'Air'
      ? airViewportAssets.find((asset) => asset.track_id === selectedTrackId)
      : undefined
  ), [airViewportAssets, selectedDomain, selectedTrackId])
  const selectedSpaceAsset = useMemo(() => (
    selectedDomain === 'Space'
      ? spaceViewportAssets.find((asset) => asset.track_id === selectedTrackId)
      : undefined
  ), [spaceViewportAssets, selectedDomain, selectedTrackId])

  const maritimeTrails = useMemo(() => (
    deriveVisibleTrails(trailBuffer, 'Maritime:', cullBounds, getTrailVisibilityMode)
  ), [trailBuffer, cullBounds, getTrailVisibilityMode])
  const airTrails = useMemo(() => (
    deriveVisibleTrails(trailBuffer, 'Air:', cullBounds, getTrailVisibilityMode)
  ), [trailBuffer, cullBounds, getTrailVisibilityMode])
  const spaceTrails = useMemo(() => (
    deriveVisibleTrails(trailBuffer, 'Space:', cullBounds, getTrailVisibilityMode)
  ), [trailBuffer, cullBounds, getTrailVisibilityMode])

  const disruptionFeatures = useMemo(() => (
    visibleDisruptions
      .filter((event) => event.geometry)
      .map((event) => ({
        type: 'Feature' as const,
        geometry: event.geometry!,
        properties: event,
      }))
  ), [visibleDisruptions])
  const disruptionCentroids = useMemo(() => (
    visibleDisruptions
      .filter((event) => event.centroid?.coordinates)
      .map((event) => ({
        ...event,
        lon: event.centroid!.coordinates[0],
        lat: event.centroid!.coordinates[1],
      }))
  ), [visibleDisruptions])

  const staticLayerBuild = useMemo(() => {
    const buildStarted = performance.now()
    const nextLayers: Layer<object>[] = []

    if (globeView && (mapMode === 'full' || mapMode === 'simple')) {
      nextLayers.push(new TileLayer({
        id: 'globe-base-tiles',
        data: GLOBE_TILE_URL,
        minZoom: 0,
        maxZoom: 19,
        tileSize: 256,
        renderSubLayers: (props: any) => {
          const { west, south, east, north } = props.tile.bbox
          if (!props.data) return null
          return new BitmapLayer({
            ...props,
            data: null,
            image: props.data,
            bounds: [west, south, east, north] as [number, number, number, number],
          })
        },
      }) as unknown as Layer<object>)
    }

    if (mapMode === 'outline') {
      const outlineFillColor: [number, number, number, number] = globeView ? [15, 23, 42, 235] : [15, 23, 42, 45]
      nextLayers.push(new GeoJsonLayer({
        id: 'outline-land',
        data: WORLD_BOUNDARIES_URL,
        stroked: true,
        filled: true,
        pickable: false,
        lineWidthMinPixels: 1.2,
        lineWidthMaxPixels: 2.5,
        getLineColor: [148, 163, 184, 230],
        getFillColor: outlineFillColor,
        opacity: 0.95,
      }))
      nextLayers.push(new GeoJsonLayer({
        id: 'outline-graticule',
        data: OUTLINE_GRATICULE,
        stroked: true,
        filled: false,
        pickable: false,
        lineWidthMinPixels: 1.2,
        lineWidthMaxPixels: 2.2,
        getLineColor: (feature: { properties?: { kind?: string } }) =>
          feature.properties?.kind === 'parallel'
            ? [71, 85, 105, 190]
            : [51, 65, 85, 155],
        opacity: 0.95,
      }))
    } else if (mapMode === 'simple') {
      nextLayers.push(new GeoJsonLayer({
        id: 'simple-land-outline',
        data: WORLD_BOUNDARIES_URL,
        stroked: true,
        filled: false,
        pickable: false,
        lineWidthMinPixels: 1,
        lineWidthMaxPixels: 2,
        getLineColor: [51, 65, 85, 165],
        opacity: 0.85,
      }))
    }

    if (showCocom && !cocomFailed) {
      nextLayers.push(new GeoJsonLayer({
        id: 'cocom-fills',
        data: COCOM_GEOJSON_URL,
        stroked: true,
        filled: true,
        pickable: false,
        getFillColor: (feature: any) => getCocomColors(feature.properties).fill,
        getLineColor: (feature: any) => getCocomColors(feature.properties).line,
        lineWidthMinPixels: 1.5,
        lineWidthMaxPixels: 3,
        opacity: 1,
      }))

      nextLayers.push(new TextLayer({
        id: 'cocom-labels',
        data: COCOM_LABELS,
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        getText: (d: { abbr: string }) => d.abbr,
        getColor: (d: { color: [number, number, number, number] }) => d.color,
        getSize: 13,
        sizeUnits: 'pixels',
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontWeight: 700,
        characterSet: 'auto',
        pickable: false,
        opacity: 0.9,
      }))
    }

    if (showUnderseaCables) {
      const landingPointRadius = Math.min(10, Math.max(3, localViewport.zoom * 0.9))
      const landingPointPickRadius = Math.min(22, Math.max(10, landingPointRadius + 8))
      const landingPointsInteractive = localViewport.zoom >= LANDING_POINT_INTERACTIVE_ZOOM

      nextLayers.push(new GeoJsonLayer({
        id: 'undersea-cables',
        data: UNDERSEA_CABLES_GEOJSON_URL,
        stroked: true,
        filled: false,
        pickable: true,
        lineWidthMinPixels: 1.5,
        lineWidthMaxPixels: 3,
        getLineColor: [245, 158, 11, 180],
        opacity: 0.8,
        onHover: ({ x, y, object }) => {
          const cable = object?.properties as { name?: string; id?: string } | undefined
          setHoverInfo(cable ? { x, y, object: { kind: 'underseaCable', item: cable } } : null)
        },
      }))

      nextLayers.push(new GeoJsonLayer({
        id: 'undersea-cable-landing-point-hitareas',
        data: UNDERSEA_CABLE_LANDING_POINTS_GEOJSON_URL,
        stroked: false,
        filled: true,
        pointType: 'circle',
        pickable: landingPointsInteractive,
        pointRadiusMinPixels: 10,
        pointRadiusMaxPixels: 22,
        getPointRadius: landingPointPickRadius,
        getFillColor: [255, 255, 255, 1],
        opacity: 0.01,
        updateTriggers: { getPointRadius: [landingPointPickRadius], pickable: [landingPointsInteractive] },
        onHover: ({ x, y, object }) => {
          const landingPoint = object as { geometry?: { coordinates?: [number, number] }; properties?: { name?: string; id?: string } } | undefined
          const coordinates = landingPoint?.geometry?.coordinates
          const properties = landingPoint?.properties
          setHoverInfo(properties ? {
            x,
            y,
            object: {
              kind: 'landingPoint',
              item: {
                ...properties,
                lon: coordinates?.[0],
                lat: coordinates?.[1],
              },
            },
          } : null)
        },
        onClick: ({ object }) => {
          const landingPoint = object as { geometry?: { coordinates?: [number, number] }; properties?: { name?: string; id?: string } } | undefined
          const coordinates = landingPoint?.geometry?.coordinates
          const properties = landingPoint?.properties
          if (!coordinates || !properties?.id || !properties?.name) return
          selectLandingPoint({
            id: properties.id,
            name: properties.name,
            lon: coordinates[0],
            lat: coordinates[1],
          })
        },
      }))

      nextLayers.push(new GeoJsonLayer({
        id: 'undersea-cable-landing-points',
        data: UNDERSEA_CABLE_LANDING_POINTS_GEOJSON_URL,
        stroked: true,
        filled: true,
        pointType: 'circle',
        pickable: false,
        pointRadiusMinPixels: 3,
        pointRadiusMaxPixels: 12,
        getPointRadius: landingPointRadius,
        getFillColor: [255, 248, 220, 220],
        getLineColor: [120, 53, 15, 220],
        lineWidthMinPixels: 1,
        opacity: 0.95,
        updateTriggers: { getPointRadius: [landingPointRadius] },
      }))

      if (selectedLandingPoint) {
        nextLayers.push(new ScatterplotLayer({
          id: 'undersea-cable-landing-point-selection',
          data: [selectedLandingPoint],
          getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
          getRadius: landingPointRadius + 6,
          radiusUnits: 'pixels',
          stroked: true,
          filled: false,
          lineWidthUnits: 'pixels',
          getLineWidth: 2.5,
          getLineColor: [251, 191, 36, 235],
          pickable: false,
        }))
      }

      if (hoveredLandingPoint && typeof hoveredLandingPoint.lon === 'number' && typeof hoveredLandingPoint.lat === 'number') {
        nextLayers.push(new ScatterplotLayer({
          id: 'undersea-cable-landing-point-hover',
          data: [hoveredLandingPoint],
          getPosition: (d: { lon?: number; lat?: number }) => [d.lon ?? 0, d.lat ?? 0],
          getRadius: landingPointRadius + 4,
          radiusUnits: 'pixels',
          stroked: true,
          filled: false,
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          getLineColor: [255, 237, 213, 235],
          pickable: false,
        }))
      }
    }

    return { layers: nextLayers, buildMs: performance.now() - buildStarted }
  }, [
    globeView,
    mapMode,
    showCocom,
    cocomFailed,
    showUnderseaCables,
    localViewport.zoom,
    selectLandingPoint,
    selectedLandingPoint,
    hoveredLandingPoint,
  ])

  const maritimeLayerBuild = useMemo(() => {
    const buildStarted = performance.now()
    const nextLayers: Layer<object>[] = []

    if (layers.Maritime.visibility !== 'hidden') {
      nextLayers.push(new ScatterplotLayer<TrackEventProperties>({
        id: 'ais-background-points',
        data: backgroundMaritimeAssets,
        getPosition: (d) => [d.lon ?? 0, d.lat ?? 0],
        getRadius: localViewport.zoom < 3 ? 2.4 : localViewport.zoom < 5 ? 3.2 : 4,
        radiusUnits: 'pixels',
        getLineWidth: 0.5,
        lineWidthUnits: 'pixels',
        stroked: true,
        filled: true,
        getLineColor: [226, 232, 240, 70],
        getFillColor: (d) => [34, 211, 238, Math.max(30, Math.round(getAlpha(d) * 0.42))],
        updateTriggers: {
          getFillColor: [declutterMode, searchMatchSet],
          getRadius: [localViewport.zoom],
        },
        pickable: true,
        opacity: domainOpacity('Maritime') * 0.9,
        onHover: ({ x, y, object }) =>
          setHoverInfo(object ? { x, y, object: { kind: 'track', item: object } } : null),
        onClick: ({ object }) =>
          object && selectAsset(object.track_id, object.source_domain),
      }))

      if (focusMaritimeAssets.length > 0) {
        nextLayers.push(new ScatterplotLayer<TrackEventProperties>({
          id: 'ais-focus-points',
          data: focusMaritimeAssets,
          getPosition: (d) => [d.lon ?? 0, d.lat ?? 0],
          getRadius: localViewport.zoom < 3 ? 3.8 : localViewport.zoom < 5 ? 5.2 : 6,
          radiusUnits: 'pixels',
          getLineWidth: 1.4,
          lineWidthUnits: 'pixels',
          stroked: true,
          filled: true,
          getLineColor: [250, 204, 21, 220],
          getFillColor: [34, 211, 238, 220],
          pickable: true,
          opacity: domainOpacity('Maritime'),
          onHover: ({ x, y, object }) =>
            setHoverInfo(object ? { x, y, object: { kind: 'track', item: object } } : null),
          onClick: ({ object }) =>
            object && selectAsset(object.track_id, object.source_domain),
        }))
      }

      if (selectedMaritimeAsset) {
        nextLayers.push(new TextLayer<TrackEventProperties>({
          id: 'ais-selected-icon',
          data: [selectedMaritimeAsset],
          getPosition: (d) => [d.lon ?? 0, d.lat ?? 0],
          getText: () => '⚓',
          getColor: [15, 23, 42, 255],
          getSize: 16,
          sizeUnits: 'pixels',
          pickable: false,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          characterSet: 'auto',
          fontFamily: '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", "DejaVu Sans", Arial, sans-serif',
          fontSettings: { sdf: true, fontSize: 64 },
        }))
        nextLayers.push(new ScatterplotLayer<TrackEventProperties>({
          id: 'ais-selected-ring',
          data: [selectedMaritimeAsset],
          getPosition: (d) => [d.lon ?? 0, d.lat ?? 0],
          getRadius: 16,
          radiusUnits: 'pixels',
          stroked: true,
          filled: false,
          lineWidthUnits: 'pixels',
          getLineWidth: 3,
          getLineColor: [250, 204, 21, 255],
          pickable: false,
        }))
      }

      if (selectedDomain === 'Maritime' && selectedTrackHistory.length >= 2) {
        nextLayers.push(new PathLayer({
          id: 'maritime-selected-history',
          data: [{ positions: selectedTrackHistory }],
          getPath: (d: { positions: TrailPoint[] }) => d.positions.map((point) => [point.lon, point.lat] as [number, number]),
          getColor: [34, 211, 238, 220],
          getWidth: 3,
          widthUnits: 'pixels',
          pickable: false,
          opacity: 1,
        }))
      }

      if (showTrails) {
        nextLayers.push(new PathLayer({
          id: 'maritime-trails',
          data: maritimeTrails,
          getPath: (d: VisibleTrail) => d.positions.map((point) => [point.lon, point.lat] as [number, number]),
          getColor: (d: VisibleTrail) =>
            d.visibility === 'ghost' ? [100, 116, 139, 45] : [80, 80, 80, 100],
          getWidth: 1.5,
          widthUnits: 'pixels',
          pickable: false,
          opacity: domainOpacity('Maritime'),
        }))
      }
    }

    return { layers: nextLayers, buildMs: performance.now() - buildStarted }
  }, [
    layers.Maritime.visibility,
    backgroundMaritimeAssets,
    focusMaritimeAssets,
    selectedMaritimeAsset,
    selectedDomain,
    selectedTrackHistory,
    showTrails,
    maritimeTrails,
    localViewport.zoom,
    domainOpacity,
    getAlpha,
    selectAsset,
    declutterMode,
    searchMatchSet,
  ])

  const airLayerBuild = useMemo(() => {
    const buildStarted = performance.now()
    const nextLayers: Layer<object>[] = []

    if (layers.Air.visibility !== 'hidden') {
      nextLayers.push(new ScatterplotLayer<TrackEventProperties>({
        id: 'adsb-background-points',
        data: backgroundAirAssets,
        getPosition: (d) => [d.lon ?? 0, d.lat ?? 0],
        getRadius: localViewport.zoom < 3 ? 2.8 : localViewport.zoom < 5 ? 3.6 : 4.5,
        radiusUnits: 'pixels',
        stroked: true,
        filled: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 0.75,
        getLineColor: [226, 232, 240, 80],
        getFillColor: (d) => {
          const base = CLASSIFICATION_COLORS[d.classification ?? 'Unknown']
          return [base[0], base[1], base[2], Math.max(36, Math.round(getAlpha(d) * 0.55))] as [number, number, number, number]
        },
        updateTriggers: {
          getFillColor: [declutterMode, searchMatchSet],
          getRadius: [localViewport.zoom],
        },
        pickable: true,
        opacity: domainOpacity('Air') * 0.9,
        onHover: ({ x, y, object }) =>
          setHoverInfo(object ? { x, y, object: { kind: 'track', item: object } } : null),
        onClick: ({ object }) =>
          object && selectAsset(object.track_id, object.source_domain),
      }))

      if (focusAirAssets.length > 0) {
        nextLayers.push(new ScatterplotLayer<TrackEventProperties>({
          id: 'adsb-focus-points',
          data: focusAirAssets,
          getPosition: (d) => [d.lon ?? 0, d.lat ?? 0],
          getRadius: localViewport.zoom < 3 ? 4 : localViewport.zoom < 5 ? 5.4 : 6.5,
          radiusUnits: 'pixels',
          stroked: true,
          filled: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.4,
          getLineColor: [250, 204, 21, 220],
          getFillColor: (d) => {
            const base = CLASSIFICATION_COLORS[d.classification ?? 'Unknown']
            return [base[0], base[1], base[2], 230] as [number, number, number, number]
          },
          pickable: true,
          opacity: domainOpacity('Air'),
          onHover: ({ x, y, object }) =>
            setHoverInfo(object ? { x, y, object: { kind: 'track', item: object } } : null),
          onClick: ({ object }) =>
            object && selectAsset(object.track_id, object.source_domain),
        }))
      }

      if (selectedAirAsset) {
        nextLayers.push(new TextLayer<TrackEventProperties>({
          id: 'adsb-selected-icon',
          data: [selectedAirAsset],
          getPosition: (d) => [d.lon ?? 0, d.lat ?? 0],
          getText: () => '✈',
          getColor: (d) => {
            const base = CLASSIFICATION_COLORS[d.classification ?? 'Unknown']
            return [base[0], base[1], base[2], 255] as [number, number, number, number]
          },
          getSize: 16,
          getAngle: (d) => d.heading_deg ?? 0,
          sizeUnits: 'pixels',
          pickable: false,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          characterSet: 'auto',
          fontFamily: '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", "DejaVu Sans", Arial, sans-serif',
          fontSettings: { sdf: true, fontSize: 64 },
        }))
        nextLayers.push(new ScatterplotLayer<TrackEventProperties>({
          id: 'adsb-selected-ring',
          data: [selectedAirAsset],
          getPosition: (d) => [d.lon ?? 0, d.lat ?? 0],
          getRadius: 14,
          radiusUnits: 'pixels',
          stroked: true,
          filled: false,
          lineWidthUnits: 'pixels',
          getLineWidth: 3,
          getLineColor: [250, 204, 21, 255],
          pickable: false,
        }))
      }

      if (selectedDomain === 'Air' && selectedTrackHistory.length >= 2) {
        nextLayers.push(new PathLayer({
          id: 'air-selected-history',
          data: [{ positions: selectedTrackHistory }],
          getPath: (d: { positions: TrailPoint[] }) => d.positions.map((point) => [point.lon, point.lat] as [number, number]),
          getColor: [56, 189, 248, 220],
          getWidth: 3,
          widthUnits: 'pixels',
          pickable: false,
          opacity: 1,
        }))
      }

      if (showTrails) {
        nextLayers.push(new PathLayer({
          id: 'air-trails',
          data: airTrails,
          getPath: (d: VisibleTrail) => d.positions.map((point) => [point.lon, point.lat] as [number, number]),
          getColor: (d: VisibleTrail) =>
            d.visibility === 'ghost' ? [148, 163, 184, 40] : [100, 181, 246, 120],
          getWidth: 1.5,
          widthUnits: 'pixels',
          pickable: false,
          opacity: domainOpacity('Air'),
        }))
      }
    }

    return { layers: nextLayers, buildMs: performance.now() - buildStarted }
  }, [
    layers.Air.visibility,
    backgroundAirAssets,
    focusAirAssets,
    selectedAirAsset,
    selectedDomain,
    selectedTrackHistory,
    showTrails,
    airTrails,
    localViewport.zoom,
    domainOpacity,
    getAlpha,
    selectAsset,
    declutterMode,
    searchMatchSet,
  ])

  const spaceLayerBuild = useMemo(() => {
    const buildStarted = performance.now()
    const nextLayers: Layer<object>[] = []

    if (layers.Space.visibility !== 'hidden') {
      if (backgroundSpaceAssets.length > 0) {
        nextLayers.push(new ScatterplotLayer<TrackEventProperties>({
          id: 'space-background-points',
          data: backgroundSpaceAssets,
          getPosition: (d) => getRenderPosition(d.lon, d.lat, d.altitude_m, useSpaceAltitude),
          getRadius: 2.5,
          radiusUnits: 'pixels',
          stroked: false,
          filled: true,
          getFillColor: [148, 163, 184, 95],
          pickable: true,
          opacity: domainOpacity('Space') * 0.5,
          onHover: ({ x, y, object }) =>
            setHoverInfo(object ? { x, y, object: { kind: 'track', item: object } } : null),
          onClick: ({ object }) =>
            object && selectAsset(object.track_id, object.source_domain),
        }))
      }

      nextLayers.push(new TextLayer<TrackEventProperties>({
        id: 'space-priority-icons',
        data: prioritySpaceAssets,
        getPosition: (d) => getRenderPosition(d.lon, d.lat, d.altitude_m, useSpaceAltitude),
        getText: () => '🛰',
        getColor: (d) => {
          const base = CLASSIFICATION_COLORS[d.classification ?? 'Unknown']
          return [base[0], base[1], base[2], getAlpha(d)] as [number, number, number, number]
        },
        updateTriggers: { getColor: [declutterMode, searchMatchSet] },
        getSize: 18,
        sizeUnits: 'pixels',
        pickable: true,
        opacity: domainOpacity('Space'),
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        characterSet: 'auto',
        fontFamily: '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", "DejaVu Sans", Arial, sans-serif',
        fontSettings: { sdf: true, fontSize: 64 },
        onHover: ({ x, y, object }) =>
          setHoverInfo(object ? { x, y, object: { kind: 'track', item: object } } : null),
        onClick: ({ object }) =>
          object && selectAsset(object.track_id, object.source_domain),
      }))

      if (selectedSpaceAsset) {
        nextLayers.push(new ScatterplotLayer<TrackEventProperties>({
          id: 'space-selected-ring',
          data: [selectedSpaceAsset],
          getPosition: (d) => getRenderPosition(d.lon, d.lat, d.altitude_m, useSpaceAltitude),
          getRadius: 14,
          radiusUnits: 'pixels',
          stroked: true,
          filled: false,
          lineWidthUnits: 'pixels',
          getLineWidth: 3,
          getLineColor: [250, 204, 21, 255],
          pickable: false,
        }))
      }

      if (showTrails) {
        nextLayers.push(new PathLayer({
          id: 'space-trails',
          data: spaceTrails,
          getPath: (d: VisibleTrail) => d.positions.map((point) => getRenderPosition(point.lon, point.lat, point.altitude_m, useSpaceAltitude)),
          getColor: (d: VisibleTrail) =>
            d.visibility === 'ghost' ? [100, 116, 139, 35] : [148, 163, 184, 90],
          getWidth: 1.2,
          widthUnits: 'pixels',
          pickable: false,
          opacity: domainOpacity('Space') * 0.8,
        }))
      }

      if (selectedDomain === 'Space' && selectedTrackHistory.length >= 2) {
        nextLayers.push(new PathLayer({
          id: 'space-selected-history',
          data: [{ positions: selectedTrackHistory }],
          getPath: (d: { positions: TrailPoint[] }) => d.positions.map((point) => getRenderPosition(point.lon, point.lat, point.altitude_m, useSpaceAltitude)),
          getColor: [250, 204, 21, 180],
          getWidth: 1.8,
          widthUnits: 'pixels',
          pickable: false,
          opacity: 0.95,
        }))
      }

      if (selectedDomain === 'Space' && selectedOrbitPoints.length >= 2) {
        nextLayers.push(new PathLayer({
          id: `space-orbital-track-${spaceTrackDuration}`,
          data: [{ positions: selectedOrbitPoints }],
          getPath: (d: { positions: typeof selectedOrbitPoints }) =>
            d.positions.map((point) => [point.lon, point.lat, Math.max(0, (point.alt_km ?? 0) * 1000)] as [number, number, number]),
          getColor: [192, 132, 252, 200],
          getWidth: 2,
          widthUnits: 'pixels',
          pickable: false,
          opacity: 1,
        }))
      }
    }

    return { layers: nextLayers, buildMs: performance.now() - buildStarted }
  }, [
    layers.Space.visibility,
    backgroundSpaceAssets,
    prioritySpaceAssets,
    selectedSpaceAsset,
    selectedDomain,
    selectedTrackHistory,
    selectedOrbitPoints,
    showTrails,
    spaceTrails,
    spaceTrackDuration,
    useSpaceAltitude,
    domainOpacity,
    getAlpha,
    selectAsset,
    declutterMode,
    searchMatchSet,
  ])

  const disruptionLayerBuild = useMemo(() => {
    const buildStarted = performance.now()
    const nextLayers: Layer<object>[] = []

    if (disruptionFeatures.length > 0) {
      nextLayers.push(new GeoJsonLayer({
        id: 'disruption-footprints',
        data: disruptionFeatures,
        pickable: true,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 1.5,
        getLineColor: (feature: any) => {
          const event = feature.properties as DisruptionEvent
          if (event.category === 'conflict') return [251, 113, 133, 220]
          if (event.source_domain === 'GPS') return [248, 113, 113, 220]
          return [245, 158, 11, 220]
        },
        getFillColor: (feature: any) => {
          const event = feature.properties as DisruptionEvent
          const alpha = Math.max(30, Math.min(170, Math.round((event.severity ?? 25) * 1.4)))
          if (event.category === 'conflict') return [190, 24, 93, alpha]
          if (event.source_domain === 'GPS') return [239, 68, 68, alpha]
          return [245, 158, 11, alpha]
        },
        opacity: 0.65,
        onHover: ({ x, y, object }) => {
          const event = object?.properties as DisruptionEvent | undefined
          setHoverInfo(event ? { x, y, object: { kind: 'disruption', item: event } } : null)
        },
        onClick: ({ object }) => {
          const event = object?.properties as DisruptionEvent | undefined
          if (event?.track_id) selectAsset(event.track_id, event.source_domain)
        },
      }))
    }

    if (disruptionCentroids.length > 0) {
      nextLayers.push(new ScatterplotLayer({
        id: 'disruption-centroids',
        data: disruptionCentroids,
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        getRadius: (d: DisruptionEvent & { lon: number; lat: number }) => 40000 + ((d.severity ?? 10) * 2200),
        radiusUnits: 'meters',
        stroked: true,
        filled: true,
        lineWidthMinPixels: 1.5,
        getLineColor: (d: DisruptionEvent) => d.category === 'conflict'
          ? [251, 113, 133, 235]
          : d.source_domain === 'GPS'
            ? [248, 113, 113, 235]
            : [245, 158, 11, 235],
        getFillColor: (d: DisruptionEvent) => d.category === 'conflict'
          ? [244, 63, 94, 80]
          : d.source_domain === 'GPS'
            ? [239, 68, 68, 70]
            : [245, 158, 11, 70],
        pickable: true,
        opacity: 0.95,
        onHover: ({ x, y, object }) => {
          const event = object as DisruptionEvent | undefined
          setHoverInfo(event ? { x, y, object: { kind: 'disruption', item: event } } : null)
        },
        onClick: ({ object }) => {
          const event = object as DisruptionEvent | undefined
          if (event?.track_id) selectAsset(event.track_id, event.source_domain)
        },
      }))

      nextLayers.push(new TextLayer({
        id: 'disruption-labels',
        data: disruptionCentroids.filter((event) => (event.severity ?? 0) >= 10),
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        getText: (d: DisruptionEvent) => {
          if (d.category === 'conflict') return '✹'
          if (d.source_domain === 'GPS') return '📡'
          return '⚠'
        },
        getColor: (d: DisruptionEvent) => d.category === 'conflict'
          ? [255, 241, 242, 255]
          : d.source_domain === 'GPS'
            ? [254, 226, 226, 255]
            : [255, 251, 235, 255],
        getSize: 16,
        sizeUnits: 'pixels',
        characterSet: 'auto',
        fontFamily: '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", "DejaVu Sans", Arial, sans-serif',
        fontSettings: { sdf: true, fontSize: 64 },
        pickable: false,
      }))
    }

    return { layers: nextLayers, buildMs: performance.now() - buildStarted }
  }, [disruptionFeatures, disruptionCentroids, selectAsset])

  const deckLayers = useMemo(() => (
    [
      ...staticLayerBuild.layers,
      ...maritimeLayerBuild.layers,
      ...airLayerBuild.layers,
      ...spaceLayerBuild.layers,
      ...disruptionLayerBuild.layers,
    ]
  ), [staticLayerBuild.layers, maritimeLayerBuild.layers, airLayerBuild.layers, spaceLayerBuild.layers, disruptionLayerBuild.layers])

  const deckStats = useMemo(() => ({
    visibleAssets: viewportAssets.length,
    visibleDisruptions: visibleDisruptions.length,
    layerCount: deckLayers.length,
    deckBuildMs: staticLayerBuild.buildMs + maritimeLayerBuild.buildMs + airLayerBuild.buildMs + spaceLayerBuild.buildMs + disruptionLayerBuild.buildMs,
    airCount: airViewportAssets.length,
    maritimeCount: maritimeViewportAssets.length,
    spacePriorityCount: spacePriorityKeys.size,
    spaceAggregateCount: 0,
    spaceBackgroundCount: backgroundSpaceAssets.length,
  }), [
    viewportAssets.length,
    visibleDisruptions.length,
    deckLayers.length,
    staticLayerBuild.buildMs,
    maritimeLayerBuild.buildMs,
    airLayerBuild.buildMs,
    spaceLayerBuild.buildMs,
    disruptionLayerBuild.buildMs,
    airViewportAssets.length,
    maritimeViewportAssets.length,
    spacePriorityKeys.size,
    backgroundSpaceAssets.length,
  ])

  useEffect(() => {
    usePerfStore.getState().recordMap(deckStats)
  }, [deckStats])

  useEffect(() => {
    function handleWindowError(event: ErrorEvent) {
      const message = String(event.message ?? '')
      if (!message.includes('maxTextureDimension2D')) return
      event.preventDefault()
      if (resizeFaultSeenRef.current) return
      resizeFaultSeenRef.current = true
      console.warn('[SENTINEL] DeckGL WebGL resize fault detected')
      setHoverInfo(null)
      setRenderWarning('Map renderer hit a WebGL resize fault. Recovering overlays.')
    }

    window.addEventListener('error', handleWindowError)
    return () => window.removeEventListener('error', handleWindowError)
  }, [])

  useEffect(() => {
    if (!renderWarning) return
    const id = window.setTimeout(() => setRenderWarning(null), 4000)
    return () => window.clearTimeout(id)
  }, [renderWarning])

  const deckCursor = hoverInfo?.object.kind === 'landingPoint'
    ? 'pointer'
    : 'grab'

  const scaleBar = useMemo(() => {
    const metersPerPixel = 156543.03392 * Math.cos((localViewport.latitude * Math.PI) / 180) / (2 ** localViewport.zoom)
    const idealMeters = Math.max(1, metersPerPixel * 120)
    const distanceMeters = niceDistance(idealMeters)
    const widthPx = distanceMeters / metersPerPixel
    return {
      label: formatScaleDistance(distanceMeters),
      widthPx: Math.max(36, Math.min(160, widthPx)),
    }
  }, [localViewport.latitude, localViewport.zoom])

  const zoomContext = useMemo(() => {
    if (localViewport.zoom < 2.5) return 'Global view'
    if (localViewport.zoom < LANDING_POINT_INTERACTIVE_ZOOM) {
      return showUnderseaCables ? `Regional view · zoom to ${LANDING_POINT_INTERACTIVE_ZOOM}+ for landing points` : 'Regional view'
    }
    if (localViewport.zoom < 7) {
      return showUnderseaCables ? 'Infrastructure selection enabled' : 'Operational view'
    }
    return 'Local detail view'
  }, [showUnderseaCables, localViewport.zoom])

  const compassVisible = globeView || Math.abs(localViewport.bearing) > 0.5 || Math.abs(localViewport.pitch) > 0.5

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full"
      style={{
        cursor: deckCursor,
        background: !globeView && mapMode !== 'full' && mapMode !== 'simple'
          ? 'radial-gradient(circle at top, rgba(30,41,59,0.92), rgba(2,6,23,1) 72%)'
          : undefined,
      }}
    >
      {active && !rendererDisabled && deckRendererReady ? (
        <DeckGL
          width={effectiveContainerSize.width}
          height={effectiveContainerSize.height}
          views={globeView ? new GlobeView({ id: 'globe' }) : undefined}
          viewState={viewState}
          useDevicePixels={1}
          onViewStateChange={({ viewState: vs, interactionState }) => {
            const nextViewport = vs as unknown as typeof viewport
            setLocalViewport(nextViewport)

            const interacting = Boolean(
              interactionState?.isDragging ||
              interactionState?.isZooming ||
              interactionState?.isPanning ||
              interactionState?.isRotating,
            )
            interactionActiveRef.current = interacting
            if (!interacting) {
              setViewport(nextViewport)
            }
          }}
          getCursor={({ isDragging }) => (isDragging ? 'grabbing' : deckCursor)}
          controller={true}
          layers={deckLayers}
          onError={(error) => {
            const message = String(error?.message ?? error ?? '')
            if (message.includes('cocom-fills') || message.includes(COCOM_GEOJSON_URL)) {
              console.error('[SENTINEL] COCOM overlay failed to load', error)
              setCocomFailed(true)
              setRenderWarning('COCOM boundary layer failed to load. Base map and other overlays remain active.')
              return
            }
            if (faultHandledRef.current) return
            faultHandledRef.current = true
            console.error('[SENTINEL] DeckGL render error, disabling renderer', error)
            setHoverInfo(null)
            setRendererDisabled(true)
            setRenderWarning('Map renderer disabled after WebGL fault. Reload to restore overlays.')
          }}
          onClick={(info) => {
            if (!info.object) {
              clearLandingPointSelection()
            }
            if (!info.object && onMapClick) {
              const [lon, lat] = info.coordinate as [number, number]
              onMapClick(lon, lat)
            }
          }}
          getTooltip={() => null}
        >
          {/* MapLibre is only active in flat map modes — GlobeView uses TileLayer instead */}
          {!globeView && mapMode !== 'outline' && mapMode !== 'none' && (
            <MapLibreMap
              cursor={deckCursor}
              mapStyle={mapMode === 'simple' ? SIMPLE_MAP_STYLE : MAP_STYLE}
              onLoad={(evt) => {
                // Suppress "Image X could not be loaded" warnings for missing sprite
                // images in the base map style (e.g. road-shield icons).
                evt.target.on('styleimagemissing', (e: { id: string }) => {
                  if (!evt.target.hasImage(e.id)) {
                    evt.target.addImage(e.id, {
                      width: 1, height: 1,
                      data: new Uint8Array(4), // 1 RGBA pixel, transparent
                    })
                  }
                })
              }}
            />
          )}
        </DeckGL>
      ) : (
        <div className="absolute inset-0">
          {mapMode !== 'outline' && mapMode !== 'none' && (
            <MapLibreMap
              style={{ width: '100%', height: '100%' }}
              mapStyle={mapMode === 'simple' ? SIMPLE_MAP_STYLE : MAP_STYLE}
            />
          )}
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          right: 16,
          bottom: 16,
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
          pointerEvents: 'auto',
        }}
      >
        <div style={mapChromeOverlayStyle}>
          <div style={zoomReadoutStyle}>Zoom {localViewport.zoom.toFixed(1)}</div>
          <div style={zoomContextStyle}>{zoomContext}</div>
          <div style={zoomButtonsRowStyle}>
            <button
              type="button"
              style={mapButtonStyle}
              onClick={() => {
                const next = { ...localViewport, zoom: clampZoom(localViewport.zoom + 0.8) }
                setLocalViewport(next)
                setViewport(next)
              }}
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              style={mapButtonStyle}
              onClick={() => {
                const next = { ...localViewport, zoom: clampZoom(localViewport.zoom - 0.8) }
                setLocalViewport(next)
                setViewport(next)
              }}
              aria-label="Zoom out"
            >
              -
            </button>
          </div>
        </div>
        {showUnderseaCables && (
          <div style={thresholdBadgeStyle(localViewport.zoom >= LANDING_POINT_INTERACTIVE_ZOOM)}>
            {localViewport.zoom >= LANDING_POINT_INTERACTIVE_ZOOM
              ? 'Landing points selectable'
              : `Zoom to ${LANDING_POINT_INTERACTIVE_ZOOM}+ to select landing points`}
          </div>
        )}
        {showUnderseaCables && (
          <button
            type="button"
            style={mapActionStyle}
            onClick={() => {
              setLocalViewport(UNDERSEA_NETWORK_FOCUS_VIEW)
              setViewport(UNDERSEA_NETWORK_FOCUS_VIEW)
            }}
          >
            Focus undersea network
          </button>
        )}
        <div style={scaleBarOverlayStyle}>
          <div style={scaleBarLabelStyle}>{scaleBar.label}</div>
          <div style={{ ...scaleBarLineStyle, width: `${scaleBar.widthPx}px` }} />
        </div>
        {compassVisible && (
          <button
            type="button"
            style={compassStyle}
            onClick={() => {
              const next = { ...localViewport, bearing: 0, pitch: 0 }
              setLocalViewport(next)
              setViewport(next)
            }}
            title="Reset map bearing and pitch"
          >
            <span
              style={{
                ...compassNeedleStyle,
                transform: `rotate(${-localViewport.bearing}deg)`,
              }}
            >
              ↑
            </span>
            <span style={compassLabelStyle}>N</span>
          </button>
        )}
      </div>
      {hoverInfo && (
        <div
          className="pointer-events-none absolute z-10 rounded bg-slate-900/90 px-2 py-1 text-xs text-white"
          style={{ left: hoverInfo.x + 8, top: hoverInfo.y + 8 }}
        >
          {hoverInfo.object.kind === 'track'
            ? (hoverInfo.object.item.callsign ?? hoverInfo.object.item.track_id)
            : hoverInfo.object.kind === 'disruption'
              ? (hoverInfo.object.item.title ?? hoverInfo.object.item.external_event_id)
              : (hoverInfo.object.item.name ?? hoverInfo.object.item.id ?? 'Unnamed feature')}
        </div>
      )}
      {renderWarning && (
        <div
          className="absolute left-4 top-4 z-10 rounded border px-3 py-2 text-xs"
          style={{
            borderColor: 'rgba(251, 191, 36, 0.45)',
            background: 'rgba(120, 53, 15, 0.88)',
            color: '#fef3c7',
            boxShadow: '0 8px 24px rgba(0,0,0,0.24)',
          }}
        >
          {renderWarning}
        </div>
      )}
    </div>
  )
}

const mapChromeOverlayStyle: React.CSSProperties = {
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 6,
  padding: '6px 8px',
  borderRadius: 10,
  background: 'rgba(15,23,42,0.46)',
  backdropFilter: 'blur(8px)',
}

const zoomReadoutStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 14,
  fontWeight: 700,
  color: '#f8fafc',
}

const zoomContextStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  color: '#cbd5e1',
}

const zoomButtonsRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
}

const mapButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  border: '1px solid rgba(148,163,184,0.22)',
  background: 'rgba(15,23,42,0.72)',
  color: '#f8fafc',
  fontSize: 18,
  lineHeight: 1,
  cursor: 'pointer',
}

const mapActionStyle: React.CSSProperties = {
  width: 'fit-content',
  padding: '8px 10px',
  borderRadius: 10,
  border: '1px solid rgba(148,163,184,0.18)',
  background: 'rgba(15,23,42,0.62)',
  color: '#e2e8f0',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  backdropFilter: 'blur(8px)',
}

const thresholdBadgeStyle = (active: boolean): React.CSSProperties => ({
  padding: '7px 9px',
  borderRadius: 10,
  border: active
    ? '1px solid rgba(34,197,94,0.28)'
    : '1px solid rgba(245,158,11,0.24)',
  background: active
    ? 'rgba(21,128,61,0.18)'
    : 'rgba(120,53,15,0.35)',
  color: active ? '#bbf7d0' : '#fde68a',
  fontSize: 11,
  lineHeight: 1.35,
  backgroundClip: 'padding-box',
  backdropFilter: 'blur(8px)',
})

const compassStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  width: 'fit-content',
  padding: '8px 10px',
  borderRadius: 10,
  border: '1px solid rgba(148,163,184,0.18)',
  background: 'rgba(15,23,42,0.62)',
  color: '#f8fafc',
  cursor: 'pointer',
  backdropFilter: 'blur(8px)',
}

const compassNeedleStyle: React.CSSProperties = {
  display: 'inline-flex',
  width: 22,
  height: 22,
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 18,
  color: '#f87171',
}

const compassLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.12em',
  color: '#cbd5e1',
}

const scaleBarOverlayStyle: React.CSSProperties = {
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  padding: '4px 6px',
  borderRadius: 8,
  background: 'rgba(15,23,42,0.38)',
  backdropFilter: 'blur(6px)',
}

const scaleBarLabelStyle: React.CSSProperties = {
  marginBottom: 2,
  fontSize: 10,
  fontWeight: 600,
  color: '#e2e8f0',
}

const scaleBarLineStyle: React.CSSProperties = {
  height: 8,
  borderLeft: '2px solid #f8fafc',
  borderRight: '2px solid #f8fafc',
  borderBottom: '2px solid #f8fafc',
}

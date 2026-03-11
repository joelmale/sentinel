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
import { _GlobeView as GlobeView } from '@deck.gl/core'
import { ScatterplotLayer, PathLayer, TextLayer, GeoJsonLayer, BitmapLayer } from '@deck.gl/layers'
import { TileLayer } from '@deck.gl/geo-layers'
import type { MapViewState, Layer } from '@deck.gl/core'
import Map from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'

import { useMapStore } from '@/store/useMapStore'
import { COCOM_GEOJSON_URL, COCOM_LABELS, getCocomColors } from '@/data/cocom'
import type { DisruptionEvent, TrackEventProperties } from '@/types/track'
import { getAirlineGroup, getConstellation, getMmsiCountry, normalizeObjectType, normalizeOrbitClass } from '@/data/grouping'

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
        'raster-saturation': -1,
        'raster-contrast': 0.15,
        'raster-brightness-min': 0.25,
        'raster-brightness-max': 0.95,
        'raster-opacity': 0.75,
      },
    },
  ],
}

// OSM tiles used when globe view is active (deck.gl TileLayer, not MapLibre)
const GLOBE_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

interface MapCanvasProps {
  liveAssets: TrackEventProperties[]
  disruptions: DisruptionEvent[]
  onMapClick?: (lon: number, lat: number) => void
}

type HoverObject =
  | { kind: 'track'; item: TrackEventProperties }
  | { kind: 'disruption'; item: DisruptionEvent }

export function MapCanvas({ liveAssets, disruptions, onMapClick }: MapCanvasProps) {
  const {
    viewport,
    setViewport,
    layers,
    simpleMap,
    showTrails,
    showCocom,
    globeView,
    classFilter,
    hiddenGroupFilters,
    workspaceSearch,
    declutterMode,
    selectAsset,
    trailBuffer,
    selectedTrackId,
    selectedDomain,
    selectedTrackHistory,
    selectedOrbitPoints,
  } = useMapStore()
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; object: HoverObject } | null>(null)
  const [renderWarning, setRenderWarning] = useState<string | null>(null)
  const [rendererDisabled, setRendererDisabled] = useState(false)
  const faultHandledRef = useRef(false)
  const resizeFaultSeenRef = useRef(false)

  const viewState: MapViewState = {
    longitude: viewport.longitude,
    latitude:  viewport.latitude,
    zoom:      viewport.zoom,
    bearing:   viewport.bearing,
    pitch:     viewport.pitch,
  }

  // Filter assets: hidden layers and filtered classifications are excluded entirely.
  // Muted layers pass through (rendered dimmed). Think of hidden=off, muted=context.
  const visibleAssets = useMemo(() => {
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
        const constellation = getConstellation(asset.callsign)
        keys.push(
          `Space:${objectType}`,
          `Space:${objectType}:${orbitClass}`,
          `Space:${objectType}:${orbitClass}:${constellation}`,
        )
      }

      return keys.some((key) => hidden.includes(key))
    }

    return liveAssets.filter((a) => {
      const layerState = layers[a.source_domain as keyof typeof layers]
      if (layerState?.visibility === 'hidden') return false
      // Classification filter — hide assets whose classification is in the "hidden" list
      const hidden = classFilter[a.source_domain] ?? []
      if (hidden.length > 0 && a.classification && hidden.includes(a.classification)) return false
      if (isHiddenByGroup(a)) return false
      return true
    })
  }, [liveAssets, layers, classFilter, hiddenGroupFilters])

  const visibleDisruptions = useMemo(() => (
    disruptions.filter((event) => layers[event.source_domain]?.visibility !== 'hidden')
  ), [disruptions, layers])

  // Workspace search match set — drives declutter opacity on map.
  // Like a spotlight: when declutter mode is on, non-matching tracks dim to ~10%.
  const searchMatchSet = useMemo<Set<string> | null>(() => {
    const q = workspaceSearch.trim().toLowerCase()
    if (!q) return null
    const set = new Set<string>()
    for (const a of visibleAssets) {
      if (
        a.track_id.toLowerCase().includes(q) ||
        (a.callsign ?? '').toLowerCase().includes(q) ||
        (a.classification ?? '').toLowerCase().includes(q)
      ) {
        set.add(`${a.source_domain}:${a.track_id}`)
      }
    }
    return set
  }, [visibleAssets, workspaceSearch])

  // Per-asset alpha helper: applies search-based declutter dimming
  const getAlpha = useCallback((d: TrackEventProperties, baseAlpha = 255): number => {
    if (declutterMode && searchMatchSet !== null) {
      return searchMatchSet.has(`${d.source_domain}:${d.track_id}`) ? baseAlpha : 25
    }
    return baseAlpha
  }, [declutterMode, searchMatchSet])

  // Per-domain effective opacity: muted domains render at 25% of their base opacity
  const domainOpacity = useCallback((domain: string): number => {
    const ls = layers[domain as keyof typeof layers]
    if (!ls) return 1
    return ls.visibility === 'muted' ? ls.opacity * 0.25 : ls.opacity
  }, [layers])

  const deckLayers = useMemo(() => {
    const ls: Layer<object>[] = []

    // ── Globe base tiles (replaces MapLibre when globeView is active) ────────
    if (globeView) {
      ls.push(new TileLayer({
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

    // ── COCOM boundaries ────────────────────────────────────────
    if (showCocom) {
      // Real geographic boundaries loaded at runtime from jonahadkins/Combatant-Commands
      // The browser fetches this URL directly — bypasses server-side egress restrictions.
      ls.push(new GeoJsonLayer({
        id: 'cocom-fills',
        data: COCOM_GEOJSON_URL,
        stroked: true,
        filled: true,
        pickable: false,
        getFillColor: (f: any) => getCocomColors(f.properties).fill,
        getLineColor: (f: any) => getCocomColors(f.properties).line,
        lineWidthMinPixels: 1.5,
        lineWidthMaxPixels: 3,
        opacity: 1,
      }))

      // Command labels centred inside each AOR
      ls.push(new TextLayer({
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

    // ── Maritime: live positions ─────────────────────────────────
    if (layers.Maritime.visibility !== 'hidden') {
      const selectedMaritimeAsset = visibleAssets.find(
        (a) =>
          a.source_domain === 'Maritime' &&
          a.track_id === selectedTrackId &&
          selectedDomain === 'Maritime' &&
          typeof a.lon === 'number' &&
          typeof a.lat === 'number',
      )

      ls.push(new TextLayer<TrackEventProperties>({
        id: 'ais-live-icons',
        data: visibleAssets.filter(
          (a) => a.source_domain === 'Maritime' && typeof a.lon === 'number' && typeof a.lat === 'number',
        ),
        getPosition: (d) => [d.lon ?? 0, d.lat ?? 0],
        getText: () => '⚓',
        // Black anchors — high contrast; alpha dims when declutter search is active
        getColor: (d: TrackEventProperties) => [10, 10, 10, getAlpha(d)],
        updateTriggers: { getColor: [declutterMode, searchMatchSet] },
        getSize: 18,
        sizeUnits: 'pixels',
        pickable: true,
        opacity: domainOpacity('Maritime'),
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        characterSet: 'auto',
        fontFamily: '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", "DejaVu Sans", Arial, sans-serif',
        fontSettings: { sdf: true, fontSize: 64 },
        onHover: ({ x, y, object }: { x: number; y: number; object?: TrackEventProperties }) =>
          setHoverInfo(object ? { x, y, object: { kind: 'track', item: object } } : null),
        onClick: ({ object }) =>
          object && selectAsset(object.track_id, object.source_domain),
      }))

      if (selectedMaritimeAsset) {
        ls.push(new ScatterplotLayer<TrackEventProperties>({
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
        ls.push(new PathLayer({
          id: 'maritime-selected-history',
          data: [{ positions: selectedTrackHistory }],
          getPath: (d: { positions: Array<{ lon: number; lat: number; timestamp: number }> }) =>
            d.positions.map(p => [p.lon, p.lat] as [number, number]),
          getColor: [34, 211, 238, 220],
          getWidth: 3,
          widthUnits: 'pixels',
          pickable: false,
          opacity: 1,
        }))
      }

      // ── Maritime trails ────────────────────────────────────────
      if (showTrails) {
        ls.push(new PathLayer({
          id: 'maritime-trails',
          data: Array.from(trailBuffer.entries())
            .filter(([key]) => key.startsWith('Maritime:'))
            .map(([key, positions]) => ({ key, positions }))
            .filter(d => d.positions.length >= 2),
          getPath: (d: { positions: Array<{ lon: number; lat: number; timestamp: number }> }) =>
            d.positions.map(p => [p.lon, p.lat] as [number, number]),
          getColor: [80, 80, 80, 100],
          getWidth: 1.5,
          widthUnits: 'pixels',
          pickable: false,
          opacity: domainOpacity('Maritime'),
        }))
      }
    }

    // ── Air: live positions ──────────────────────────────────────
    if (layers.Air.visibility !== 'hidden') {
      const selectedAirAsset = visibleAssets.find(
        (a) =>
          a.source_domain === 'Air' &&
          a.track_id === selectedTrackId &&
          selectedDomain === 'Air' &&
          typeof a.lon === 'number' &&
          typeof a.lat === 'number',
      )

      ls.push(new TextLayer<TrackEventProperties>({
        id: 'adsb-live-icons',
        data: visibleAssets.filter(
          (a) => a.source_domain === 'Air' && typeof a.lon === 'number' && typeof a.lat === 'number',
        ),
        getPosition: (d) => [d.lon ?? 0, d.lat ?? 0],
        getText: () => '✈',
        getColor: (d: TrackEventProperties) => {
          const base = CLASSIFICATION_COLORS[d.classification ?? 'Unknown']
          return [base[0], base[1], base[2], getAlpha(d)] as [number, number, number, number]
        },
        updateTriggers: { getColor: [declutterMode, searchMatchSet] },
        getSize: 18,
        getAngle: (d) => d.heading_deg ?? 0,
        sizeUnits: 'pixels',
        pickable: true,
        opacity: domainOpacity('Air'),
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        // deck.gl builds a GPU glyph atlas from a limited ASCII set by default.
        // 'auto' rescans the data each update and bakes whatever characters appear.
        characterSet: 'auto',
        fontFamily: '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", "DejaVu Sans", Arial, sans-serif',
        fontSettings: { sdf: true, fontSize: 64 },
        onHover: ({ x, y, object }: { x: number; y: number; object?: TrackEventProperties }) =>
          setHoverInfo(object ? { x, y, object: { kind: 'track', item: object } } : null),
        onClick: ({ object }) =>
          object && selectAsset(object.track_id, object.source_domain),
      }))

      if (selectedAirAsset) {
        ls.push(new ScatterplotLayer<TrackEventProperties>({
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
        ls.push(new PathLayer({
          id: 'air-selected-history',
          data: [{ positions: selectedTrackHistory }],
          getPath: (d: { positions: Array<{ lon: number; lat: number; timestamp: number }> }) =>
            d.positions.map(p => [p.lon, p.lat] as [number, number]),
          getColor: [56, 189, 248, 220],
          getWidth: 3,
          widthUnits: 'pixels',
          pickable: false,
          opacity: 1,
        }))
      }

      // ── Air trails ──────────────────────────────────────────
      if (showTrails) {
        ls.push(new PathLayer({
          id: 'air-trails',
          data: Array.from(trailBuffer.entries())
            .filter(([key]) => key.startsWith('Air:'))
            .map(([key, positions]) => ({ key, positions }))
            .filter(d => d.positions.length >= 2),
          getPath: (d: { positions: Array<{ lon: number; lat: number; timestamp: number }> }) =>
            d.positions.map(p => [p.lon, p.lat] as [number, number]),
          getColor: [100, 181, 246, 120],
          getWidth: 1.5,
          widthUnits: 'pixels',
          pickable: false,
          opacity: domainOpacity('Air'),
        }))
      }
    }

    // ── Space / Satellites: live positions ───────────────────────
    if (layers.Space.visibility !== 'hidden') {
      const selectedSpaceAsset = visibleAssets.find(
        (a) =>
          a.source_domain === 'Space' &&
          a.track_id === selectedTrackId &&
          selectedDomain === 'Space' &&
          typeof a.lon === 'number' &&
          typeof a.lat === 'number',
      )

      ls.push(new TextLayer<TrackEventProperties>({
        id: 'space-live-icons',
        data: visibleAssets.filter(
          (a) => a.source_domain === 'Space' && typeof a.lon === 'number' && typeof a.lat === 'number',
        ),
        getPosition: (d) => [d.lon ?? 0, d.lat ?? 0],
        getText: () => '🛰',
        getColor: (d: TrackEventProperties) => {
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
        onHover: ({ x, y, object }: { x: number; y: number; object?: TrackEventProperties }) =>
          setHoverInfo(object ? { x, y, object: { kind: 'track', item: object } } : null),
        onClick: ({ object }) =>
          object && selectAsset(object.track_id, object.source_domain),
      }))

      if (selectedSpaceAsset) {
        ls.push(new ScatterplotLayer<TrackEventProperties>({
          id: 'space-selected-ring',
          data: [selectedSpaceAsset],
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

      // Orbital track — predicted path for the selected satellite.
      // In globe mode paths curve correctly along Earth's surface;
      // in flat mode they may appear broken near the antimeridian.
      if (selectedDomain === 'Space' && selectedOrbitPoints.length >= 2) {
        ls.push(new PathLayer({
          id: 'space-orbital-track',
          data: [{ positions: selectedOrbitPoints }],
          getPath: (d: { positions: typeof selectedOrbitPoints }) =>
            d.positions.map(p => [p.lon, p.lat] as [number, number]),
          getColor: [192, 132, 252, 200], // purple-400
          getWidth: 2,
          widthUnits: 'pixels',
          pickable: false,
          opacity: 1,
        }))
      }
    }

    // ── Disruption overlays (GPS/Infra normalized events) ─────────────────
    const disruptionFeatures = visibleDisruptions
      .filter((event) => event.geometry)
      .map((event) => ({
        type: 'Feature' as const,
        geometry: event.geometry!,
        properties: event,
      }))

    const disruptionCentroids = visibleDisruptions
      .filter((event) => event.centroid?.coordinates)
      .map((event) => ({
        ...event,
        lon: event.centroid!.coordinates[0],
        lat: event.centroid!.coordinates[1],
      }))

    if (disruptionFeatures.length > 0) {
      ls.push(new GeoJsonLayer({
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
          if (event?.track_id) {
            selectAsset(event.track_id, event.source_domain)
          }
        },
      }))
    }

    if (disruptionCentroids.length > 0) {
      ls.push(new ScatterplotLayer({
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
          if (event?.track_id) {
            selectAsset(event.track_id, event.source_domain)
          }
        },
      }))

      ls.push(new TextLayer({
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

    return ls
  }, [
    visibleAssets,
    visibleDisruptions,
    layers,
    domainOpacity,
    getAlpha,
    selectAsset,
    trailBuffer,
    selectedTrackId,
    selectedDomain,
    selectedTrackHistory,
    selectedOrbitPoints,
    showTrails,
    showCocom,
    globeView,
    declutterMode,
    searchMatchSet,
  ])

  useEffect(() => {
    function handleWindowError(event: ErrorEvent) {
      const message = String(event.message ?? '')
      if (!message.includes('maxTextureDimension2D')) return
      event.preventDefault()
      if (resizeFaultSeenRef.current) return
      resizeFaultSeenRef.current = true
      console.warn('[SENTINEL] DeckGL WebGL resize fault detected')
      setRenderWarning('Map renderer hit a WebGL resize fault. Overlay recovery is limited until reload.')
    }

    window.addEventListener('error', handleWindowError)
    return () => window.removeEventListener('error', handleWindowError)
  }, [])

  useEffect(() => {
    if (!renderWarning) return
    const id = window.setTimeout(() => setRenderWarning(null), 4000)
    return () => window.clearTimeout(id)
  }, [renderWarning])

  return (
    <div className="relative w-full h-full">
      {!rendererDisabled ? (
        <DeckGL
          views={globeView ? new GlobeView({ id: 'globe' }) : undefined}
          viewState={viewState}
          useDevicePixels={1}
          onViewStateChange={({ viewState: vs }) =>
            setViewport(vs as unknown as typeof viewport)
          }
          controller={true}
          layers={deckLayers}
          onError={(error) => {
            if (faultHandledRef.current) return
            faultHandledRef.current = true
            console.error('[SENTINEL] DeckGL render error, disabling renderer', error)
            setHoverInfo(null)
            setRendererDisabled(true)
            setRenderWarning('Map renderer disabled after WebGL fault. Reload to restore overlays.')
          }}
          onClick={(info) => {
            if (!info.object && onMapClick) {
              const [lon, lat] = info.coordinate as [number, number]
              onMapClick(lon, lat)
            }
          }}
          getTooltip={() => null}
        >
          {/* MapLibre is only active in flat map modes — GlobeView uses TileLayer instead */}
          {!globeView && (
            <Map
              mapStyle={simpleMap ? SIMPLE_MAP_STYLE : MAP_STYLE}
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
          <Map
            style={{ width: '100%', height: '100%' }}
            mapStyle={simpleMap ? SIMPLE_MAP_STYLE : MAP_STYLE}
          />
        </div>
      )}
      {hoverInfo && (
        <div
          className="pointer-events-none absolute z-10 rounded bg-slate-900/90 px-2 py-1 text-xs text-white"
          style={{ left: hoverInfo.x + 8, top: hoverInfo.y + 8 }}
        >
          {hoverInfo.object.kind === 'track'
            ? (hoverInfo.object.item.callsign ?? hoverInfo.object.item.track_id)
            : (hoverInfo.object.item.title ?? hoverInfo.object.item.external_event_id)}
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

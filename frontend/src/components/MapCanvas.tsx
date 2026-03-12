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
import { UNDERSEA_CABLES_GEOJSON_URL, UNDERSEA_CABLE_LANDING_POINTS_GEOJSON_URL } from '@/data/underseaCables'
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
const LANDING_POINT_INTERACTIVE_ZOOM = 4
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
}

type HoverObject =
  | { kind: 'track'; item: TrackEventProperties }
  | { kind: 'disruption'; item: DisruptionEvent }
  | { kind: 'underseaCable'; item: { name?: string; id?: string } }
  | { kind: 'landingPoint'; item: { name?: string; id?: string; lon?: number; lat?: number } }

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

export function MapCanvas({ liveAssets, disruptions, onMapClick }: MapCanvasProps) {
  const {
    viewport,
    setViewport,
    layers,
    simpleMap,
    showTrails,
    showCocom,
    showUnderseaCables,
    globeView,
    classFilter,
    hiddenGroupFilters,
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
  } = useMapStore()
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; object: HoverObject } | null>(null)
  const [renderWarning, setRenderWarning] = useState<string | null>(null)
  const [rendererDisabled, setRendererDisabled] = useState(false)
  const [cocomFailed, setCocomFailed] = useState(false)
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
    if (showCocom && !cocomFailed) {
      // Local generalized-theater polygons. These are intentionally approximate
      // ocean-spanning AOR shapes, not official legal boundary GIS.
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

    // ── Undersea cables ─────────────────────────────────────────
    if (showUnderseaCables) {
      const landingPointRadius = Math.min(10, Math.max(3, viewport.zoom * 0.9))
      const landingPointPickRadius = Math.min(22, Math.max(10, landingPointRadius + 8))
      const landingPointsInteractive = viewport.zoom >= LANDING_POINT_INTERACTIVE_ZOOM

      ls.push(new GeoJsonLayer({
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

      ls.push(new GeoJsonLayer({
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

      ls.push(new GeoJsonLayer({
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
        ls.push(new ScatterplotLayer({
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

      if (hoverInfo?.object.kind === 'landingPoint' && typeof hoverInfo.object.item.lon === 'number' && typeof hoverInfo.object.item.lat === 'number') {
        ls.push(new ScatterplotLayer({
          id: 'undersea-cable-landing-point-hover',
          data: [hoverInfo.object.item],
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
    selectLandingPoint,
    trailBuffer,
    selectedTrackId,
    selectedDomain,
    selectedLandingPoint,
    selectedTrackHistory,
    selectedOrbitPoints,
    hoverInfo,
    showTrails,
    showCocom,
    showUnderseaCables,
    cocomFailed,
    globeView,
    declutterMode,
    searchMatchSet,
    viewport.zoom,
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

  const deckCursor = hoverInfo?.object.kind === 'landingPoint'
    ? 'pointer'
    : 'grab'

  const scaleBar = useMemo(() => {
    const metersPerPixel = 156543.03392 * Math.cos((viewport.latitude * Math.PI) / 180) / (2 ** viewport.zoom)
    const idealMeters = Math.max(1, metersPerPixel * 120)
    const distanceMeters = niceDistance(idealMeters)
    const widthPx = distanceMeters / metersPerPixel
    return {
      label: formatScaleDistance(distanceMeters),
      widthPx: Math.max(36, Math.min(160, widthPx)),
    }
  }, [viewport.latitude, viewport.zoom])

  const zoomContext = useMemo(() => {
    if (viewport.zoom < 2.5) return 'Global view'
    if (viewport.zoom < LANDING_POINT_INTERACTIVE_ZOOM) {
      return showUnderseaCables ? `Regional view · zoom to ${LANDING_POINT_INTERACTIVE_ZOOM}+ for landing points` : 'Regional view'
    }
    if (viewport.zoom < 7) {
      return showUnderseaCables ? 'Infrastructure selection enabled' : 'Operational view'
    }
    return 'Local detail view'
  }, [showUnderseaCables, viewport.zoom])

  const compassVisible = globeView || Math.abs(viewport.bearing) > 0.5 || Math.abs(viewport.pitch) > 0.5

  return (
    <div className="relative w-full h-full" style={{ cursor: deckCursor }}>
      {!rendererDisabled ? (
        <DeckGL
          views={globeView ? new GlobeView({ id: 'globe' }) : undefined}
          viewState={viewState}
          useDevicePixels={1}
          onViewStateChange={({ viewState: vs }) =>
            setViewport(vs as unknown as typeof viewport)
          }
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
          {!globeView && (
            <Map
              cursor={deckCursor}
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
          <div style={zoomReadoutStyle}>Zoom {viewport.zoom.toFixed(1)}</div>
          <div style={zoomContextStyle}>{zoomContext}</div>
          <div style={zoomButtonsRowStyle}>
            <button
              type="button"
              style={mapButtonStyle}
              onClick={() => setViewport({ zoom: clampZoom(viewport.zoom + 0.8) })}
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              style={mapButtonStyle}
              onClick={() => setViewport({ zoom: clampZoom(viewport.zoom - 0.8) })}
              aria-label="Zoom out"
            >
              -
            </button>
          </div>
        </div>
        {showUnderseaCables && (
          <div style={thresholdBadgeStyle(viewport.zoom >= LANDING_POINT_INTERACTIVE_ZOOM)}>
            {viewport.zoom >= LANDING_POINT_INTERACTIVE_ZOOM
              ? 'Landing points selectable'
              : `Zoom to ${LANDING_POINT_INTERACTIVE_ZOOM}+ to select landing points`}
          </div>
        )}
        {showUnderseaCables && (
          <button
            type="button"
            style={mapActionStyle}
            onClick={() => setViewport(UNDERSEA_NETWORK_FOCUS_VIEW)}
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
            onClick={() => setViewport({ bearing: 0, pitch: 0 })}
            title="Reset map bearing and pitch"
          >
            <span
              style={{
                ...compassNeedleStyle,
                transform: `rotate(${-viewport.bearing}deg)`,
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

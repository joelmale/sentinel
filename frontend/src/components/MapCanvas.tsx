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

import { useMemo, useState } from 'react'
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
import type { TrackEventProperties } from '@/types/track'

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
  onMapClick?: (lon: number, lat: number) => void
}

export function MapCanvas({ liveAssets, onMapClick }: MapCanvasProps) {
  const {
    viewport,
    setViewport,
    layers,
    simpleMap,
    showTrails,
    showCocom,
    globeView,
    classFilter,
    selectAsset,
    trailBuffer,
    selectedTrackId,
    selectedDomain,
    selectedTrackHistory,
    selectedOrbitPoints,
  } = useMapStore()
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; object: TrackEventProperties } | null>(null)

  const viewState: MapViewState = {
    longitude: viewport.longitude,
    latitude:  viewport.latitude,
    zoom:      viewport.zoom,
    bearing:   viewport.bearing,
    pitch:     viewport.pitch,
  }

  // Filter assets by enabled layers AND classification filter
  const visibleAssets = useMemo(() => {
    return liveAssets.filter((a) => {
      const layerState = layers[a.source_domain as keyof typeof layers]
      if (!(layerState?.enabled ?? true)) return false
      // Classification filter — hide domains where classification is in the "hidden" list
      const hidden = classFilter[a.source_domain] ?? []
      if (hidden.length > 0 && a.classification && hidden.includes(a.classification)) return false
      return true
    })
  }, [liveAssets, layers, classFilter])

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getFillColor: (f: any) => getCocomColors(f.properties).fill,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    if (layers.Maritime.enabled) {
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
        // Black anchors — high contrast on both light and dark map tiles.
        getColor: [10, 10, 10, 255],
        getSize: 18,
        sizeUnits: 'pixels',
        pickable: true,
        opacity: layers.Maritime.opacity,
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        characterSet: 'auto',
        fontFamily: '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", "DejaVu Sans", Arial, sans-serif',
        fontSettings: { sdf: true, fontSize: 64 },
        onHover: ({ x, y, object }: { x: number; y: number; object?: TrackEventProperties }) =>
          setHoverInfo(object ? { x, y, object } : null),
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
          opacity: layers.Maritime.opacity,
        }))
      }
    }

    // ── Air: live positions ──────────────────────────────────────
    if (layers.Air.enabled) {
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
        getColor: (d) => CLASSIFICATION_COLORS[d.classification ?? 'Unknown'],
        getSize: 18,
        getAngle: (d) => d.heading_deg ?? 0,
        sizeUnits: 'pixels',
        pickable: true,
        opacity: layers.Air.opacity,
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        // deck.gl builds a GPU glyph atlas from a limited ASCII set by default.
        // 'auto' rescans the data each update and bakes whatever characters appear.
        characterSet: 'auto',
        fontFamily: '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", "DejaVu Sans", Arial, sans-serif',
        fontSettings: { sdf: true, fontSize: 64 },
        onHover: ({ x, y, object }: { x: number; y: number; object?: TrackEventProperties }) =>
          setHoverInfo(object ? { x, y, object } : null),
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
          opacity: layers.Air.opacity,
        }))
      }
    }

    // ── Space / Satellites: live positions ───────────────────────
    if (layers.Space.enabled) {
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
        getColor: (d) => CLASSIFICATION_COLORS[d.classification ?? 'Unknown'],
        getSize: 18,
        sizeUnits: 'pixels',
        pickable: true,
        opacity: layers.Space.opacity,
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        characterSet: 'auto',
        fontFamily: '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", "DejaVu Sans", Arial, sans-serif',
        fontSettings: { sdf: true, fontSize: 64 },
        onHover: ({ x, y, object }: { x: number; y: number; object?: TrackEventProperties }) =>
          setHoverInfo(object ? { x, y, object } : null),
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

    return ls
  }, [
    visibleAssets,
    layers,
    classFilter,
    selectAsset,
    trailBuffer,
    selectedTrackId,
    selectedDomain,
    selectedTrackHistory,
    selectedOrbitPoints,
    simpleMap,
    showTrails,
    showCocom,
    globeView,
  ])

  return (
    <div className="relative w-full h-full">
      <DeckGL
        views={globeView ? new GlobeView({ id: 'globe' }) : undefined}
        viewState={viewState}
        onViewStateChange={({ viewState: vs }) =>
          setViewport(vs as unknown as typeof viewport)
        }
        controller={true}
        layers={deckLayers}
        onClick={(info) => {
          if (!info.object && onMapClick) {
            const [lon, lat] = info.coordinate as [number, number]
            onMapClick(lon, lat)
          }
        }}
        getTooltip={({ object }: { object?: TrackEventProperties }) =>
          object
            ? {
                html: `<div class="tooltip">
                  <strong>${object.callsign ?? object.track_id}</strong><br/>
                  ${object.source_domain} · ${object.classification ?? 'Unknown'}<br/>
                  Alt: ${object.altitude_m?.toFixed(0) ?? '—'} m
                </div>`,
                style: { background: '#1B2A3B', color: 'white', padding: '8px', borderRadius: '4px' },
              }
            : null
        }
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
      {hoverInfo && (
        <div
          className="pointer-events-none absolute z-10 rounded bg-slate-900/90 px-2 py-1 text-xs text-white"
          style={{ left: hoverInfo.x + 8, top: hoverInfo.y + 8 }}
        >
          {hoverInfo.object.callsign ?? hoverInfo.object.track_id}
        </div>
      )}
    </div>
  )
}

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
 * Layer rendering order (bottom to top):
 *   1. MapLibre base tiles (terrain, labels)
 *   2. Infra outage polygons (GeoJsonLayer)
 *   3. GPS jamming heatmap (H3HexagonLayer)
 *   4. AIS vessels (IconLayer)
 *   5. AIS trails (TripsLayer)
 *   6. Aircraft (ScatterplotLayer)
 *   7. Aircraft trails (TripsLayer)
 *   8. Satellite ground tracks (ArcLayer)
 *   9. Annotations (TextLayer + IconLayer)
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { ScatterplotLayer } from '@deck.gl/layers'
import { TripsLayer } from '@deck.gl/geo-layers'
import type { MapViewState } from '@deck.gl/core'
import Map from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'

import { useMapStore } from '@/store/useMapStore'
import type { TrackEventProperties } from '@/types/track'

// Domain → color mapping (RGB tuples for deck.gl)
const DOMAIN_COLORS: Record<string, [number, number, number]> = {
  Air:      [30, 136, 229],   // bright blue
  Maritime: [0, 188, 212],    // cyan
  Space:    [156, 39, 176],   // purple
  GPS:      [244, 67, 54],    // red (jamming)
  Infra:    [255, 152, 0],    // orange
}

const CLASSIFICATION_COLORS: Record<string, [number, number, number]> = {
  Commercial: [100, 181, 246],
  Military:   [244, 67, 54],
  Government: [255, 193, 7],
  Unknown:    [158, 158, 158],
}

// MapLibre free vector tile source (no API key required)
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

interface MapCanvasProps {
  liveAssets: TrackEventProperties[]
}

export function MapCanvas({ liveAssets }: MapCanvasProps) {
  const { viewport, setViewport, layers, playback, selectAsset } = useMapStore()
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; object: TrackEventProperties } | null>(null)

  const viewState: MapViewState = {
    longitude: viewport.longitude,
    latitude: viewport.latitude,
    zoom: viewport.zoom,
    bearing: viewport.bearing,
    pitch: viewport.pitch,
  }

  // Filter assets by enabled layers
  const visibleAssets = useMemo(() => {
    return liveAssets.filter((a) => {
      const layerState = layers[a.source_domain as keyof typeof layers]
      return layerState?.enabled ?? true
    })
  }, [liveAssets, layers])

  const deckLayers = useMemo(() => [
    // ── Air: live positions ──────────────────────────────────────
    layers.Air.enabled && new ScatterplotLayer<TrackEventProperties>({
      id: 'adsb-live',
      data: visibleAssets.filter((a) => a.source_domain === 'Air'),
      getPosition: (d) => [
        // Position comes as properties, not geometry coords here
        // In production, parse from the Feature geometry
        0, 0,
      ],
      getColor: (d) =>
        CLASSIFICATION_COLORS[d.classification ?? 'Unknown'],
      getRadius: 4,
      radiusUnits: 'pixels',
      pickable: true,
      opacity: layers.Air.opacity,
      onHover: ({ x, y, object }) =>
        setHoverInfo(object ? { x, y, object } : null),
      onClick: ({ object }) =>
        object && selectAsset(object.track_id, object.source_domain),
    }),

    // TODO Phase 3: Add TripsLayer for ADS-B trails
    // TODO Phase 3: Add IconLayer for AIS vessels
    // TODO Phase 3: Add ArcLayer for satellite ground tracks
    // TODO Phase 3: Add H3HexagonLayer for GPS jamming
    // TODO Phase 3: Add GeoJsonLayer for infrastructure outages
  ].filter(Boolean), [visibleAssets, layers, selectAsset])

  return (
    <div className="relative w-full h-full">
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: vs }) =>
          setViewport(vs as typeof viewport)
        }
        controller={true}
        layers={deckLayers}
        getTooltip={({ object }) =>
          object
            ? {
                html: `<div class="tooltip">
                  <strong>${(object as TrackEventProperties).callsign ?? (object as TrackEventProperties).track_id}</strong><br/>
                  ${(object as TrackEventProperties).source_domain} · ${(object as TrackEventProperties).classification ?? 'Unknown'}<br/>
                  Alt: ${(object as TrackEventProperties).altitude_m?.toFixed(0) ?? '—'} m
                </div>`,
                style: { background: '#1B2A3B', color: 'white', padding: '8px', borderRadius: '4px' },
              }
            : null
        }
      >
        <Map mapStyle={MAP_STYLE} />
      </DeckGL>
    </div>
  )
}

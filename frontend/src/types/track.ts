/**
 * TypeScript types mirroring the Python TrackEvent schema.
 * These are the wire types received from the API / WebSocket.
 */

export type SourceDomain = 'Air' | 'Maritime' | 'Space' | 'GPS' | 'Infra'

export interface TrackEventProperties {
  event_id: string
  source_domain: SourceDomain
  source_feed: string
  track_id: string
  callsign?: string
  lon?: number
  lat?: number
  altitude_m?: number
  heading_deg?: number
  speed_mps?: number
  timestamp: string       // ISO8601
  last_seen?: string
  classification?: string
  // domain-specific extras via metadata spread
  [key: string]: unknown
}

export interface DisruptionEvent {
  id: string
  source_domain: SourceDomain
  source_feed: string
  external_event_id: string
  track_id?: string
  callsign?: string
  event_type: string
  category: string
  title?: string
  status: string
  severity?: number
  confidence?: number
  source_trust_score?: number
  first_seen: string
  last_seen: string
  start_time?: string | null
  end_time?: string | null
  h3_cell?: string | null
  measurement_value?: number | null
  measurement_unit?: string | null
  affected_assets_count?: number
  correlation_id?: string | null
  classification?: string | null
  metadata?: Record<string, unknown>
  geometry?: GeoJSON.Geometry | null
  centroid?: GeoJSON.Point | null
}

export interface DisruptionEventResponse {
  count: number
  items: DisruptionEvent[]
  window: {
    t_start: string
    t_end: string
  }
}

export interface TrackEventFeature {
  type: 'Feature'
  geometry: {
    type: 'Point'
    coordinates: [number, number]  // [lon, lat]
  } | null
  properties: TrackEventProperties
}

export interface TrackFeatureCollection {
  type: 'FeatureCollection'
  features: TrackEventFeature[]
  meta?: {
    count: number
    limit: number
    offset: number
    t_start: string
    t_end: string
  }
}

export interface LiveSummaryResponse {
  generated_at: string
  total: number
  domains: Record<SourceDomain, number>
}

export interface SpaceAggregateProperties {
  source_domain: 'Space'
  aggregate_kind: 'constellation'
  constellation: string
  count: number
}

export interface SpaceAggregateFeature {
  type: 'Feature'
  geometry: {
    type: 'Point'
    coordinates: [number, number]
  } | null
  properties: SpaceAggregateProperties
}

export interface SpaceAggregateFeatureCollection {
  type: 'FeatureCollection'
  features: SpaceAggregateFeature[]
}

// For deck.gl TripsLayer — needs {path, timestamps} format
export interface TripPath {
  track_id: string
  callsign?: string
  source_domain: SourceDomain
  classification?: string
  path: Array<[number, number, number]>     // [lon, lat, altitude_m]
  timestamps: number[]                       // Unix ms for each waypoint
}

// WebSocket message types
export type WsMessage =
  | { type: 'connected'; message: string }
  | { type: 'track_events'; events: TrackEventProperties[]; count: number }
  | { type: 'alert'; rule_id: string; rule_name?: string; track_id: string; domain: SourceDomain }

// Playback state (managed by Zustand)
export type PlaybackMode = 'live' | 'replay' | 'paused'

export interface TimeWindow {
  start: Date
  end: Date
}

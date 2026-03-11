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

/**
 * TypeScript types mirroring the Python TrackEvent schema.
 * These are the wire types received from the API / WebSocket.
 */

export type SourceDomain = 'Air' | 'Maritime' | 'Space' | 'GPS' | 'Infra'

export type DomainQuickScopeId =
  | 'military'
  | 'commercial_sample'
  | 'recent_alerts'
  | 'viewport'
  | 'by_operator'
  | 'government'
  | 'major_routes'
  | 'watchlist'
  | 'priority_constellations'
  | 'by_function'
  | 'by_constellation'
  | 'active_disruptions'
  | 'high_severity'
  | 'near_selected'
  | 'show_all'

export interface DomainScopeState {
  selectedQuickScope: DomainQuickScopeId | null
  appliedQuickScope: DomainQuickScopeId | null
  resultLimit: number
  customOperator: string
  customConstellation: string
  customPurpose: string
  advancedOpen: boolean
}

export interface ScopedLivePreviewResponse {
  generated_at: string
  count: number
  domain: SourceDomain
  applied_quick_scope: DomainQuickScopeId | null
}

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
  domain_windows: Record<SourceDomain, string>
  stale_total: number
  stale_domains: Record<SourceDomain, number>
}

export interface MaritimeEnrichmentFields {
  ship_type: string | null
  flag: string | null
  destination: string | null
  operator: string | null
  owner: string | null
  platform_type: string | null
  country_code: string | null
}

export interface MaritimeEnrichmentResponse {
  entity_id: string
  track_id: string
  source_domain: Extract<SourceDomain, 'Maritime'>
  status: 'fresh' | 'cached' | 'unavailable' | 'disabled' | 'blocked'
  url: string | null
  fetched_at: string | null
  image_url: string | null
  summary: Record<string, string>
  general: Record<string, string>
  latest_ais: Record<string, string>
  enrichment: MaritimeEnrichmentFields
}

export type OverviewHealth = 'healthy' | 'stale' | 'degraded' | 'down'

export interface OverviewHeaderResponse {
  generated_at: string
  connection: {
    ws_connected: boolean
    api_ok: boolean
    reconnects: number
  }
  alerts: {
    active: number
    investigating: number
    critical: number
  }
  ingest: {
    degraded_sources: number
    stale_sources: number
    last_success_at: string | null
  }
}

export interface OverviewDomainSummary {
  domain: SourceDomain
  live_count: number
  stale_count: number
  active_alerts: number
  degraded_sources: number
  freshness_window: string
  top_change: {
    label: string
    delta: number
    direction: 'up' | 'down' | 'flat'
  } | null
}

export interface OverviewSummaryResponse {
  generated_at: string
  domains: OverviewDomainSummary[]
}

export interface OverviewAlertItem {
  alert_id: string
  domain: SourceDomain
  status: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  subtitle: string | null
  triggered_at: string
  confidence: number | null
  why: string[]
  entity_id: string | null
  track_id: string | null
  bbox: [number, number, number, number] | null
  source_count: number
  investigation_ready: boolean
}

export interface OverviewAlertsResponse {
  generated_at: string
  items: OverviewAlertItem[]
}

export interface OverviewSourceHealthItem {
  source_feed: string
  domain: SourceDomain
  health: OverviewHealth
  lag_minutes: number | null
  last_success_at: string | null
  error_rate: number | null
}

export interface OverviewWatchlistSummary {
  enabled: number
  active_tracks: number
  stale_entries: number
  priority_items: number
}

export interface OverviewDisruptionSummaryItem {
  domain: Extract<SourceDomain, 'GPS' | 'Infra'>
  active_events: number
  high_severity: number
  impacted_assets: number
}

export interface OverviewOpsResponse {
  generated_at: string
  source_health: OverviewSourceHealthItem[]
  watchlist: OverviewWatchlistSummary
  disruptions: OverviewDisruptionSummaryItem[]
}

export interface OverviewActivityBucket {
  ts: string
  count: number
}

export interface OverviewActivitySeries {
  domain: SourceDomain
  buckets: OverviewActivityBucket[]
}

export interface OverviewTopMover {
  label: string
  domain: SourceDomain
  delta: number
  reason: string
}

export interface OverviewTopAoi {
  id: string
  name: string
  active_alerts: number
  impacted_assets: number
}

export interface OverviewResumeSession {
  investigation_id: string
  title: string
  updated_at: string
  domain: SourceDomain
}

export interface OverviewActivityResponse {
  generated_at: string
  activity: OverviewActivitySeries[]
  top_movers: OverviewTopMover[]
  top_aois: OverviewTopAoi[]
  resume_session: OverviewResumeSession | null
}

export interface OverviewDashboardResponse {
  header: OverviewHeaderResponse
  summary: OverviewSummaryResponse
  alerts: OverviewAlertsResponse
  ops: OverviewOpsResponse
  activity: OverviewActivityResponse
  meta: OverviewSectionMetaMap
}

export interface OverviewCoreResponse {
  header: OverviewHeaderResponse
  summary: OverviewSummaryResponse
  alerts: OverviewAlertsResponse
  ops: OverviewOpsResponse
  meta: OverviewSectionMetaMap
}

export interface OverviewPivotsResponse {
  activity: OverviewActivityResponse
  meta: OverviewSectionMetaMap
}

export interface OverviewSectionMeta {
  status: 'ok' | 'degraded' | 'failed'
  error: string | null
}

export interface OverviewSectionMetaMap {
  summary?: OverviewSectionMeta
  alerts?: OverviewSectionMeta
  ops?: OverviewSectionMeta
  activity?: OverviewSectionMeta
}

export interface HealthResponse {
  status: string
  version?: string
  capabilities?: {
    overview_dashboard?: boolean
    overview_core?: boolean
    overview_pivots?: boolean
  }
}

export type SatelliteFieldStatus = 'authoritative' | 'inferred' | 'derived' | 'curated' | 'missing'
export type SatelliteEnrichmentConfidence = 'high' | 'medium' | 'low'

export interface SatelliteEnrichmentStatus {
  sources: string[]
  last_updated: string | null
  tle_epoch: string | null
  tle_source: string | null
  tle_age_minutes: number | null
  completeness_pct: number
  confidence: SatelliteEnrichmentConfidence
  field_status: {
    identity: SatelliteFieldStatus
    orbit: SatelliteFieldStatus
    operator: SatelliteFieldStatus
    purpose: SatelliteFieldStatus
    contractor: SatelliteFieldStatus
    launch: SatelliteFieldStatus
  }
}

export interface SatelliteCatalogEntry {
  norad_id: number
  object_name: string
  intl_designator: string | null
  object_type: string | null
  country_code: string | null
  launch_date: string | null
  decay_date: string | null
  period_min: number | null
  inclination_deg: number | null
  apogee_km: number | null
  perigee_km: number | null
  rcs_size: string | null
  orbit_class: string | null
  operator: string | null
  purpose: string | null
  contractor: string | null
  launch_site: string | null
  sources: string[]
  last_updated: string | null
  metadata: Record<string, unknown>
  enrichment_status: SatelliteEnrichmentStatus
}

export interface SatelliteTleSnapshot {
  epoch: string
  tle_line1: string
  tle_line2: string
  source: string
  ingested_at: string | null
}

export interface SatelliteTleResponse {
  norad_id: number
  count: number
  tles: SatelliteTleSnapshot[]
}

export interface SpaceAggregateProperties {
  source_domain: 'Space'
  aggregate_kind: 'constellation'
  constellation: string
  count: number
}

export interface SpaceAggregate {
  constellation: string
  count: number
  lon: number
  lat: number
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

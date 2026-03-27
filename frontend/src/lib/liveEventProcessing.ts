import type { SourceDomain, TrackEventProperties } from '@/types/track'

export interface TrackEventBounds {
  west: number
  south: number
  east: number
  north: number
}

export interface ProcessedLiveEvents {
  latest: TrackEventProperties[]
  viewportRefreshBatch: TrackEventProperties[]
  viewportRemovalKeys: string[]
  trailAppendBatch: TrackEventProperties[]
}

export interface TrailHeadSnapshot {
  lon: number
  lat: number
  altitude_m?: number
  timestamp: number
}

export function isTrackEventInBounds(
  asset: Pick<TrackEventProperties, 'lon' | 'lat'>,
  bounds: TrackEventBounds | null,
): boolean {
  if (!bounds || typeof asset.lon !== 'number' || typeof asset.lat !== 'number') return false
  const { lon, lat } = asset
  const withinLongitude = bounds.west <= bounds.east
    ? lon >= bounds.west && lon <= bounds.east
    : lon >= bounds.west || lon <= bounds.east
  return withinLongitude && lat >= bounds.south && lat <= bounds.north
}

export function processIncomingTrackEvents(
  events: TrackEventProperties[],
  viewportKeys: string[],
  viewportBounds: TrackEventBounds | null,
  trailHeads: Partial<Record<string, TrailHeadSnapshot>> = {},
): ProcessedLiveEvents {
  const latestByKey = new Map<string, TrackEventProperties>()
  for (const event of events) {
    latestByKey.set(`${event.source_domain}:${event.track_id}`, event)
  }

  const latest = Array.from(latestByKey.values())
  const viewportMembership = new Set(viewportKeys)
  const latestByDomain: Record<SourceDomain, TrackEventProperties[]> = {
    Air: [],
    Maritime: [],
    Space: [],
    GPS: [],
    Infra: [],
  }
  const viewportRefreshBatch: TrackEventProperties[] = []
  const viewportRemovalKeys: string[] = []
  const trailAppendBatch: TrackEventProperties[] = []

  for (const event of latest) {
    const key = `${event.source_domain}:${event.track_id}`
    latestByDomain[event.source_domain].push(event)
    if (!viewportMembership.has(key)) continue
    if (isTrackEventInBounds(event, viewportBounds)) {
      viewportRefreshBatch.push(event)
    } else {
      viewportRemovalKeys.push(key)
    }
  }

  for (const domain of Object.keys(latestByDomain) as SourceDomain[]) {
    for (const event of latestByDomain[domain]) {
      const key = `${event.source_domain}:${event.track_id}`
      if (!shouldAppendTrailPoint(event, trailHeads[key])) continue
      trailAppendBatch.push(event)
    }
  }

  return {
    latest,
    viewportRefreshBatch,
    viewportRemovalKeys,
    trailAppendBatch,
  }
}

function shouldAppendTrailPoint(
  event: TrackEventProperties,
  previousPoint: TrailHeadSnapshot | undefined,
): boolean {
  if (typeof event.lon !== 'number' || typeof event.lat !== 'number') return false
  if (!previousPoint) return true

  const nextTimestamp = Date.parse(event.timestamp)
  if (!Number.isFinite(nextTimestamp)) return true

  const profile = TRAIL_SHAPING[event.source_domain]
  const lonDelta = Math.abs(event.lon - previousPoint.lon)
  const latDelta = Math.abs(event.lat - previousPoint.lat)
  const altitudeDelta = Math.abs((event.altitude_m ?? 0) - (previousPoint.altitude_m ?? 0))

  return (
    nextTimestamp - previousPoint.timestamp >= profile.minTimeMs ||
    lonDelta >= profile.minLonDelta ||
    latDelta >= profile.minLatDelta ||
    altitudeDelta >= profile.minAltitudeDelta
  )
}

const TRAIL_SHAPING = {
  Air: {
    minTimeMs: 20_000,
    minLonDelta: 0.012,
    minLatDelta: 0.012,
    minAltitudeDelta: 120,
  },
  Maritime: {
    minTimeMs: 60_000,
    minLonDelta: 0.02,
    minLatDelta: 0.02,
    minAltitudeDelta: Number.POSITIVE_INFINITY,
  },
  Space: {
    minTimeMs: 120_000,
    minLonDelta: 0.08,
    minLatDelta: 0.08,
    minAltitudeDelta: 500,
  },
  GPS: {
    minTimeMs: 120_000,
    minLonDelta: 0.05,
    minLatDelta: 0.05,
    minAltitudeDelta: Number.POSITIVE_INFINITY,
  },
  Infra: {
    minTimeMs: 120_000,
    minLonDelta: 0.05,
    minLatDelta: 0.05,
    minAltitudeDelta: Number.POSITIVE_INFINITY,
  },
} as const

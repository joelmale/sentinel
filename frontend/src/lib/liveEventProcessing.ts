import type { TrackEventProperties } from '@/types/track'

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
): ProcessedLiveEvents {
  const latestByKey = new Map<string, TrackEventProperties>()
  for (const event of events) {
    latestByKey.set(`${event.source_domain}:${event.track_id}`, event)
  }

  const latest = Array.from(latestByKey.values())
  const viewportMembership = new Set(viewportKeys)
  const viewportRefreshBatch: TrackEventProperties[] = []
  const viewportRemovalKeys: string[] = []

  for (const event of latest) {
    const key = `${event.source_domain}:${event.track_id}`
    if (!viewportMembership.has(key)) continue
    if (isTrackEventInBounds(event, viewportBounds)) {
      viewportRefreshBatch.push(event)
    } else {
      viewportRemovalKeys.push(key)
    }
  }

  return {
    latest,
    viewportRefreshBatch,
    viewportRemovalKeys,
  }
}

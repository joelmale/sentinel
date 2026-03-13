import type { SourceDomain, TrackEventProperties } from '@/types/track'
import { getAirlineGroup, getConstellation, getMmsiCountry } from '@/data/grouping'

export interface DemoFilterOption {
  key: string
  label: string
  count: number
}

const MAX_OPTIONS_PER_DOMAIN = 8
const SPACE_PREFERRED_ORDER = [
  'Spire Global',
  'Sentinel (ESA)',
  'Planet Labs',
  'BlackSky',
  'GPS (USAF)',
  'ISS',
  'OneWeb',
  'Iridium',
  'Starlink',
]

function countBy<T>(items: TrackEventProperties[], derive: (asset: TrackEventProperties) => T | null): Map<T, number> {
  const counts = new Map<T, number>()
  for (const asset of items) {
    const key = derive(asset)
    if (key == null) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function topOptions(counts: Map<string, number>, maxOptions = MAX_OPTIONS_PER_DOMAIN): DemoFilterOption[] {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxOptions)
    .map(([key, count]) => ({ key, label: key, count }))
}

export function getAssetDemoFilterKey(asset: TrackEventProperties): string | null {
  if (asset.source_domain === 'Air') return getAirlineGroup(asset.callsign, asset.classification)
  if (asset.source_domain === 'Maritime') return getMmsiCountry(asset.track_id)
  if (asset.source_domain === 'Space') return getConstellation(asset.callsign)
  return null
}

export function matchesAssetDemoFilter(asset: TrackEventProperties, selectedKey: string | null | undefined): boolean {
  if (!selectedKey) return true
  const key = getAssetDemoFilterKey(asset)
  return key === selectedKey
}

export function buildDemoFilterOptions(domain: SourceDomain, assets: TrackEventProperties[]): DemoFilterOption[] {
  if (domain === 'Air') {
    return topOptions(countBy(assets, (asset) => getAirlineGroup(asset.callsign, asset.classification)))
  }

  if (domain === 'Maritime') {
    return topOptions(countBy(assets, (asset) => getMmsiCountry(asset.track_id)))
  }

  if (domain === 'Space') {
    const counts = countBy(assets, (asset) => getConstellation(asset.callsign))
    const ranked = Array.from(counts.entries()).sort((a, b) => {
      const aPreferred = SPACE_PREFERRED_ORDER.indexOf(a[0])
      const bPreferred = SPACE_PREFERRED_ORDER.indexOf(b[0])
      if (aPreferred !== -1 || bPreferred !== -1) {
        if (aPreferred === -1) return 1
        if (bPreferred === -1) return -1
        return aPreferred - bPreferred
      }
      return b[1] - a[1] || a[0].localeCompare(b[0])
    })
    return ranked.slice(0, MAX_OPTIONS_PER_DOMAIN).map(([key, count]) => ({ key, label: key, count }))
  }

  return []
}

export function getDefaultDemoFilterKey(domain: SourceDomain, options: DemoFilterOption[]): string | null {
  if (options.length === 0) return null
  if (domain === 'Air') {
    const military = options.find((option) => option.key === '🎖 Military')
    if (military) return military.key
  }
  if (domain === 'Space') {
    const spire = options.find((option) => option.key === 'Spire Global')
    if (spire) return spire.key
  }
  return options[0].key
}

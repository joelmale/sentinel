import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNowStrict } from 'date-fns'
import { getAirlineGroup, getConstellation, getConstellationCategory, getMmsiCountry } from '@/data/grouping'
import { trackedFetchJson } from '@/lib/perf'
import { useMapStore } from '@/store/useMapStore'
import type { SatelliteCatalogEntry, SatelliteTleResponse, SourceDomain, TrackEventProperties } from '@/types/track'

type SortKey = 'timestamp' | 'domain' | 'classification' | 'feed' | 'track'

const DOMAIN_META: Record<SourceDomain, { color: string; icon: string }> = {
  Air: { color: '#60a5fa', icon: '✈' },
  Maritime: { color: '#22d3ee', icon: '⚓' },
  Space: { color: '#c084fc', icon: '🛰' },
  GPS: { color: '#f87171', icon: '📡' },
  Infra: { color: '#f59e0b', icon: '🌐' },
}

const PAGE_SIZE = 100

function assetGroupLabel(asset: TrackEventProperties): string {
  if (asset.source_domain === 'Air') return getAirlineGroup(asset.callsign, asset.classification)
  if (asset.source_domain === 'Maritime') return getMmsiCountry(asset.track_id)
  if (asset.source_domain === 'Space') return getConstellation(asset.callsign, asset.object_type)
  return asset.classification ?? 'Unknown'
}

function assetKey(asset: TrackEventProperties): string {
  return `${asset.source_domain}:${asset.track_id}`
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: true })
  } catch {
    return iso
  }
}

export function TrackBrowserView({
  assets,
  loading,
  initialDomain = 'All',
}: {
  assets: TrackEventProperties[]
  loading: boolean
  initialDomain?: SourceDomain | 'All'
}) {
  const { selectAsset, flyTo } = useMapStore()
  const [search, setSearch] = useState('')
  const [selectedDomain, setSelectedDomain] = useState<SourceDomain | 'All'>(initialDomain)
  const [selectedClassification, setSelectedClassification] = useState<string>('All')
  const [selectedFeed, setSelectedFeed] = useState<string>('All')
  const [selectedSpaceCategory, setSelectedSpaceCategory] = useState<string>('All')
  const [sortKey, setSortKey] = useState<SortKey>('timestamp')
  const [page, setPage] = useState(0)
  const [selectedAssetKey, setSelectedAssetKey] = useState<string | null>(null)

  useEffect(() => {
    setSelectedDomain(initialDomain)
    setPage(0)
  }, [initialDomain])

  const classifications = useMemo(() => (
    Array.from(new Set(assets.map((asset) => asset.classification ?? 'Unknown'))).sort()
  ), [assets])

  const feeds = useMemo(() => (
    Array.from(new Set(assets.map((asset) => asset.source_feed))).sort()
  ), [assets])

  const spaceCategories = useMemo(() => (
    Array.from(new Set(
      assets
        .filter((asset) => asset.source_domain === 'Space')
        .map((asset) => getConstellationCategory(getConstellation(asset.callsign, asset.object_type)))
    ))
  ), [assets])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const next = assets.filter((asset) => {
      if (selectedDomain !== 'All' && asset.source_domain !== selectedDomain) return false
      if (selectedClassification !== 'All' && (asset.classification ?? 'Unknown') !== selectedClassification) return false
      if (selectedFeed !== 'All' && asset.source_feed !== selectedFeed) return false
      if (
        selectedSpaceCategory !== 'All' &&
        (asset.source_domain !== 'Space' || getConstellationCategory(getConstellation(asset.callsign, asset.object_type)) !== selectedSpaceCategory)
      ) return false
      if (!q) return true
      return [
        asset.track_id,
        asset.callsign ?? '',
        asset.source_feed,
        asset.classification ?? '',
        assetGroupLabel(asset),
      ].some((value) => value.toLowerCase().includes(q))
    })

    next.sort((a, b) => {
      if (sortKey === 'timestamp') return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      if (sortKey === 'domain') return a.source_domain.localeCompare(b.source_domain) || a.track_id.localeCompare(b.track_id)
      if (sortKey === 'classification') return (a.classification ?? 'Unknown').localeCompare(b.classification ?? 'Unknown')
      if (sortKey === 'feed') return a.source_feed.localeCompare(b.source_feed) || a.track_id.localeCompare(b.track_id)
      return (a.callsign ?? a.track_id).localeCompare(b.callsign ?? b.track_id)
    })
    return next
  }, [assets, search, selectedDomain, selectedClassification, selectedFeed, selectedSpaceCategory, sortKey])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const paged = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
  const selectedAsset = useMemo(() => {
    if (selectedAssetKey) {
      const explicit = filtered.find((asset) => assetKey(asset) === selectedAssetKey)
      if (explicit) return explicit
    }
    return paged[0] ?? filtered[0] ?? null
  }, [filtered, paged, selectedAssetKey])

  useEffect(() => {
    if (!selectedAsset) {
      setSelectedAssetKey(null)
      return
    }
    if (!selectedAssetKey) {
      setSelectedAssetKey(assetKey(selectedAsset))
      return
    }
    if (!filtered.some((asset) => assetKey(asset) === selectedAssetKey)) {
      setSelectedAssetKey(assetKey(selectedAsset))
    }
  }, [filtered, selectedAsset, selectedAssetKey])

  const selectedSpaceNoradId = useMemo(() => {
    if (!selectedAsset || selectedAsset.source_domain !== 'Space') return null
    const raw = selectedAsset.norad_id ?? selectedAsset.track_id
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }, [selectedAsset])

  const selectedSpaceCatalogQuery = useQuery({
    queryKey: ['browser-satellite-catalog', selectedSpaceNoradId],
    enabled: selectedSpaceNoradId !== null,
    queryFn: async (): Promise<SatelliteCatalogEntry> => trackedFetchJson(
      'browser-satellite-catalog',
      `/api/satellites/${selectedSpaceNoradId}`,
    ),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  const selectedSpaceTlesQuery = useQuery({
    queryKey: ['browser-satellite-tles', selectedSpaceNoradId],
    enabled: selectedSpaceNoradId !== null,
    queryFn: async (): Promise<SatelliteTleResponse> => trackedFetchJson(
      'browser-satellite-tles',
      `/api/satellites/${selectedSpaceNoradId}/tles?limit=3`,
    ),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  const correlation = useMemo(() => {
    const byDomain = new Map<string, number>()
    const byFeed = new Map<string, number>()
    const byClass = new Map<string, number>()
    const byGroup = new Map<string, number>()
    for (const asset of filtered) {
      byDomain.set(asset.source_domain, (byDomain.get(asset.source_domain) ?? 0) + 1)
      byFeed.set(asset.source_feed, (byFeed.get(asset.source_feed) ?? 0) + 1)
      const cls = asset.classification ?? 'Unknown'
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1)
      const group = assetGroupLabel(asset)
      byGroup.set(group, (byGroup.get(group) ?? 0) + 1)
    }
    const top = (map: Map<string, number>) => Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8)
    return {
      byDomain: top(byDomain),
      byFeed: top(byFeed),
      byClass: top(byClass),
      byGroup: top(byGroup),
    }
  }, [filtered])

  return (
    <div style={{ position: 'fixed', inset: 72, display: 'grid', gridTemplateColumns: '280px 1fr 320px', background: '#0f172a' }}>
      <div style={{ borderRight: '1px solid rgba(148,163,184,0.16)', padding: 18, overflowY: 'auto' }}>
        <div style={{ fontSize: 11, color: '#64748b', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>Browse</div>
        <input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setPage(0)
          }}
          placeholder="Search track, callsign, feed, constellation..."
          style={{
            width: '100%',
            borderRadius: 10,
            border: '1px solid rgba(100,116,139,0.3)',
            background: 'rgba(15,23,42,0.8)',
            color: '#e2e8f0',
            padding: '10px 12px',
            fontSize: 12,
            marginBottom: 16,
          }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
          {(['All', 'Air', 'Maritime', 'Space'] as const).map((domain) => {
            const selected = selectedDomain === domain
            return (
              <button
                key={domain}
                type="button"
                onClick={() => {
                  setSelectedDomain(domain)
                  setPage(0)
                }}
                style={{
                  borderRadius: 999,
                  border: `1px solid ${selected ? 'rgba(94,234,212,0.4)' : 'rgba(100,116,139,0.25)'}`,
                  background: selected ? 'rgba(20,184,166,0.16)' : 'rgba(15,23,42,0.7)',
                  color: selected ? '#99f6e4' : '#cbd5e1',
                  padding: '6px 10px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {domain}
              </button>
            )
          })}
        </div>
        <FilterBlock label="Classification">
          <select value={selectedClassification} onChange={(event) => { setSelectedClassification(event.target.value); setPage(0) }} style={selectStyle}>
            <option value="All">All</option>
            {classifications.map((classification) => <option key={classification} value={classification}>{classification}</option>)}
          </select>
        </FilterBlock>
        <FilterBlock label="Source Feed">
          <select value={selectedFeed} onChange={(event) => { setSelectedFeed(event.target.value); setPage(0) }} style={selectStyle}>
            <option value="All">All</option>
            {feeds.map((feed) => <option key={feed} value={feed}>{feed}</option>)}
          </select>
        </FilterBlock>
        <FilterBlock label="Space Category">
          <select value={selectedSpaceCategory} onChange={(event) => { setSelectedSpaceCategory(event.target.value); setPage(0) }} style={selectStyle}>
            <option value="All">All</option>
            {spaceCategories.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </FilterBlock>
        <FilterBlock label="Sort">
          <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)} style={selectStyle}>
            <option value="timestamp">Most recent</option>
            <option value="domain">Domain</option>
            <option value="classification">Classification</option>
            <option value="feed">Feed</option>
            <option value="track">Track / Callsign</option>
          </select>
        </FilterBlock>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid rgba(148,163,184,0.16)' }}>
          <div>
            <div style={{ fontSize: 11, color: '#64748b', letterSpacing: '0.14em', textTransform: 'uppercase' }}>Track Browser</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#f8fafc' }}>{loading ? 'Loading live track set…' : `${filtered.length.toLocaleString()} tracks in result set`}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" disabled={safePage === 0} onClick={() => setPage((current) => Math.max(0, current - 1))} style={pagerStyle(safePage === 0)}>Prev</button>
            <button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} style={pagerStyle(safePage >= pageCount - 1)}>Next</button>
          </div>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, background: '#111827', zIndex: 1 }}>
              <tr>
                {['Track', 'Domain', 'Feed', 'Class', 'Group', 'Last Seen', 'Lat', 'Lon'].map((label) => (
                  <th key={label} style={thStyle}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paged.map((asset) => (
                <tr
                  key={assetKey(asset)}
                  onClick={() => {
                    setSelectedAssetKey(assetKey(asset))
                    selectAsset(asset.track_id, asset.source_domain)
                    if (typeof asset.lon === 'number' && typeof asset.lat === 'number') {
                      flyTo(asset.lon, asset.lat, 6)
                    }
                  }}
                  style={{
                    cursor: 'pointer',
                    borderBottom: '1px solid rgba(148,163,184,0.08)',
                    background: selectedAsset && assetKey(asset) === assetKey(selectedAsset) ? 'rgba(30,41,59,0.85)' : 'transparent',
                  }}
                >
                  <td style={tdStyle}>
                    <div style={{ color: '#f8fafc', fontWeight: 700 }}>{asset.callsign ?? asset.track_id}</div>
                    <div style={{ color: '#64748b', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{asset.track_id}</div>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ color: DOMAIN_META[asset.source_domain].color }}>{DOMAIN_META[asset.source_domain].icon} {asset.source_domain}</span>
                  </td>
                  <td style={tdStyle}>{asset.source_feed}</td>
                  <td style={tdStyle}>{asset.classification ?? 'Unknown'}</td>
                  <td style={tdStyle}>{assetGroupLabel(asset)}</td>
                  <td style={tdStyle}>{formatDistanceToNowStrict(new Date(asset.timestamp), { addSuffix: true })}</td>
                  <td style={tdStyle}>{typeof asset.lat === 'number' ? asset.lat.toFixed(3) : '—'}</td>
                  <td style={tdStyle}>{typeof asset.lon === 'number' ? asset.lon.toFixed(3) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ borderLeft: '1px solid rgba(148,163,184,0.16)', padding: 18, overflowY: 'auto' }}>
        <div style={{ fontSize: 11, color: '#64748b', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>Correlation</div>
        <SummaryBlock title="Domains" items={correlation.byDomain} />
        <SummaryBlock title="Feeds" items={correlation.byFeed} />
        <SummaryBlock title="Classifications" items={correlation.byClass} />
        <SummaryBlock title="Groups" items={correlation.byGroup} />
        {selectedAsset && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(148,163,184,0.16)' }}>
            <div style={{ fontSize: 11, color: '#64748b', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 8 }}>Track Detail</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc', marginBottom: 6 }}>{selectedAsset.callsign ?? selectedAsset.track_id}</div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>{selectedAsset.source_domain} · {selectedAsset.source_feed}</div>
            <div style={{ fontSize: 12, color: '#cbd5e1', marginBottom: 14 }}>{assetGroupLabel(selectedAsset)}</div>

            <DetailGrid
              items={[
                ['Track ID', selectedAsset.track_id],
                ['Classification', selectedAsset.classification ?? 'Unknown'],
                ['Last Seen', fmtRelative(selectedAsset.timestamp)],
                ['Latitude', typeof selectedAsset.lat === 'number' ? selectedAsset.lat.toFixed(4) : '—'],
                ['Longitude', typeof selectedAsset.lon === 'number' ? selectedAsset.lon.toFixed(4) : '—'],
                ['Heading', typeof selectedAsset.heading_deg === 'number' ? `${selectedAsset.heading_deg.toFixed(1)}°` : '—'],
                ['Speed', typeof selectedAsset.speed_mps === 'number' ? `${(selectedAsset.speed_mps * 1.94384).toFixed(1)} kts` : '—'],
                ['Altitude', typeof selectedAsset.altitude_m === 'number' ? `${Math.round(selectedAsset.altitude_m).toLocaleString()} m` : '—'],
              ]}
            />

            {selectedAsset.source_domain === 'Space' && (
              <>
                <SidebarSection title="Catalog">
                  {selectedSpaceCatalogQuery.isLoading ? (
                    <div style={subtleTextStyle}>Loading satellite catalog…</div>
                  ) : selectedSpaceCatalogQuery.data ? (
                    <DetailGrid
                      items={[
                        ['NORAD', String(selectedSpaceCatalogQuery.data.norad_id)],
                        ['Object Name', selectedSpaceCatalogQuery.data.object_name],
                        ['Intl Des.', selectedSpaceCatalogQuery.data.intl_designator ?? '—'],
                        ['Object Type', selectedSpaceCatalogQuery.data.object_type ?? '—'],
                        ['Operator', selectedSpaceCatalogQuery.data.operator ?? '—'],
                        ['Purpose', selectedSpaceCatalogQuery.data.purpose ?? '—'],
                        ['Contractor', selectedSpaceCatalogQuery.data.contractor ?? '—'],
                        ['Orbit Class', selectedSpaceCatalogQuery.data.orbit_class ?? '—'],
                        ['Apogee', selectedSpaceCatalogQuery.data.apogee_km != null ? `${selectedSpaceCatalogQuery.data.apogee_km.toFixed(0)} km` : '—'],
                        ['Perigee', selectedSpaceCatalogQuery.data.perigee_km != null ? `${selectedSpaceCatalogQuery.data.perigee_km.toFixed(0)} km` : '—'],
                        ['Inclination', selectedSpaceCatalogQuery.data.inclination_deg != null ? `${selectedSpaceCatalogQuery.data.inclination_deg.toFixed(2)}°` : '—'],
                        ['Launch Date', selectedSpaceCatalogQuery.data.launch_date ?? '—'],
                        ['Launch Site', selectedSpaceCatalogQuery.data.launch_site ?? '—'],
                        ['RCS', selectedSpaceCatalogQuery.data.rcs_size ?? '—'],
                      ]}
                    />
                  ) : (
                    <div style={subtleTextStyle}>No catalog enrichment available.</div>
                  )}
                </SidebarSection>

                <SidebarSection title="Enrichment Status">
                  {selectedSpaceCatalogQuery.data?.enrichment_status ? (
                    <>
                      <DetailGrid
                        items={[
                          ['Confidence', selectedSpaceCatalogQuery.data.enrichment_status.confidence],
                          ['Completeness', `${selectedSpaceCatalogQuery.data.enrichment_status.completeness_pct}%`],
                          ['Catalog Updated', fmtRelative(selectedSpaceCatalogQuery.data.enrichment_status.last_updated)],
                          ['TLE Epoch', fmtRelative(selectedSpaceCatalogQuery.data.enrichment_status.tle_epoch)],
                          ['TLE Source', selectedSpaceCatalogQuery.data.enrichment_status.tle_source ?? '—'],
                          ['Sources', selectedSpaceCatalogQuery.data.enrichment_status.sources.join(', ') || '—'],
                        ]}
                      />
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                        {Object.entries(selectedSpaceCatalogQuery.data.enrichment_status.field_status).map(([label, status]) => (
                          <span key={label} style={statusChipStyle(status)}>
                            {label}: {status}
                          </span>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div style={subtleTextStyle}>No enrichment status available.</div>
                  )}
                </SidebarSection>

                <SidebarSection title="TLE">
                  {selectedSpaceTlesQuery.isLoading ? (
                    <div style={subtleTextStyle}>Loading TLE history…</div>
                  ) : selectedSpaceTlesQuery.data?.tles?.length ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {selectedSpaceTlesQuery.data.tles.map((tle) => (
                        <div key={tle.epoch} style={tleCardStyle}>
                          <div style={{ fontSize: 11, color: '#f8fafc', fontWeight: 700, marginBottom: 4 }}>
                            {fmtRelative(tle.epoch)} · {tle.source}
                          </div>
                          <div style={monoLineStyle}>{tle.tle_line1}</div>
                          <div style={monoLineStyle}>{tle.tle_line2}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={subtleTextStyle}>No TLE history available.</div>
                  )}
                </SidebarSection>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function FilterBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, color: '#64748b', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  )
}

function SummaryBlock({ title, items }: { title: string; items: Array<[string, number]> }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 10, color: '#64748b', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(([label, count]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
            <span style={{ color: '#cbd5e1' }}>{label}</span>
            <span style={{ color: '#f8fafc', fontWeight: 700 }}>{count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 10, color: '#64748b', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}

function DetailGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
      {items.map(([label, value]) => (
        <div key={label} style={{ display: 'grid', gap: 2 }}>
          <div style={{ fontSize: 10, color: '#64748b', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
          <div style={{ fontSize: 12, color: '#e2e8f0', wordBreak: 'break-word' }}>{value}</div>
        </div>
      ))}
    </div>
  )
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  borderRadius: 10,
  border: '1px solid rgba(100,116,139,0.3)',
  background: 'rgba(15,23,42,0.8)',
  color: '#e2e8f0',
  padding: '8px 10px',
  fontSize: 12,
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 10,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: '#94a3b8',
  padding: '12px 14px',
  borderBottom: '1px solid rgba(148,163,184,0.16)',
}

const tdStyle: React.CSSProperties = {
  padding: '12px 14px',
  color: '#cbd5e1',
  verticalAlign: 'top',
}

const subtleTextStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#94a3b8',
}

const tleCardStyle: React.CSSProperties = {
  borderRadius: 10,
  border: '1px solid rgba(100,116,139,0.24)',
  background: 'rgba(15,23,42,0.72)',
  padding: '10px 12px',
}

const monoLineStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#cbd5e1',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  lineHeight: 1.5,
  wordBreak: 'break-all',
}

function statusChipStyle(status: string): React.CSSProperties {
  const color =
    status === 'authoritative' ? ['rgba(34,197,94,0.16)', 'rgba(34,197,94,0.35)', '#86efac']
    : status === 'derived' ? ['rgba(59,130,246,0.16)', 'rgba(59,130,246,0.35)', '#93c5fd']
    : status === 'inferred' ? ['rgba(245,158,11,0.16)', 'rgba(245,158,11,0.35)', '#fcd34d']
    : status === 'curated' ? ['rgba(168,85,247,0.16)', 'rgba(168,85,247,0.35)', '#d8b4fe']
    : ['rgba(71,85,105,0.22)', 'rgba(100,116,139,0.3)', '#cbd5e1']

  return {
    borderRadius: 999,
    border: `1px solid ${color[1]}`,
    background: color[0],
    color: color[2],
    fontSize: 10,
    fontWeight: 700,
    padding: '4px 8px',
  }
}

function pagerStyle(disabled: boolean): React.CSSProperties {
  return {
    borderRadius: 8,
    border: '1px solid rgba(100,116,139,0.28)',
    background: disabled ? 'rgba(30,41,59,0.35)' : 'rgba(15,23,42,0.8)',
    color: disabled ? '#64748b' : '#e2e8f0',
    padding: '6px 10px',
    fontSize: 11,
    fontWeight: 700,
    cursor: disabled ? 'default' : 'pointer',
  }
}

import { useEffect } from 'react'

type BinCraftMetrics = {
  avg_receiver_count: number | null
  avg_rssi: number | null
  dominant_surveillance_type: string | null
  surveillance_type_count: number
}

type FeedStatus = {
  feed: string
  asset_count: number
  fresh_assets: number
  stale_assets: number
  latest_seen: string | null
  age_minutes: number | null
  events_1h: number
  events_24h: number
  active_tracks_1h: number
  health: string
  classifications: Record<string, number>
  bincraft?: BinCraftMetrics
}

type DomainSummary = {
  tracked: number
  fresh: number
  stale: number
  feeds: number
  due_feeds: number
  latest_seen: string | null
  avg_speed_mps: number | null
  avg_altitude_m: number | null
  events_1h: number
  events_24h: number
}

export type DomainStatusDashboardPayload = {
  domain: 'Air' | 'Maritime'
  generated_at: string
  summary: DomainSummary
  feeds: FeedStatus[]
  classifications: Array<{ label: string; count: number }>
}

type Props = {
  open: boolean
  loading: boolean
  error: string | null
  domain: 'Air' | 'Maritime'
  data?: DomainStatusDashboardPayload
  onClose: () => void
}

const DOMAIN_THEME = {
  Air: {
    eyebrow: 'Air Ops',
    title: 'Flight Source Status',
    subtitle: 'Live feed posture, recency, and activity for aviation tracking sources.',
    accent: '#60a5fa',
    accentSoft: '#1d4ed8',
    dial: '#38bdf8',
    icon: '✈',
    avgMetricLabel: 'avg altitude',
    avgMetricFormat: (value: number | null) => value == null ? 'n/a' : `${Math.round(value / 0.3048).toLocaleString()} ft`,
  },
  Maritime: {
    eyebrow: 'Maritime Ops',
    title: 'Maritime Source Status',
    subtitle: 'Live vessel coverage, feed freshness, and enrichment posture for maritime tracking.',
    accent: '#22d3ee',
    accentSoft: '#0f766e',
    dial: '#2dd4bf',
    icon: '⚓',
    avgMetricLabel: 'avg speed',
    avgMetricFormat: (value: number | null) => value == null ? 'n/a' : `${(value * 1.94384).toFixed(1)} kn`,
  },
} as const

function formatAge(minutes: number | null): string {
  if (minutes == null) return 'Never'
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`
  return `${(minutes / 1440).toFixed(1)}d`
}

function formatRelative(timestamp: string | null): string {
  if (!timestamp) return 'Never'
  const deltaMinutes = (Date.now() - new Date(timestamp).getTime()) / 60000
  return formatAge(deltaMinutes)
}

function dialStyle(value: number, color: string): React.CSSProperties {
  const clamped = Math.max(0, Math.min(100, value))
  return {
    width: 86,
    height: 86,
    borderRadius: '50%',
    background: `conic-gradient(${color} 0 ${clamped}%, rgba(51,65,85,0.45) ${clamped}% 100%)`,
    display: 'grid',
    placeItems: 'center',
    boxShadow: `0 0 0 1px rgba(148,163,184,0.16), 0 12px 30px ${color}22`,
  }
}

const HEALTH_COLORS: Record<string, string> = {
  healthy: '#34d399',
  stale: '#f59e0b',
  missing: '#ef4444',
}

export function DomainStatusDashboard({ open, loading, error, domain, data, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const theme = DOMAIN_THEME[domain]
  const summary = data?.summary
  const feeds = data?.feeds ?? []
  const classifications = data?.classifications ?? []
  const freshnessScore = summary && summary.tracked > 0 ? Math.round((summary.fresh / summary.tracked) * 100) : 0
  const feedReadiness = summary && summary.feeds > 0 ? Math.max(0, 100 - Math.round((summary.due_feeds / summary.feeds) * 100)) : 0

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle(theme.accent, theme.accentSoft)} onClick={(event) => event.stopPropagation()}>
        <div style={heroStyle}>
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.24em', color: theme.accent }}>
              {theme.eyebrow}
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#f8fafc', marginTop: 6 }}>
              {theme.title}
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1', maxWidth: 560, lineHeight: 1.5, marginTop: 8 }}>
              {theme.subtitle}
            </div>
          </div>
          <button style={closeButtonStyle} onClick={onClose}>Close</button>
        </div>

        <div style={summaryGridStyle}>
          <div style={summaryCardStyle}>
            <div style={dialStyle(freshnessScore, theme.dial)}>
              <div style={dialInnerStyle}>
                <div style={dialValueStyle}>{freshnessScore}%</div>
                <div style={dialLabelStyle}>fresh</div>
              </div>
            </div>
            <div>
              <div style={metricTitleStyle}>Live Freshness</div>
              <div style={metricValueStyle}>{summary?.tracked ?? 0} tracked</div>
              <div style={metricSubtleStyle}>{summary?.fresh ?? 0} fresh, {summary?.stale ?? 0} stale</div>
            </div>
          </div>

          <div style={summaryCardStyle}>
            <div style={dialStyle(feedReadiness, theme.accent)}>
              <div style={dialInnerStyle}>
                <div style={dialValueStyle}>{summary?.feeds ?? 0}</div>
                <div style={dialLabelStyle}>feeds</div>
              </div>
            </div>
            <div>
              <div style={metricTitleStyle}>Feed Readiness</div>
              <div style={metricValueStyle}>{summary?.events_1h ?? 0} events / 1h</div>
              <div style={metricSubtleStyle}>{summary?.due_feeds ?? 0} due, last seen {formatRelative(summary?.latest_seen ?? null)}</div>
            </div>
          </div>

          <div style={{ ...summaryCardStyle, alignItems: 'stretch' }}>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10, width: '100%' }}>
              <div>
                <div style={metricTitleStyle}>Operational Mix</div>
                <div style={statusRowStyle}>
                  {classifications.slice(0, 5).map((item) => (
                    <div key={item.label} style={statusPillStyle(theme.accent)}>
                      <span>{item.label}</span>
                      <strong>{item.count}</strong>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <div>
                  <div style={miniLabelStyle}>{theme.avgMetricLabel}</div>
                  <div style={miniValueStyle}>{theme.avgMetricFormat(domain === 'Air' ? summary?.avg_altitude_m ?? null : summary?.avg_speed_mps ?? null)}</div>
                </div>
                <div>
                  <div style={miniLabelStyle}>24h activity</div>
                  <div style={miniValueStyle}>{summary?.events_24h?.toLocaleString() ?? 0}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style={tableWrapStyle}>
          {loading && <div style={emptyStateStyle}>Loading {domain.toLowerCase()} source status…</div>}
          {error && !loading && <div style={emptyStateStyle}>Status failed: {error}</div>}
          {!loading && !error && feeds.length === 0 && <div style={emptyStateStyle}>No {domain.toLowerCase()} source data available yet.</div>}
          {!loading && !error && feeds.length > 0 && (
            <div style={cardsGridStyle}>
              {feeds.map((feed) => {
                const healthColor = HEALTH_COLORS[feed.health] ?? '#94a3b8'
                const classEntries = Object.entries(feed.classifications).sort((a, b) => b[1] - a[1]).slice(0, 4)
                return (
                  <article key={feed.feed} style={feedCardStyle(healthColor)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={watchTitleStyle}>{theme.icon} {feed.feed}</div>
                        <div style={watchMetaStyle}>
                          latest {formatRelative(feed.latest_seen)} · {feed.asset_count.toLocaleString()} assets
                        </div>
                      </div>
                      <div style={priorityBadgeStyle(healthColor)}>{feed.health}</div>
                    </div>

                    <div style={watchStatsStripStyle}>
                      <div>
                        <div style={miniLabelStyle}>Fresh</div>
                        <div style={miniValueStyle}>{feed.fresh_assets}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>Stale</div>
                        <div style={miniValueStyle}>{feed.stale_assets}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>1h events</div>
                        <div style={miniValueStyle}>{feed.events_1h.toLocaleString()}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>1h active</div>
                        <div style={miniValueStyle}>{feed.active_tracks_1h.toLocaleString()}</div>
                      </div>
                    </div>

                    {feed.bincraft && (
                      <div style={bincraftStripStyle}>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.18em', color: '#38bdf8', marginBottom: 8 }}>
                          ◈ binCraft signal quality (1h)
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                          <div>
                            <div style={miniLabelStyle}>avg receivers</div>
                            <div style={{ ...miniValueStyle, color: '#38bdf8' }}>
                              {feed.bincraft.avg_receiver_count != null ? feed.bincraft.avg_receiver_count.toFixed(1) : '—'}
                            </div>
                          </div>
                          <div>
                            <div style={miniLabelStyle}>avg RSSI</div>
                            <div style={{ ...miniValueStyle, color: feed.bincraft.avg_rssi != null && feed.bincraft.avg_rssi > -20 ? '#34d399' : '#f59e0b' }}>
                              {feed.bincraft.avg_rssi != null ? `${feed.bincraft.avg_rssi.toFixed(1)} dB` : '—'}
                            </div>
                          </div>
                          <div>
                            <div style={miniLabelStyle}>dominant mode</div>
                            <div style={{ ...miniValueStyle, fontSize: 11, color: '#94a3b8' }}>
                              {feed.bincraft.dominant_surveillance_type ?? '—'}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    <div style={sourceGridStyle}>
                      {classEntries.map(([label, count]) => (
                        <div key={label} style={classificationBadgeStyle(theme.accent)}>
                          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.16em', color: '#cbd5e1' }}>{label}</div>
                          <div style={{ marginTop: 6, fontSize: 16, fontWeight: 800, color: '#f8fafc' }}>{count}</div>
                        </div>
                      ))}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 40,
  background: 'rgba(2, 6, 23, 0.74)',
  backdropFilter: 'blur(14px)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '88px 20px 24px',
  boxSizing: 'border-box',
}

const panelStyle = (accent: string, accentSoft: string): React.CSSProperties => ({
  width: 'min(1180px, 100%)',
  maxHeight: 'calc(100vh - 120px)',
  overflow: 'auto',
  borderRadius: 28,
  border: '1px solid rgba(148,163,184,0.18)',
  background: `radial-gradient(circle at top left, ${accent}22, transparent 34%), radial-gradient(circle at top right, ${accentSoft}2c, transparent 28%), linear-gradient(180deg, rgba(15,23,42,0.98), rgba(2,6,23,0.98))`,
  boxShadow: '0 30px 120px rgba(0,0,0,0.55)',
  padding: 24,
  boxSizing: 'border-box',
})

const heroStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 20,
  alignItems: 'flex-start',
}

const closeButtonStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 12,
  border: '1px solid rgba(148,163,184,0.22)',
  background: 'rgba(15,23,42,0.68)',
  color: '#f8fafc',
  cursor: 'pointer',
}

const summaryGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 16,
  marginTop: 22,
}

const summaryCardStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 18,
  minHeight: 124,
  borderRadius: 24,
  padding: 18,
  background: 'rgba(15,23,42,0.7)',
  border: '1px solid rgba(148,163,184,0.14)',
}

const dialInnerStyle: React.CSSProperties = {
  width: 60,
  height: 60,
  borderRadius: '50%',
  background: 'rgba(2,6,23,0.94)',
  display: 'grid',
  placeItems: 'center',
  textAlign: 'center',
}

const dialValueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#f8fafc',
  lineHeight: 1,
}

const dialLabelStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.18em',
  color: '#94a3b8',
}

const metricTitleStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.18em',
  color: '#64748b',
}

const metricValueStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 800,
  color: '#f8fafc',
  marginTop: 6,
}

const metricSubtleStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#cbd5e1',
  marginTop: 6,
}

const statusRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  marginTop: 12,
}

const statusPillStyle = (color: string): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 999,
  border: `1px solid ${color}55`,
  background: `${color}18`,
  color: '#e2e8f0',
  fontSize: 12,
})

const tableWrapStyle: React.CSSProperties = {
  marginTop: 18,
}

const cardsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: 16,
}

const feedCardStyle = (color: string): React.CSSProperties => ({
  padding: 18,
  borderRadius: 22,
  background: 'linear-gradient(180deg, rgba(15,23,42,0.9), rgba(15,23,42,0.66))',
  border: `1px solid ${color}44`,
  boxShadow: `inset 0 1px 0 rgba(255,255,255,0.03), 0 20px 50px ${color}12`,
})

const watchTitleStyle: React.CSSProperties = {
  fontSize: 19,
  fontWeight: 800,
  color: '#f8fafc',
}

const watchMetaStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: '#94a3b8',
}

const priorityBadgeStyle = (color: string): React.CSSProperties => ({
  alignSelf: 'flex-start',
  padding: '6px 9px',
  borderRadius: 999,
  border: `1px solid ${color}44`,
  background: `${color}18`,
  color,
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
})

const watchStatsStripStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 10,
  marginTop: 14,
  padding: 12,
  borderRadius: 16,
  background: 'rgba(2,6,23,0.46)',
}

const miniLabelStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.16em',
  color: '#64748b',
}

const miniValueStyle: React.CSSProperties = {
  marginTop: 5,
  fontSize: 14,
  fontWeight: 700,
  color: '#f8fafc',
}

const sourceGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: 10,
  marginTop: 14,
}

const classificationBadgeStyle = (accent: string): React.CSSProperties => ({
  padding: '10px 12px',
  borderRadius: 12,
  background: `${accent}12`,
  border: `1px solid ${accent}33`,
})

const bincraftStripStyle: React.CSSProperties = {
  marginTop: 12,
  padding: '10px 12px',
  borderRadius: 12,
  background: 'rgba(56,189,248,0.06)',
  border: '1px solid rgba(56,189,248,0.18)',
}

const emptyStateStyle: React.CSSProperties = {
  padding: 32,
  borderRadius: 18,
  textAlign: 'center',
  color: '#cbd5e1',
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(15,23,42,0.62)',
}

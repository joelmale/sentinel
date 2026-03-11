import { useEffect } from 'react'

type SourceSummary = {
  source_feed: string
  total_events: number
  active_events: number
  avg_trust: number | null
  avg_confidence: number | null
  avg_severity: number | null
  latest_seen: string | null
  age_minutes: number | null
}

type RecentEvent = {
  id: string
  source_feed: string
  external_event_id: string
  track_id: string | null
  title: string | null
  event_type: string
  category: string
  status: string
  severity: number | null
  confidence: number | null
  source_trust_score: number | null
  affected_assets_count: number | null
  first_seen: string
  last_seen: string
  metadata: Record<string, unknown>
}

type Summary = {
  total_events: number
  active_events: number
  resolved_events: number
  avg_trust: number | null
  avg_confidence: number | null
  avg_severity: number | null
  latest_seen: string | null
  impacted_assets: number
}

export type DisruptionDashboardPayload = {
  domain: 'GPS' | 'Infra'
  generated_at: string
  hours: number
  summary: Summary
  sources: SourceSummary[]
  categories: Array<{ label: string; count: number }>
  recent_events: RecentEvent[]
}

type Props = {
  open: boolean
  loading: boolean
  error: string | null
  domain: 'GPS' | 'Infra'
  data?: DisruptionDashboardPayload
  onClose: () => void
}

const THEME = {
  GPS: {
    eyebrow: 'GPS Ops',
    title: 'Interference Disruption Status',
    subtitle: 'GPSJam heat cells, confidence, and ADS-B thinning correlation for live jamming posture.',
    accent: '#f87171',
    accentSoft: '#7f1d1d',
    icon: '📡',
  },
  Infra: {
    eyebrow: 'Infra Ops',
    title: 'Infrastructure Disruption Status',
    subtitle: 'Connectivity, power, conflict, and utility telemetry normalized into one incident layer.',
    accent: '#f59e0b',
    accentSoft: '#78350f',
    icon: '🌐',
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

export function DisruptionDashboard({ open, loading, error, domain, data, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const theme = THEME[domain]
  const summary = data?.summary
  const sources = data?.sources ?? []
  const recentEvents = data?.recent_events ?? []
  const categoryMix = data?.categories ?? []
  const readiness = summary?.avg_confidence ? Math.round(summary.avg_confidence * 100) : 0
  const trust = summary?.avg_trust ? Math.round(summary.avg_trust * 100) : 0

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
            <div style={dialStyle(readiness, theme.accent)}>
              <div style={dialInnerStyle}>
                <div style={dialValueStyle}>{readiness}%</div>
                <div style={dialLabelStyle}>conf</div>
              </div>
            </div>
            <div>
              <div style={metricTitleStyle}>Incident Confidence</div>
              <div style={metricValueStyle}>{summary?.active_events ?? 0} active</div>
              <div style={metricSubtleStyle}>{summary?.resolved_events ?? 0} resolved, seen {formatRelative(summary?.latest_seen ?? null)}</div>
            </div>
          </div>

          <div style={summaryCardStyle}>
            <div style={dialStyle(trust, '#38bdf8')}>
              <div style={dialInnerStyle}>
                <div style={dialValueStyle}>{trust}%</div>
                <div style={dialLabelStyle}>trust</div>
              </div>
            </div>
            <div>
              <div style={metricTitleStyle}>Source Posture</div>
              <div style={metricValueStyle}>{summary?.total_events ?? 0} events</div>
              <div style={metricSubtleStyle}>{summary?.impacted_assets ?? 0} impacted assets</div>
            </div>
          </div>

          <div style={{ ...summaryCardStyle, alignItems: 'stretch' }}>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10, width: '100%' }}>
              <div>
                <div style={metricTitleStyle}>Category Mix</div>
                <div style={statusRowStyle}>
                  {categoryMix.slice(0, 6).map((item) => (
                    <div key={item.label} style={statusPillStyle(theme.accent)}>
                      <span>{item.label}</span>
                      <strong>{item.count}</strong>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <div>
                  <div style={miniLabelStyle}>avg severity</div>
                  <div style={miniValueStyle}>{summary?.avg_severity?.toFixed(1) ?? 'n/a'}</div>
                </div>
                <div>
                  <div style={miniLabelStyle}>sources</div>
                  <div style={miniValueStyle}>{sources.length}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style={tableWrapStyle}>
          {loading && <div style={emptyStateStyle}>Loading disruption posture…</div>}
          {error && !loading && <div style={emptyStateStyle}>Dashboard failed: {error}</div>}
          {!loading && !error && (
            <>
              <div style={cardsGridStyle}>
                {sources.map((source) => (
                  <article key={source.source_feed} style={sourceCardStyle(theme.accent)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={watchTitleStyle}>{theme.icon} {source.source_feed}</div>
                        <div style={watchMetaStyle}>latest {formatRelative(source.latest_seen)} · {source.total_events} events</div>
                      </div>
                      <div style={priorityBadgeStyle(theme.accent)}>
                        {source.active_events} active
                      </div>
                    </div>
                    <div style={watchStatsStripStyle}>
                      <div>
                        <div style={miniLabelStyle}>trust</div>
                        <div style={miniValueStyle}>{source.avg_trust != null ? `${Math.round(source.avg_trust * 100)}%` : 'n/a'}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>confidence</div>
                        <div style={miniValueStyle}>{source.avg_confidence != null ? `${Math.round(source.avg_confidence * 100)}%` : 'n/a'}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>severity</div>
                        <div style={miniValueStyle}>{source.avg_severity?.toFixed(1) ?? 'n/a'}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>age</div>
                        <div style={miniValueStyle}>{formatAge(source.age_minutes)}</div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>

              <div style={{ ...metricTitleStyle, marginTop: 22, marginBottom: 10 }}>Recent Events</div>
              <div style={eventGridStyle}>
                {recentEvents.map((event) => (
                  <article key={event.id} style={eventCardStyle}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#f8fafc' }}>
                        {event.title || event.external_event_id}
                      </div>
                      <div style={priorityBadgeStyle(theme.accent)}>
                        {event.status}
                      </div>
                    </div>
                    <div style={watchMetaStyle}>
                      {event.source_feed} · {event.category} · {formatRelative(event.last_seen)}
                    </div>
                    <div style={watchStatsStripStyle}>
                      <div>
                        <div style={miniLabelStyle}>severity</div>
                        <div style={miniValueStyle}>{event.severity?.toFixed(1) ?? 'n/a'}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>confidence</div>
                        <div style={miniValueStyle}>{event.confidence != null ? `${Math.round(event.confidence * 100)}%` : 'n/a'}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>trust</div>
                        <div style={miniValueStyle}>{event.source_trust_score != null ? `${Math.round(event.source_trust_score * 100)}%` : 'n/a'}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>affected</div>
                        <div style={miniValueStyle}>{event.affected_assets_count ?? 0}</div>
                      </div>
                    </div>
                    {typeof event.metadata?.adsb_thinning_ratio === 'number' && (
                      <div style={{ marginTop: 8, fontSize: 12, color: '#fca5a5' }}>
                        ADS-B thinning ratio {(event.metadata.adsb_thinning_ratio as number).toFixed(2)}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </>
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
  alignItems: 'flex-start',
  gap: 20,
  marginBottom: 24,
}

const closeButtonStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 12,
  border: '1px solid rgba(148,163,184,0.24)',
  background: 'rgba(15,23,42,0.78)',
  color: '#f8fafc',
  cursor: 'pointer',
}

const summaryGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 16,
}

const summaryCardStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: 18,
  borderRadius: 20,
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(15,23,42,0.7)',
}

const dialInnerStyle: React.CSSProperties = {
  width: 62,
  height: 62,
  borderRadius: '50%',
  background: 'rgba(15,23,42,0.92)',
  display: 'grid',
  placeItems: 'center',
}

const dialValueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: '#f8fafc',
}

const dialLabelStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color: '#94a3b8',
}

const metricTitleStyle: React.CSSProperties = {
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.16em',
  color: '#94a3b8',
}

const metricValueStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 24,
  fontWeight: 800,
  color: '#f8fafc',
}

const metricSubtleStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: '#cbd5e1',
}

const statusRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  marginTop: 10,
}

const statusPillStyle = (accent: string): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderRadius: 999,
  border: `1px solid ${accent}55`,
  background: `${accent}22`,
  color: '#e2e8f0',
  fontSize: 12,
})

const miniLabelStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color: '#94a3b8',
}

const miniValueStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 16,
  fontWeight: 800,
  color: '#f8fafc',
}

const tableWrapStyle: React.CSSProperties = {
  marginTop: 22,
}

const emptyStateStyle: React.CSSProperties = {
  padding: 18,
  borderRadius: 16,
  border: '1px dashed rgba(148,163,184,0.22)',
  color: '#cbd5e1',
  background: 'rgba(15,23,42,0.48)',
}

const cardsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 14,
}

const sourceCardStyle = (accent: string): React.CSSProperties => ({
  padding: 16,
  borderRadius: 18,
  border: `1px solid ${accent}44`,
  background: 'rgba(15,23,42,0.72)',
})

const eventGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 12,
}

const eventCardStyle: React.CSSProperties = {
  padding: 16,
  borderRadius: 18,
  border: '1px solid rgba(148,163,184,0.18)',
  background: 'rgba(15,23,42,0.72)',
}

const watchTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: '#f8fafc',
}

const watchMetaStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: '#94a3b8',
}

const priorityBadgeStyle = (accent: string): React.CSSProperties => ({
  padding: '6px 10px',
  borderRadius: 999,
  border: `1px solid ${accent}55`,
  background: `${accent}22`,
  color: '#f8fafc',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  height: 'fit-content',
})

const watchStatsStripStyle: React.CSSProperties = {
  marginTop: 14,
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 10,
}

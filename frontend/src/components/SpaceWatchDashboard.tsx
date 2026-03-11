import { useEffect } from 'react'

type WatchSourceStatus = {
  enabled: boolean
  due: boolean
  refresh_hours: number
  last_attempt: string | null
  last_success: string | null
  last_error: string | null
}

type WatchItem = {
  watch_id: string
  label: string
  priority: string
  enabled: boolean
  norad_id: number | null
  satnogs_sat_id: string | null
  desired_sources: string[]
  notes: string | null
  current_name: string | null
  in_catalog: boolean
  active_track: boolean
  current_tle_source: string | null
  tle_epoch: string | null
  tle_age_minutes: number | null
  last_track_seen: string | null
  health_status: string
  source_status: Record<string, WatchSourceStatus>
  metadata: Record<string, unknown>
  updated_at: string | null
}

type WatchSummary = {
  count: number
  healthy: number
  tracking: number
  degraded: number
  stale: number
  missing: number
  idle: number
  due_sources: number
}

export type SpaceWatchDashboardPayload = {
  summary: WatchSummary
  items: WatchItem[]
}

type Props = {
  open: boolean
  loading: boolean
  error: string | null
  data?: SpaceWatchDashboardPayload
  onClose: () => void
}

const HEALTH_COLORS: Record<string, string> = {
  healthy: '#34d399',
  tracking: '#38bdf8',
  degraded: '#f59e0b',
  stale: '#f97316',
  missing: '#ef4444',
  idle: '#94a3b8',
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#fb7185',
  high: '#f59e0b',
  medium: '#38bdf8',
  low: '#94a3b8',
}

function formatAge(minutes: number | null): string {
  if (minutes == null) return 'No TLE'
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`
  return `${(minutes / 1440).toFixed(1)}d`
}

function formatRelative(timestamp: string | null): string {
  if (!timestamp) return 'Never'
  const dt = new Date(timestamp)
  const deltaMinutes = (Date.now() - dt.getTime()) / 60000
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

function sourceBadgeStyle(status: WatchSourceStatus): React.CSSProperties {
  const border = status.last_error
    ? 'rgba(248,113,113,0.45)'
    : status.due
      ? 'rgba(245,158,11,0.45)'
      : 'rgba(52,211,153,0.35)'
  const background = status.last_error
    ? 'rgba(127,29,29,0.4)'
    : status.due
      ? 'rgba(120,53,15,0.42)'
      : 'rgba(6,78,59,0.36)'
  return {
    padding: '6px 8px',
    borderRadius: 10,
    border: `1px solid ${border}`,
    background,
  }
}

export function SpaceWatchDashboard({ open, loading, error, data, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const summary = data?.summary
  const items = data?.items ?? []
  const freshnessScore = summary && summary.count > 0
    ? Math.round(((summary.healthy + summary.tracking) / summary.count) * 100)
    : 0
  const dueScore = summary && summary.count > 0
    ? Math.max(0, 100 - Math.round((summary.due_sources / Math.max(summary.count * 2, 1)) * 100))
    : 0

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(event) => event.stopPropagation()}>
        <div style={heroStyle}>
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.24em', color: '#7dd3fc' }}>
              Space Watch
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#f8fafc', marginTop: 6 }}>
              Curated Orbit Status
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1', maxWidth: 520, lineHeight: 1.5, marginTop: 8 }}>
              Slow-refresh watchlist for N2YO and SatNOGS enrichment. Backend only, rate-budgeted, and designed for always-on collection.
            </div>
          </div>
          <button style={closeButtonStyle} onClick={onClose}>Close</button>
        </div>

        <div style={summaryGridStyle}>
          <div style={summaryCardStyle}>
            <div style={dialStyle(freshnessScore, '#a855f7')}>
              <div style={dialInnerStyle}>
                <div style={dialValueStyle}>{freshnessScore}%</div>
                <div style={dialLabelStyle}>fresh</div>
              </div>
            </div>
            <div>
              <div style={metricTitleStyle}>Fleet Readiness</div>
              <div style={metricValueStyle}>{summary?.healthy ?? 0} healthy</div>
              <div style={metricSubtleStyle}>{summary?.tracking ?? 0} tracking, {summary?.stale ?? 0} stale</div>
            </div>
          </div>

          <div style={summaryCardStyle}>
            <div style={dialStyle(dueScore, '#22c55e')}>
              <div style={dialInnerStyle}>
                <div style={dialValueStyle}>{summary?.due_sources ?? 0}</div>
                <div style={dialLabelStyle}>due</div>
              </div>
            </div>
            <div>
              <div style={metricTitleStyle}>Refresh Budget</div>
              <div style={metricValueStyle}>{summary?.count ?? 0} watched</div>
              <div style={metricSubtleStyle}>{summary?.degraded ?? 0} degraded, {summary?.missing ?? 0} missing</div>
            </div>
          </div>

          <div style={{ ...summaryCardStyle, justifyContent: 'space-between' }}>
            <div>
              <div style={metricTitleStyle}>Status Mix</div>
              <div style={statusRowStyle}>
                {Object.entries(HEALTH_COLORS).map(([key, color]) => (
                  <div key={key} style={statusPillStyle(color)}>
                    <span>{key}</span>
                    <strong>{summary ? summary[key as keyof WatchSummary] ?? 0 : 0}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div style={tableWrapStyle}>
          {loading && <div style={emptyStateStyle}>Loading watchlist status…</div>}
          {error && !loading && <div style={emptyStateStyle}>Watchlist status failed: {error}</div>}
          {!loading && !error && items.length === 0 && <div style={emptyStateStyle}>No watchlist entries configured yet.</div>}
          {!loading && !error && items.length > 0 && (
            <div style={cardsGridStyle}>
              {items.map((item) => {
                const healthColor = HEALTH_COLORS[item.health_status] ?? '#94a3b8'
                const priorityColor = PRIORITY_COLORS[item.priority] ?? '#94a3b8'
                return (
                  <article key={item.watch_id} style={watchCardStyle(healthColor)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={watchTitleStyle}>{item.label}</div>
                        <div style={watchMetaStyle}>
                          {item.current_name || item.label}
                          {item.norad_id ? ` · NORAD ${item.norad_id}` : ''}
                        </div>
                      </div>
                      <div style={priorityBadgeStyle(priorityColor)}>{item.priority}</div>
                    </div>

                    <div style={watchStatsStripStyle}>
                      <div>
                        <div style={miniLabelStyle}>Health</div>
                        <div style={{ ...miniValueStyle, color: healthColor }}>{item.health_status}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>TLE Age</div>
                        <div style={miniValueStyle}>{formatAge(item.tle_age_minutes)}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>Track Seen</div>
                        <div style={miniValueStyle}>{formatRelative(item.last_track_seen)}</div>
                      </div>
                      <div>
                        <div style={miniLabelStyle}>Primary</div>
                        <div style={miniValueStyle}>{item.current_tle_source ?? 'n/a'}</div>
                      </div>
                    </div>

                    <div style={sourceGridStyle}>
                      {Object.entries(item.source_status).map(([source, status]) => (
                        <div key={source} style={sourceBadgeStyle(status)}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.16em', color: '#e2e8f0' }}>
                              {source}
                            </span>
                            <span style={{ fontSize: 11, color: status.last_error ? '#fca5a5' : status.due ? '#fcd34d' : '#86efac' }}>
                              {status.last_error ? 'error' : status.due ? 'due' : 'ready'}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 6 }}>
                            refresh {status.refresh_hours}h
                          </div>
                          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                            success {formatRelative(status.last_success)}
                          </div>
                          {status.last_error && (
                            <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 6, lineHeight: 1.35 }}>
                              {status.last_error}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {item.notes && <div style={watchNotesStyle}>{item.notes}</div>}
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

const panelStyle: React.CSSProperties = {
  width: 'min(1180px, 100%)',
  maxHeight: 'calc(100vh - 120px)',
  overflow: 'auto',
  borderRadius: 28,
  border: '1px solid rgba(148,163,184,0.18)',
  background: 'radial-gradient(circle at top left, rgba(56,189,248,0.2), transparent 32%), radial-gradient(circle at top right, rgba(168,85,247,0.18), transparent 28%), linear-gradient(180deg, rgba(15,23,42,0.98), rgba(2,6,23,0.98))',
  boxShadow: '0 30px 120px rgba(0,0,0,0.55)',
  padding: 24,
  boxSizing: 'border-box',
}

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

const watchCardStyle = (color: string): React.CSSProperties => ({
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
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 10,
  marginTop: 14,
}

const watchNotesStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 12,
  lineHeight: 1.5,
  color: '#cbd5e1',
}

const emptyStateStyle: React.CSSProperties = {
  padding: 32,
  borderRadius: 18,
  textAlign: 'center',
  color: '#cbd5e1',
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(15,23,42,0.62)',
}

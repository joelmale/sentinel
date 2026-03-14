import type { CSSProperties } from 'react'
import type { OverviewDashboardResponse, OverviewDomainSummary } from '@/types/track'

const domainColors: Record<OverviewDomainSummary['domain'], string> = {
  Air: '#60a5fa',
  Maritime: '#22d3ee',
  Space: '#c084fc',
  GPS: '#f87171',
  Infra: '#f59e0b',
}

const domainIcons: Record<OverviewDomainSummary['domain'], string> = {
  Air: '✈',
  Maritime: '⚓',
  Space: '🛰',
  GPS: '📡',
  Infra: '🌐',
}

type OverviewPageProps = {
  dashboard: OverviewDashboardResponse | undefined
  loading: boolean
  error: string | null
  onOpenMap: () => void
  onOpenTable: () => void
}

export function OverviewPage({ dashboard, loading, error, onOpenMap, onOpenTable }: OverviewPageProps) {
  const domains = dashboard?.summary.domains ?? []
  const alerts = dashboard?.header.alerts
  const ingest = dashboard?.header.ingest

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        paddingTop: 88,
        paddingLeft: 24,
        paddingRight: 24,
        paddingBottom: 24,
        overflow: 'auto',
        background: 'radial-gradient(circle at top, rgba(30,41,59,0.42), rgba(2,6,23,0.98) 58%)',
        zIndex: 2,
      }}
    >
      <div style={{ maxWidth: 1520, margin: '0 auto', display: 'grid', gap: 18 }}>
        <section style={heroSectionStyle}>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={heroEyebrowStyle}>Operations Overview</div>
            <div style={heroTitleStyle}>Start from mission status, not a full-world map render.</div>
            <div style={heroBodyStyle}>
              Sentinel loads the alert queue, domain health, and current operating picture first.
              Open the map only when you need geographic confirmation.
            </div>
          </div>
          <div style={{ display: 'grid', gap: 10, justifyItems: 'stretch', minWidth: 280 }}>
            <button type="button" style={primaryActionStyle} onClick={onOpenMap}>
              Open Map Workspace
            </button>
            <button type="button" style={secondaryActionStyle} onClick={onOpenTable}>
              Open Track Browser
            </button>
          </div>
        </section>

        <section style={summaryStripStyle}>
          <div style={summaryStatStyle}>
            <span style={summaryStatLabelStyle}>Active Alerts</span>
            <span style={summaryStatValueStyle}>{alerts?.active ?? 0}</span>
            <span style={summaryStatMetaStyle}>
              {alerts?.critical ?? 0} critical · {alerts?.investigating ?? 0} investigating
            </span>
          </div>
          <div style={summaryStatStyle}>
            <span style={summaryStatLabelStyle}>Source Health</span>
            <span style={summaryStatValueStyle}>{ingest?.degraded_sources ?? 0}</span>
            <span style={summaryStatMetaStyle}>
              degraded · {ingest?.stale_sources ?? 0} stale
            </span>
          </div>
          <div style={summaryStatStyle}>
            <span style={summaryStatLabelStyle}>Landing Mode</span>
            <span style={summaryStatValueStyle}>Overview</span>
            <span style={summaryStatMetaStyle}>Summary-first cold start</span>
          </div>
        </section>

        <section style={{ display: 'grid', gap: 12 }}>
          <div style={sectionLabelStyle}>Domain Summary</div>
          {loading ? (
            <div style={messageCardStyle}>Loading domain overview…</div>
          ) : error ? (
            <div style={messageCardStyle}>Overview unavailable: {error}</div>
          ) : (
            <div style={domainGridStyle}>
              {domains.map((domain) => (
                <article key={domain.domain} style={domainCardStyle}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ display: 'grid', gap: 4 }}>
                      <span style={sectionLabelStyle}>{domain.domain}</span>
                      <span style={{ ...domainValueStyle, color: domainColors[domain.domain] }}>
                        {domain.live_count.toLocaleString()}
                      </span>
                      <span style={summaryStatMetaStyle}>
                        {domain.domain === 'GPS' ? 'Unique cells' : 'Unique tracks'} · {domain.freshness_window}
                      </span>
                    </div>
                    <span style={{ fontSize: 16 }}>{domainIcons[domain.domain]}</span>
                  </div>
                  <div style={domainMetaGridStyle}>
                    <div>
                      <div style={miniLabelStyle}>Active alerts</div>
                      <div style={miniValueStyle}>{domain.active_alerts}</div>
                    </div>
                    <div>
                      <div style={miniLabelStyle}>Degraded sources</div>
                      <div style={miniValueStyle}>{domain.degraded_sources}</div>
                    </div>
                    <div>
                      <div style={miniLabelStyle}>Stale hidden</div>
                      <div style={miniValueStyle}>{domain.stale_count.toLocaleString()}</div>
                    </div>
                    <div>
                      <div style={miniLabelStyle}>Recent delta</div>
                      <div style={miniValueStyle}>
                        {domain.top_change ? `${domain.top_change.delta >= 0 ? '+' : ''}${domain.top_change.delta}` : '0'}
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

const heroSectionStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.5fr) minmax(280px, 0.8fr)',
  gap: 18,
  padding: 20,
  borderRadius: 22,
  border: '1px solid rgba(148,163,184,0.18)',
  background: 'linear-gradient(145deg, rgba(15,23,42,0.96), rgba(15,23,42,0.82))',
  boxShadow: '0 24px 90px rgba(0,0,0,0.28)',
}

const heroEyebrowStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: '#5eead4',
}

const heroTitleStyle: CSSProperties = {
  fontSize: 28,
  lineHeight: 1.15,
  fontWeight: 700,
  color: '#f8fafc',
}

const heroBodyStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.65,
  color: '#cbd5e1',
  maxWidth: 720,
}

const primaryActionStyle: CSSProperties = {
  padding: '14px 16px',
  borderRadius: 14,
  border: '1px solid rgba(94,234,212,0.35)',
  background: 'rgba(20,184,166,0.16)',
  color: '#ccfbf1',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
}

const secondaryActionStyle: CSSProperties = {
  ...primaryActionStyle,
  border: '1px solid rgba(148,163,184,0.28)',
  background: 'rgba(30,41,59,0.68)',
  color: '#e2e8f0',
}

const summaryStripStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 12,
}

const summaryStatStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
  padding: '14px 16px',
  borderRadius: 16,
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(15,23,42,0.84)',
}

const summaryStatLabelStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#64748b',
}

const summaryStatValueStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  color: '#f8fafc',
}

const summaryStatMetaStyle: CSSProperties = {
  fontSize: 11,
  color: '#94a3b8',
}

const sectionLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#64748b',
}

const messageCardStyle: CSSProperties = {
  padding: '18px 20px',
  borderRadius: 16,
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(15,23,42,0.84)',
  color: '#cbd5e1',
  fontSize: 13,
}

const domainGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 12,
}

const domainCardStyle: CSSProperties = {
  display: 'grid',
  gap: 14,
  padding: '16px 16px 14px',
  borderRadius: 18,
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(15,23,42,0.84)',
}

const domainValueStyle: CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  lineHeight: 1,
}

const domainMetaGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
}

const miniLabelStyle: CSSProperties = {
  fontSize: 10,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
}

const miniValueStyle: CSSProperties = {
  marginTop: 2,
  fontSize: 14,
  fontWeight: 700,
  color: '#e2e8f0',
}

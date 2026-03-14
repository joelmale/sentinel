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
  const priorityItems = dashboard?.alerts.items ?? []
  const sourceHealth = dashboard?.ops.source_health ?? []
  const watchlist = dashboard?.ops.watchlist
  const disruptions = dashboard?.ops.disruptions ?? []
  const activity = dashboard?.activity.activity ?? []
  const topMovers = dashboard?.activity.top_movers ?? []
  const topAois = dashboard?.activity.top_aois ?? []
  const resumeSession = dashboard?.activity.resume_session

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

        <section style={threeColumnLayoutStyle}>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={sectionLabelStyle}>Priority Queue</div>
            <div style={panelShellStyle}>
              {loading ? (
                <div style={messageCardStyle}>Loading alerts…</div>
              ) : priorityItems.length === 0 ? (
                <div style={emptyPanelStyle}>No active alerts in the current operational window.</div>
              ) : (
                <div style={scrollListStyle}>
                  {priorityItems.map((item) => (
                    <article key={item.alert_id} style={alertRowStyle}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <span style={severityChipStyle(item.severity)}>{item.severity}</span>
                        <span style={miniMetaStyle}>{formatAge(item.triggered_at)}</span>
                      </div>
                      <div style={{ display: 'grid', gap: 4 }}>
                        <div style={alertTitleStyle}>{item.title}</div>
                        <div style={alertSubtitleStyle}>{item.subtitle ?? `${item.domain} alert`}</div>
                      </div>
                      <div style={alertWhyStyle}>
                        {(item.why ?? []).slice(0, 2).join(' · ') || 'Alert criteria met'}
                      </div>
                      <div style={alertFooterStyle}>
                        <span style={miniMetaStyle}>
                          {item.confidence != null ? `${Math.round(item.confidence * 100)}% confidence` : 'No confidence score'}
                        </span>
                        <button type="button" style={rowActionStyle} onClick={onOpenMap}>
                          Open map
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 12 }}>
            <div style={sectionLabelStyle}>Operational Status</div>
            <div style={panelShellStyle}>
              <div style={{ display: 'grid', gap: 16 }}>
                <section style={{ display: 'grid', gap: 8 }}>
                  <div style={subsectionLabelStyle}>Source Health</div>
                  {sourceHealth.length === 0 ? (
                    <div style={emptyPanelStyle}>No source health data returned.</div>
                  ) : (
                    <div style={scrollListStyle}>
                      {sourceHealth.slice(0, 8).map((item) => (
                        <div key={item.source_feed} style={statusRowStyle}>
                          <div style={{ display: 'grid', gap: 2 }}>
                            <span style={statusTitleStyle}>{item.source_feed}</span>
                            <span style={miniMetaStyle}>
                              {item.domain} · {item.lag_minutes != null ? `${Math.round(item.lag_minutes)} min lag` : 'No lag telemetry'}
                            </span>
                          </div>
                          <span style={healthBadgeStyle(item.health)}>{item.health}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section style={opsGridStyle}>
                  <article style={opsCardStyle}>
                    <div style={subsectionLabelStyle}>Watchlist</div>
                    <div style={opsValueStyle}>{watchlist?.priority_items ?? 0}</div>
                    <div style={miniMetaStyle}>
                      {(watchlist?.enabled ?? 0).toLocaleString()} enabled · {(watchlist?.active_tracks ?? 0).toLocaleString()} active tracks
                    </div>
                  </article>
                  {disruptions.map((item) => (
                    <article key={item.domain} style={opsCardStyle}>
                      <div style={subsectionLabelStyle}>{item.domain} Disruptions</div>
                      <div style={opsValueStyle}>{item.active_events.toLocaleString()}</div>
                      <div style={miniMetaStyle}>
                        {item.high_severity.toLocaleString()} high severity · {item.impacted_assets.toLocaleString()} impacted assets
                      </div>
                    </article>
                  ))}
                </section>
              </div>
            </div>
          </div>
        </section>

        <section style={{ display: 'grid', gap: 12 }}>
          <div style={sectionLabelStyle}>Fast Pivots</div>
          <div style={pivotGridStyle}>
            <article style={pivotCardStyle}>
              <div style={subsectionLabelStyle}>Activity</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {activity.length === 0 ? (
                  <div style={emptyPanelStyle}>No recent activity buckets available.</div>
                ) : (
                  activity.map((series) => (
                    <div key={series.domain} style={{ display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <span style={statusTitleStyle}>{series.domain}</span>
                        <span style={miniMetaStyle}>
                          {series.buckets.reduce((sum, bucket) => sum + bucket.count, 0).toLocaleString()} events
                        </span>
                      </div>
                      <div style={sparklineRowStyle}>
                        {series.buckets.map((bucket) => (
                          <span
                            key={`${series.domain}:${bucket.ts}`}
                            style={sparklineBarStyle(maxBucketCount(series.buckets), bucket.count, domainColors[series.domain])}
                            title={`${series.domain} · ${bucket.count.toLocaleString()} @ ${bucket.ts}`}
                          />
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </article>

            <article style={pivotCardStyle}>
              <div style={subsectionLabelStyle}>Top Movers</div>
              {topMovers.length === 0 ? (
                <div style={emptyPanelStyle}>No domain movers returned.</div>
              ) : (
                <div style={scrollListStyle}>
                  {topMovers.slice(0, 8).map((mover) => (
                    <div key={`${mover.domain}:${mover.label}`} style={statusRowStyle}>
                      <div style={{ display: 'grid', gap: 2 }}>
                        <span style={statusTitleStyle}>{mover.label}</span>
                        <span style={miniMetaStyle}>{mover.reason}</span>
                      </div>
                      <span style={{ ...opsValueStyle, fontSize: 16, color: mover.delta >= 0 ? '#5eead4' : '#fca5a5' }}>
                        {mover.delta >= 0 ? '+' : ''}{mover.delta}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </article>

            <article style={pivotCardStyle}>
              <div style={subsectionLabelStyle}>Top AOIs</div>
              {topAois.length === 0 ? (
                <div style={emptyPanelStyle}>No active AOIs are currently persisted.</div>
              ) : (
                <div style={scrollListStyle}>
                  {topAois.slice(0, 6).map((aoi) => (
                    <div key={aoi.id} style={statusRowStyle}>
                      <div style={{ display: 'grid', gap: 2 }}>
                        <span style={statusTitleStyle}>{aoi.name}</span>
                        <span style={miniMetaStyle}>{aoi.impacted_assets.toLocaleString()} impacted assets</span>
                      </div>
                      <span style={healthBadgeStyle(aoi.active_alerts > 0 ? 'stale' : 'healthy')}>
                        {aoi.active_alerts} alerts
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </article>

            <article style={pivotCardStyle}>
              <div style={subsectionLabelStyle}>Resume Session</div>
              {resumeSession ? (
                <div style={{ display: 'grid', gap: 10 }}>
                  <div>
                    <div style={statusTitleStyle}>{resumeSession.title}</div>
                    <div style={miniMetaStyle}>{resumeSession.domain} · updated {formatAge(resumeSession.updated_at)} ago</div>
                  </div>
                  <button type="button" style={primaryActionStyle} onClick={onOpenMap}>
                    Resume Investigation
                  </button>
                </div>
              ) : (
                <div style={emptyPanelStyle}>No resumable investigation is stored yet.</div>
              )}
              <button type="button" style={secondaryActionStyle} onClick={onOpenTable}>
                Open Analyst Browser
              </button>
            </article>
          </div>
        </section>
      </div>
    </div>
  )
}

function formatAge(timestamp: string): string {
  const ageMs = Date.now() - new Date(timestamp).getTime()
  if (!Number.isFinite(ageMs) || ageMs < 60_000) return 'Now'
  const ageMin = Math.round(ageMs / 60_000)
  if (ageMin < 60) return `${ageMin}m`
  const ageHours = Math.round(ageMin / 60)
  if (ageHours < 24) return `${ageHours}h`
  return `${Math.round(ageHours / 24)}d`
}

function maxBucketCount(buckets: Array<{ count: number }>): number {
  return Math.max(1, ...buckets.map((bucket) => bucket.count))
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

const threeColumnLayoutStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 0.9fr)',
  gap: 16,
  alignItems: 'start',
}

const panelShellStyle: CSSProperties = {
  padding: 14,
  borderRadius: 18,
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(15,23,42,0.84)',
  minHeight: 320,
}

const scrollListStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
  maxHeight: 380,
  overflowY: 'auto',
  paddingRight: 4,
}

const alertRowStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  padding: '12px 12px 10px',
  borderRadius: 14,
  border: '1px solid rgba(148,163,184,0.14)',
  background: 'rgba(2,6,23,0.42)',
}

const alertTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: '#f8fafc',
}

const alertSubtitleStyle: CSSProperties = {
  fontSize: 12,
  color: '#94a3b8',
}

const alertWhyStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: '#cbd5e1',
}

const alertFooterStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

const rowActionStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 9,
  border: '1px solid rgba(94,234,212,0.28)',
  background: 'rgba(20,184,166,0.14)',
  color: '#ccfbf1',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
}

const severityChipStyle = (severity: 'critical' | 'high' | 'medium' | 'low'): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '4px 7px',
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: severity === 'critical' ? '#fee2e2' : severity === 'high' ? '#fde68a' : severity === 'medium' ? '#bfdbfe' : '#cbd5e1',
  border: severity === 'critical'
    ? '1px solid rgba(239,68,68,0.35)'
    : severity === 'high'
      ? '1px solid rgba(245,158,11,0.35)'
      : severity === 'medium'
        ? '1px solid rgba(59,130,246,0.35)'
        : '1px solid rgba(148,163,184,0.28)',
  background: severity === 'critical'
    ? 'rgba(127,29,29,0.35)'
    : severity === 'high'
      ? 'rgba(120,53,15,0.32)'
      : severity === 'medium'
        ? 'rgba(30,64,175,0.26)'
        : 'rgba(30,41,59,0.55)',
})

const miniMetaStyle: CSSProperties = {
  fontSize: 11,
  color: '#94a3b8',
}

const emptyPanelStyle: CSSProperties = {
  padding: '18px 16px',
  borderRadius: 14,
  border: '1px dashed rgba(148,163,184,0.18)',
  color: '#94a3b8',
  fontSize: 12,
}

const subsectionLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: '#64748b',
}

const statusRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '10px 12px',
  borderRadius: 12,
  border: '1px solid rgba(148,163,184,0.14)',
  background: 'rgba(2,6,23,0.42)',
}

const statusTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#e2e8f0',
}

const healthBadgeStyle = (health: 'healthy' | 'stale' | 'degraded' | 'down'): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 72,
  padding: '5px 8px',
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  color: health === 'healthy' ? '#bbf7d0' : health === 'stale' ? '#fde68a' : '#fecaca',
  background: health === 'healthy'
    ? 'rgba(20,83,45,0.55)'
    : health === 'stale'
      ? 'rgba(120,53,15,0.45)'
      : 'rgba(127,29,29,0.45)',
  border: health === 'healthy'
    ? '1px solid rgba(34,197,94,0.28)'
    : health === 'stale'
      ? '1px solid rgba(245,158,11,0.28)'
      : '1px solid rgba(239,68,68,0.3)',
})

const opsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 10,
}

const opsCardStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  padding: '12px 12px 10px',
  borderRadius: 14,
  border: '1px solid rgba(148,163,184,0.14)',
  background: 'rgba(2,6,23,0.42)',
}

const opsValueStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  color: '#f8fafc',
}

const pivotGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 12,
}

const pivotCardStyle: CSSProperties = {
  display: 'grid',
  alignContent: 'start',
  gap: 12,
  padding: '14px 14px 12px',
  borderRadius: 18,
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(15,23,42,0.84)',
  minHeight: 220,
}

const sparklineRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
  alignItems: 'end',
  gap: 3,
  height: 46,
}

const sparklineBarStyle = (maxValue: number, value: number, color: string): CSSProperties => ({
  height: `${Math.max(12, Math.round((value / maxValue) * 100))}%`,
  borderRadius: 999,
  background: `linear-gradient(180deg, ${color}, rgba(15,23,42,0.9))`,
  boxShadow: `0 0 0 1px ${color}22 inset`,
})

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

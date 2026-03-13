import { format } from 'date-fns'
import { useMapStore } from '@/store/useMapStore'

function fmtUtc(iso: string): string {
  return `${format(new Date(iso), 'dd MMM yyyy · HH:mm:ss')} UTC`
}

function fmtWindow(start: Date, end: Date): string {
  return `${format(start, 'HH:mm')} - ${format(end, 'HH:mm')} UTC`
}

function severityLabel(domain: string, ruleName?: string): 'High' | 'Medium' {
  const normalized = ruleName?.toLowerCase() ?? ''
  if (domain === 'GPS' || normalized.includes('military') || normalized.includes('boundary')) {
    return 'High'
  }
  return 'Medium'
}

export function InvestigationPanel() {
  const {
    investigationContext,
    pendingAlerts,
    liveAssets,
    playback,
    assetCardOpen,
    openInvestigation,
    closeInvestigation,
  } = useMapStore()

  if (!investigationContext) return null

  const activeAlert = pendingAlerts.find((alert) => alert.alertId === investigationContext.alertId)
  const asset = liveAssets.get(`${investigationContext.domain}:${investigationContext.trackId}`)
  const severity = severityLabel(investigationContext.domain, investigationContext.ruleName)

  return (
    <aside
      style={{
        position: 'fixed',
        top: 88,
        right: assetCardOpen ? 352 : 12,
        width: 320,
        zIndex: 24,
        color: '#e2e8f0',
        background: 'rgba(10, 15, 30, 0.97)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
        boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
        backdropFilter: 'blur(16px)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '11px 14px',
          background: 'rgba(30,41,59,0.72)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        <span style={{ fontSize: 13 }}>Investigation</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: '#34d399',
          }}
        >
          Active
        </span>
      </div>

      <div style={{ padding: '14px 14px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#64748b', marginBottom: 4 }}>
            Trigger
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc', lineHeight: 1.35 }}>
            {investigationContext.ruleName ?? activeAlert?.ruleId ?? 'Alert'}
          </div>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span style={chipStyle('#38bdf8')}>{investigationContext.domain}</span>
            <span style={chipStyle(severity === 'High' ? '#f87171' : '#f59e0b')}>{severity}</span>
            {activeAlert && <span style={chipStyle('#34d399')}>{activeAlert.triage}</span>}
          </div>
        </div>

        <div style={gridStyle}>
          <div>
            <div style={labelStyle}>Track</div>
            <div style={monoValueStyle}>{investigationContext.trackId}</div>
          </div>
          <div>
            <div style={labelStyle}>Triggered</div>
            <div style={valueStyle}>{fmtUtc(investigationContext.triggeredAt)}</div>
          </div>
          <div>
            <div style={labelStyle}>Replay Window</div>
            <div style={valueStyle}>{fmtWindow(playback.timeWindow.start, playback.timeWindow.end)}</div>
          </div>
          <div>
            <div style={labelStyle}>Asset State</div>
            <div style={valueStyle}>
              {asset
                ? `Live${typeof asset.lon === 'number' && typeof asset.lat === 'number' ? ' · located' : ''}`
                : 'Not in live set'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {activeAlert && (
            <button style={primaryBtnStyle} onClick={() => openInvestigation(activeAlert)}>
              Re-focus Workspace
            </button>
          )}
          <button style={secondaryBtnStyle} onClick={closeInvestigation}>
            Clear Context
          </button>
        </div>
      </div>
    </aside>
  )
}

const chipStyle = (color: string): React.CSSProperties => ({
  fontSize: 9,
  fontWeight: 800,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color,
  background: `${color}1A`,
  border: `1px solid ${color}45`,
  borderRadius: 999,
  padding: '2px 8px',
})

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  gridTemplateColumns: '1fr',
}

const labelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: '#64748b',
  marginBottom: 3,
}

const valueStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#cbd5e1',
  lineHeight: 1.4,
}

const monoValueStyle: React.CSSProperties = {
  ...valueStyle,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

const primaryBtnStyle: React.CSSProperties = {
  flex: 1,
  border: '1px solid rgba(52,211,153,0.35)',
  background: 'rgba(16,185,129,0.16)',
  color: '#6ee7b7',
  borderRadius: 10,
  padding: '8px 10px',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
}

const secondaryBtnStyle: React.CSSProperties = {
  border: '1px solid rgba(100,116,139,0.35)',
  background: 'rgba(30,41,59,0.55)',
  color: '#cbd5e1',
  borderRadius: 10,
  padding: '8px 10px',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
}

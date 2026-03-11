/**
 * AlertQueuePanel — persistent right-side alert triage panel.
 *
 * Replaces the ephemeral toast-style AlertNotification with a proper
 * investigation workflow surface. Alerts are case objects, not pop-ups.
 *
 * Triage lifecycle:  new → investigating | acknowledged → closed
 *
 * Data sources:
 *   • Live alerts:       Zustand store (WebSocket push via addAlert)
 *   • Historical alerts: GET /api/alerts/events (polled on mount)
 *
 * Workspace pivot (Investigate button):
 *   Calls openInvestigation() which atomically:
 *     1. Flies map to track's last known position
 *     2. Opens the asset card
 *     3. Snaps timeline to ±30 min around the alert trigger
 *     4. Switches playback to replay at alert time
 *     5. Sets investigationContext in store (highlighted border)
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMapStore } from '@/store/useMapStore'
import type { AlertItem, AlertTriage } from '@/store/useMapStore'
import type { SourceDomain } from '@/types/track'

// ── Visual config ─────────────────────────────────────────────────

const DOMAIN_ICONS: Record<string, string> = {
  Air: '✈', Maritime: '⚓', Space: '🛰', GPS: '📡', Infra: '🌐',
}

const DOMAIN_COLORS: Record<string, string> = {
  Air: '#60a5fa', Maritime: '#22d3ee', Space: '#c084fc', GPS: '#f87171', Infra: '#f59e0b',
}

const TRIAGE_LABEL: Record<AlertTriage, string> = {
  new:          'NEW',
  acknowledged: 'ACK',
  investigating:'LIVE',
  closed:       'DONE',
}

const TRIAGE_COLOR: Record<AlertTriage, string> = {
  new:          '#f87171',
  acknowledged: '#fbbf24',
  investigating:'#34d399',
  closed:       '#475569',
}

// Severity derived from domain — GPS disruption and Military flag as HIGH
function getSeverity(alert: AlertItem): 'high' | 'medium' | 'low' {
  if (alert.domain === 'GPS') return 'high'
  if (alert.ruleName?.toLowerCase().includes('military')) return 'high'
  if (alert.ruleName?.toLowerCase().includes('exclusion') ||
      alert.ruleName?.toLowerCase().includes('boundary')) return 'high'
  return 'medium'
}

const SEV_COLOR: Record<string, string> = {
  high:   '#ef4444',
  medium: '#f59e0b',
  low:    '#60a5fa',
}

// ── Time helpers ──────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (sec < 60)   return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

// ── Sub-components ────────────────────────────────────────────────

function ActionBtn({
  label, color, onClick,
}: { label: string; color: string; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '3px 9px', borderRadius: 5, fontSize: 10,
        fontWeight: 700, letterSpacing: '0.06em', cursor: 'pointer',
        border: `1px solid ${color}60`,
        background: hover ? `${color}28` : `${color}12`,
        color: hover ? '#e2e8f0' : color,
        transition: 'all 0.12s',
      }}
    >
      {label}
    </button>
  )
}

function AlertRow({ alert, isActive, onInvestigate, onTriage }: {
  alert: AlertItem
  isActive: boolean
  onInvestigate: () => void
  onTriage: (t: AlertTriage) => void
}) {
  const sev = getSeverity(alert)
  const sevColor = SEV_COLOR[sev]
  const domColor = DOMAIN_COLORS[alert.domain] ?? '#94a3b8'

  return (
    <div style={{
      padding: '10px 14px',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
      borderLeft: isActive ? '2px solid #34d399' : '2px solid transparent',
      background: isActive ? 'rgba(52,211,153,0.05)' : 'transparent',
      transition: 'background 0.1s',
    }}>
      {/* Top row: severity dot · domain · time · triage badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: sevColor,
          boxShadow: alert.triage === 'new' ? `0 0 5px ${sevColor}` : 'none',
        }} />
        <span style={{ fontSize: 10, fontWeight: 700, color: domColor, letterSpacing: '0.06em' }}>
          {DOMAIN_ICONS[alert.domain]} {alert.domain}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: '#475569' }}>{timeAgo(alert.triggeredAt)}</span>
        <span style={{
          fontSize: 9, fontWeight: 800, letterSpacing: '0.12em',
          color: TRIAGE_COLOR[alert.triage],
          textTransform: 'uppercase',
        }}>
          {TRIAGE_LABEL[alert.triage]}
        </span>
      </div>

      {/* Rule name + track ID */}
      <div style={{ marginLeft: 14, marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: '#e2e8f0', fontWeight: 600, marginBottom: 2, lineHeight: 1.3 }}>
          {alert.ruleName ?? alert.ruleId}
        </div>
        <div style={{
          fontSize: 10, color: '#64748b',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}>
          {alert.trackId}
        </div>
      </div>

      {/* Action buttons */}
      {alert.triage !== 'closed' && (
        <div style={{ display: 'flex', gap: 6, marginLeft: 14, flexWrap: 'wrap' }}>
          {(alert.triage === 'new' || alert.triage === 'investigating') && (
            <ActionBtn
              label={alert.triage === 'investigating' ? 'Re-focus' : 'Investigate'}
              color="#34d399"
              onClick={onInvestigate}
            />
          )}
          {alert.triage === 'new' && (
            <ActionBtn label="Ack" color="#fbbf24" onClick={() => onTriage('acknowledged')} />
          )}
          {alert.triage === 'acknowledged' && (
            <ActionBtn label="Investigate" color="#34d399" onClick={onInvestigate} />
          )}
          <ActionBtn label="Close" color="#475569" onClick={() => onTriage('closed')} />
        </div>
      )}
    </div>
  )
}

// ── Tab pill ──────────────────────────────────────────────────────
function Tab({
  label, count, active, color, onClick,
}: { label: string; count: number; active: boolean; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: '6px 4px',
        border: 'none', background: 'none',
        borderBottom: active ? `2px solid ${color}` : '2px solid transparent',
        color: active ? '#e2e8f0' : '#475569',
        fontSize: 9, fontWeight: 700, letterSpacing: '0.09em',
        textTransform: 'uppercase', cursor: 'pointer',
        transition: 'color 0.12s',
        whiteSpace: 'nowrap',
      }}
    >
      {label} {count > 0 ? count : ''}
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────
export function AlertQueuePanel() {
  const {
    pendingAlerts,
    addAlert,
    triageAlert,
    investigationContext,
    openInvestigation,
    layers,
  } = useMapStore()

  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<'all' | AlertTriage>('all')
  const [historicalAlerts, setHistoricalAlerts] = useState<AlertItem[]>([])
  // Tick forces re-render for "time ago" labels every 30s
  const [tick, setTick] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Refresh time-ago labels every 30 seconds
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  // Fetch historical alert events from REST API (poll every 60s)
  const fetchHistory = () => {
    fetch('/api/alerts/events?limit=100')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{
        id: string; rule_id: string; track_id: string; domain: string
        status: string; triggered_at: string; rule_name?: string
      }>) => {
        const items: AlertItem[] = rows.map((r) => ({
          alertId:     r.id,
          ruleId:      r.rule_id,
          ruleName:    r.rule_name,
          trackId:     r.track_id,
          domain:      r.domain as SourceDomain,
          triggeredAt: r.triggered_at,
          // Map DB status → AlertTriage
          triage: (r.status === 'acknowledged' ? 'acknowledged'
                 : r.status === 'resolved'     ? 'closed'
                 : 'new') as AlertTriage,
        }))
        setHistoricalAlerts(items)
        // Also seed the store so tab counts reflect historical data
        items.forEach((item) => addAlert(item))
      })
      .catch(() => { /* network error — keep existing state */ })
  }

  useEffect(() => {
    fetchHistory()
    pollRef.current = setInterval(fetchHistory, 60_000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Merge live store alerts with historical, deduplicate by alertId,
  // newest first. Store alerts take precedence (they carry triage state).
  // Hidden domains are excluded — they represent a deliberate analyst decision
  // to suppress those tracks from their workspace.
  const allAlerts = useMemo(() => {
    void tick // subscribe to 30s refresh
    const map = new Map<string, AlertItem>()
    // Historical first (lowest precedence)
    for (const a of historicalAlerts) map.set(a.alertId, a)
    // Live store alerts override (carry latest triage state)
    for (const a of pendingAlerts) map.set(a.alertId, a)
    return Array.from(map.values())
      // Respect domain visibility — hidden domains are off the workspace
      .filter((a) => layers[a.domain as keyof typeof layers]?.visibility !== 'hidden')
      .sort(
        (a, b) => new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime()
      )
  }, [historicalAlerts, pendingAlerts, tick, layers])

  const counts = useMemo(() => ({
    all:          allAlerts.length,
    new:          allAlerts.filter((a) => a.triage === 'new').length,
    investigating:allAlerts.filter((a) => a.triage === 'investigating').length,
    acknowledged: allAlerts.filter((a) => a.triage === 'acknowledged').length,
    closed:       allAlerts.filter((a) => a.triage === 'closed').length,
  }), [allAlerts])

  const filtered = tab === 'all'
    ? allAlerts
    : allAlerts.filter((a) => a.triage === tab)

  // ── Collapsed button ─────────────────────────────────────────
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed', bottom: 182, right: 12, zIndex: 25,
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 14px', borderRadius: 12,
          background: counts.new > 0
            ? 'rgba(239,68,68,0.15)'
            : 'rgba(10,15,30,0.96)',
          border: `1px solid ${counts.new > 0 ? 'rgba(239,68,68,0.45)' : 'rgba(255,255,255,0.08)'}`,
          color: counts.new > 0 ? '#fca5a5' : '#94a3b8',
          fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
          cursor: 'pointer', backdropFilter: 'blur(12px)',
          boxShadow: counts.new > 0 ? '0 0 16px rgba(239,68,68,0.2)' : 'none',
        }}
      >
        🚨 ALERTS
        {counts.new > 0 && (
          <span style={{
            background: '#ef4444', color: 'white',
            borderRadius: 999, padding: '1px 8px', fontSize: 10, fontWeight: 800,
          }}>
            {counts.new}
          </span>
        )}
      </button>
    )
  }

  // ── Expanded panel ───────────────────────────────────────────
  return (
    <div style={{
      position: 'fixed', bottom: 182, right: 12, zIndex: 25,
      width: 340, maxHeight: 500,
      background: 'rgba(10, 15, 30, 0.97)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 16,
      backdropFilter: 'blur(16px)',
      boxShadow: '0 20px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden', color: 'white',
    }}>

      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        background: 'rgba(30,41,59,0.65)',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 14 }}>🚨</span>
        <span style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.15em',
          color: '#f87171', flex: 1,
        }}>
          ALERT QUEUE
        </span>
        {counts.new > 0 && (
          <span style={{
            background: '#ef4444', color: 'white',
            borderRadius: 999, padding: '1px 8px', fontSize: 10, fontWeight: 800,
          }}>
            {counts.new} NEW
          </span>
        )}
        {investigationContext && (
          <span style={{
            fontSize: 9, color: '#34d399', fontWeight: 700,
            letterSpacing: '0.1em', padding: '2px 7px',
            borderRadius: 4, border: '1px solid rgba(52,211,153,0.3)',
            background: 'rgba(52,211,153,0.08)',
          }}>
            INVESTIGATING
          </span>
        )}
        <button
          onClick={() => setOpen(false)}
          style={{
            background: 'none', border: 'none', color: '#475569',
            cursor: 'pointer', fontSize: 16, padding: '0 2px',
            lineHeight: 1, transition: 'color 0.12s',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#475569' }}
          title="Minimise"
        >
          −
        </button>
      </div>

      {/* ── Tab bar ── */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <Tab label="All"    count={counts.all}          active={tab === 'all'}          color="#60a5fa" onClick={() => setTab('all')} />
        <Tab label="New"    count={counts.new}          active={tab === 'new'}          color="#f87171" onClick={() => setTab('new')} />
        <Tab label="Active" count={counts.investigating} active={tab === 'investigating'} color="#34d399" onClick={() => setTab('investigating')} />
        <Tab label="Ack"    count={counts.acknowledged}  active={tab === 'acknowledged'}  color="#fbbf24" onClick={() => setTab('acknowledged')} />
        <Tab label="Done"   count={counts.closed}        active={tab === 'closed'}        color="#475569" onClick={() => setTab('closed')} />
      </div>

      {/* ── Alert list ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: '28px 16px', textAlign: 'center',
            color: '#334155', fontSize: 12,
          }}>
            {tab === 'all' ? 'No alerts yet — rules fire when tracks match conditions' : `No ${tab} alerts`}
          </div>
        ) : (
          filtered.map((alert) => (
            <AlertRow
              key={alert.alertId}
              alert={alert}
              isActive={investigationContext?.alertId === alert.alertId}
              onInvestigate={() => openInvestigation(alert)}
              onTriage={(t) => triageAlert(alert.alertId, t)}
            />
          ))
        )}
      </div>
    </div>
  )
}

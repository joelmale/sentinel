import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { useDrag } from '@/hooks/useDrag'
import { useMapStore } from '@/store/useMapStore'
import type { DisruptionEvent, SourceDomain, TrackEventProperties } from '@/types/track'

type AnnotationFeature = {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: {
    id: string
    label: string
    body?: string | null
    created_at: string
    linked_track_id?: string | null
    linked_domain?: string | null
  }
}

const DOMAIN_ICONS: Record<SourceDomain, string> = {
  Air: '✈',
  Maritime: '⚓',
  Space: '🛰',
  GPS: '📡',
  Infra: '🌐',
}

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

function distanceKm(a: TrackEventProperties, b: TrackEventProperties): number | null {
  if (
    typeof a.lon !== 'number' ||
    typeof a.lat !== 'number' ||
    typeof b.lon !== 'number' ||
    typeof b.lat !== 'number'
  ) {
    return null
  }

  const r = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * r * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

function bboxAround(asset: TrackEventProperties, degrees: number): string | null {
  if (typeof asset.lon !== 'number' || typeof asset.lat !== 'number') return null
  const minLon = Math.max(-180, asset.lon - degrees)
  const maxLon = Math.min(180, asset.lon + degrees)
  const minLat = Math.max(-90, asset.lat - degrees)
  const maxLat = Math.min(90, asset.lat + degrees)
  return `${minLon},${minLat},${maxLon},${maxLat}`
}

function DragDots({ dragRef, isDragging }: { dragRef: React.Ref<HTMLDivElement>; isDragging: boolean }) {
  return (
    <div
      ref={dragRef}
      title="Drag to move panel"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '3px',
        padding: '6px 8px',
        cursor: isDragging ? 'grabbing' : 'grab',
        flexShrink: 0,
        borderRadius: 6,
        background: 'transparent',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        const handle = e.currentTarget as HTMLDivElement
        handle.style.background = 'rgba(148,163,184,0.18)'
      }}
      onMouseLeave={(e) => {
        const handle = e.currentTarget as HTMLDivElement
        handle.style.background = 'transparent'
      }}
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{ width: 4, height: 4, borderRadius: '50%', background: '#64748b' }}
        />
      ))}
    </div>
  )
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
    setTimeWindow,
    setCurrentTime,
    setPlaybackMode,
    selectAsset,
    flyTo,
  } = useMapStore()
  const { offset, dragHandleRef, isDragging } = useDrag({
    storageKey: 'sentinel.investigationPanelPosition',
  })

  const [nearbyDisruptions, setNearbyDisruptions] = useState<DisruptionEvent[]>([])
  const [nearbyAnnotations, setNearbyAnnotations] = useState<AnnotationFeature[]>([])
  const [annotationDraft, setAnnotationDraft] = useState('')
  const [annotationSaving, setAnnotationSaving] = useState(false)

  const activeAlert = useMemo(
    () => pendingAlerts.find((alert) => alert.alertId === investigationContext?.alertId),
    [pendingAlerts, investigationContext]
  )

  const asset = useMemo(
    () => (investigationContext
      ? liveAssets.get(`${investigationContext.domain}:${investigationContext.trackId}`)
      : undefined),
    [investigationContext, liveAssets]
  )

  const severity = investigationContext
    ? severityLabel(investigationContext.domain, investigationContext.ruleName)
    : 'Medium'

  const nearbyAssets = useMemo(() => {
    if (!investigationContext || !asset) return []
    return Array.from(liveAssets.values())
      .filter((candidate) => `${candidate.source_domain}:${candidate.track_id}` !== `${investigationContext.domain}:${investigationContext.trackId}`)
      .map((candidate) => ({
        asset: candidate,
        distanceKm: distanceKm(asset, candidate),
      }))
      .filter((row) => row.distanceKm !== null && row.distanceKm <= 900)
      .sort((a, b) => (a.distanceKm as number) - (b.distanceKm as number))
      .slice(0, 6)
  }, [investigationContext, asset, liveAssets])

  useEffect(() => {
    if (!investigationContext) return
    if (!asset) {
      setNearbyDisruptions([])
      setNearbyAnnotations([])
      return
    }

    const disruptionBbox = bboxAround(asset, 8)
    const annotationBbox = bboxAround(asset, 3)
    const abort = new AbortController()

    const disruptionParams = new URLSearchParams({
      t_start: playback.timeWindow.start.toISOString(),
      t_end: playback.timeWindow.end.toISOString(),
      limit: '40',
    })
    if (disruptionBbox) disruptionParams.set('bbox', disruptionBbox)

    fetch(`/api/disruptions/events?${disruptionParams.toString()}`, { signal: abort.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => setNearbyDisruptions(payload?.items ?? []))
      .catch(() => {})

    if (annotationBbox) {
      fetch(`/api/annotations?bbox=${encodeURIComponent(annotationBbox)}`, { signal: abort.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((payload) => setNearbyAnnotations(payload?.features ?? []))
        .catch(() => {})
    } else {
      setNearbyAnnotations([])
    }

    return () => abort.abort()
  }, [investigationContext, asset, playback.timeWindow.start, playback.timeWindow.end])

  if (!investigationContext) return null

  const refocus = () => {
    if (activeAlert) openInvestigation(activeAlert)
    if (asset && typeof asset.lon === 'number' && typeof asset.lat === 'number') {
      flyTo(asset.lon, asset.lat, 9)
    }
  }

  const applyWindow = (mode: 'before' | 'during' | 'after') => {
    const trigger = new Date(investigationContext.triggeredAt)
    let start: Date
    let end: Date
    if (mode === 'before') {
      end = trigger
      start = new Date(trigger.getTime() - 30 * 60_000)
    } else if (mode === 'during') {
      start = new Date(trigger.getTime() - 15 * 60_000)
      end = new Date(trigger.getTime() + 15 * 60_000)
    } else {
      start = trigger
      end = new Date(trigger.getTime() + 30 * 60_000)
    }
    setTimeWindow({ start, end })
    setCurrentTime(trigger)
    setPlaybackMode('replay')
  }

  const saveNote = async () => {
    if (!asset || typeof asset.lon !== 'number' || typeof asset.lat !== 'number' || !annotationDraft.trim()) return
    setAnnotationSaving(true)
    try {
      await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lon: asset.lon,
          lat: asset.lat,
          label: investigationContext.ruleName ?? activeAlert?.ruleId ?? 'Investigation note',
          body: annotationDraft.trim(),
          linked_track_id: investigationContext.trackId,
          linked_domain: investigationContext.domain,
          linked_at: investigationContext.triggeredAt,
          created_by: 'analyst',
          tags: ['investigation'],
        }),
      })
      setAnnotationDraft('')
    } finally {
      setAnnotationSaving(false)
    }
  }

  return (
    <aside
      style={{
        position: 'fixed',
        top: 88,
        right: assetCardOpen ? 352 : 12,
        transform: `translate(${offset.x}px, ${offset.y}px)`,
        width: 340,
        maxHeight: 'calc(100vh - 120px)',
        zIndex: 24,
        color: '#e2e8f0',
        background: 'rgba(10, 15, 30, 0.97)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
        boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
        backdropFilter: 'blur(16px)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
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
        <DragDots dragRef={dragHandleRef} isDragging={isDragging} />
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

      <div style={{ padding: '14px 14px 12px', display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
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
            <span style={chipStyle('#94a3b8')}>asset {asset ? 'live' : 'stale'}</span>
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
            <div style={labelStyle}>Position</div>
            <div style={valueStyle}>
              {asset && typeof asset.lon === 'number' && typeof asset.lat === 'number'
                ? `${asset.lat.toFixed(2)}, ${asset.lon.toFixed(2)}`
                : 'Unavailable'}
            </div>
          </div>
        </div>

        <section style={panelSectionStyle}>
          <div style={sectionTitleStyle}>Time Shortcuts</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button style={tertiaryBtnStyle} onClick={() => applyWindow('before')}>Before</button>
            <button style={tertiaryBtnStyle} onClick={() => applyWindow('during')}>During</button>
            <button style={tertiaryBtnStyle} onClick={() => applyWindow('after')}>After</button>
          </div>
        </section>

        <section style={panelSectionStyle}>
          <div style={sectionTitleStyle}>Nearby Tracks</div>
          {nearbyAssets.length === 0 ? (
            <div style={emptyStateStyle}>No nearby live tracks in the current workspace.</div>
          ) : (
            nearbyAssets.map(({ asset: related, distanceKm }) => (
              <button
                key={`${related.source_domain}:${related.track_id}`}
                style={rowButtonStyle}
                onClick={() => {
                  selectAsset(related.track_id, related.source_domain)
                  if (typeof related.lon === 'number' && typeof related.lat === 'number') {
                    flyTo(related.lon, related.lat, 8)
                  }
                }}
              >
                <span style={{ fontSize: 13 }}>{DOMAIN_ICONS[related.source_domain]}</span>
                <span style={{ flex: 1, textAlign: 'left', color: '#e2e8f0', fontSize: 12 }}>
                  {related.callsign ?? related.track_id}
                </span>
                <span style={{ color: '#94a3b8', fontSize: 10 }}>{Math.round(distanceKm as number)} km</span>
              </button>
            ))
          )}
        </section>

        <section style={panelSectionStyle}>
          <div style={sectionTitleStyle}>Disruption Overlap</div>
          {nearbyDisruptions.length === 0 ? (
            <div style={emptyStateStyle}>No disruption events overlap the current window and region.</div>
          ) : (
            nearbyDisruptions.slice(0, 4).map((event) => (
              <div key={event.id} style={summaryRowStyle}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: '#f8fafc' }}>{event.title ?? event.external_event_id}</div>
                  <div style={{ fontSize: 10, color: '#94a3b8' }}>
                    {event.source_domain} · {event.category} · severity {event.severity ?? 'n/a'}
                  </div>
                </div>
              </div>
            ))
          )}
        </section>

        <section style={panelSectionStyle}>
          <div style={sectionTitleStyle}>Nearby Annotations</div>
          {nearbyAnnotations.length === 0 ? (
            <div style={emptyStateStyle}>No saved analyst notes near this investigation.</div>
          ) : (
            nearbyAnnotations.slice(0, 3).map((feature) => (
              <div key={feature.properties.id} style={summaryRowStyle}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: '#f8fafc' }}>{feature.properties.label}</div>
                  <div style={{ fontSize: 10, color: '#94a3b8' }}>
                    {fmtUtc(feature.properties.created_at)}
                  </div>
                  {feature.properties.body && (
                    <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 4, lineHeight: 1.4 }}>
                      {feature.properties.body}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </section>

        <section style={panelSectionStyle}>
          <div style={sectionTitleStyle}>Investigation Note</div>
          <textarea
            value={annotationDraft}
            onChange={(event) => setAnnotationDraft(event.target.value)}
            placeholder="Capture what changed, why it matters, or what to review next."
            rows={3}
            style={noteInputStyle}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={primaryBtnStyle} onClick={saveNote} disabled={!annotationDraft.trim() || annotationSaving || !asset}>
              {annotationSaving ? 'Saving…' : 'Save Note'}
            </button>
            <button style={secondaryBtnStyle} onClick={refocus}>
              Re-focus Workspace
            </button>
            <button style={secondaryBtnStyle} onClick={closeInvestigation}>
              Clear
            </button>
          </div>
        </section>
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
  gridTemplateColumns: '1fr 1fr',
}

const panelSectionStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 12,
  background: 'rgba(15,23,42,0.46)',
  border: '1px solid rgba(148,163,184,0.10)',
  display: 'grid',
  gap: 8,
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: '#64748b',
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

const tertiaryBtnStyle: React.CSSProperties = {
  border: '1px solid rgba(59,130,246,0.30)',
  background: 'rgba(30,64,175,0.12)',
  color: '#bfdbfe',
  borderRadius: 999,
  padding: '6px 10px',
  fontSize: 10,
  fontWeight: 700,
  cursor: 'pointer',
}

const rowButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  border: '1px solid rgba(148,163,184,0.12)',
  background: 'rgba(15,23,42,0.55)',
  borderRadius: 10,
  padding: '8px 10px',
  cursor: 'pointer',
}

const summaryRowStyle: React.CSSProperties = {
  border: '1px solid rgba(148,163,184,0.12)',
  background: 'rgba(15,23,42,0.38)',
  borderRadius: 10,
  padding: '8px 10px',
}

const emptyStateStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#64748b',
  lineHeight: 1.45,
}

const noteInputStyle: React.CSSProperties = {
  width: '100%',
  resize: 'vertical',
  minHeight: 72,
  borderRadius: 10,
  border: '1px solid rgba(100,116,139,0.35)',
  background: 'rgba(15,23,42,0.72)',
  color: '#e2e8f0',
  padding: '10px 12px',
  fontSize: 12,
  lineHeight: 1.45,
  boxSizing: 'border-box',
}

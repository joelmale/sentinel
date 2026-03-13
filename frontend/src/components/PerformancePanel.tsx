import { useEffect } from 'react'
import { DragDots, PanelResizeHandles } from '@/components/FloatingPanelChrome'
import { useDrag } from '@/hooks/useDrag'
import { useResizePanel } from '@/hooks/useResizePanel'
import { usePerfStore } from '@/store/usePerfStore'

type ApiPerfResponse = NonNullable<ReturnType<typeof usePerfStore.getState>['apiPerf']>

export function PerformancePanel() {
  const { enabled, panelOpen, togglePanel, requests, ws, map, apiPerf, setApiPerf } = usePerfStore()
  const { offset, dragHandleRef, isDragging } = useDrag({
    storageKey: 'sentinel.performancePanelPosition',
  })
  const {
    width: panelWidth,
    height: panelHeight,
    rightHandleRef,
    bottomHandleRef,
    cornerHandleRef,
    isDragging: isResizing,
  } = useResizePanel({
    defaultWidth: 320,
    defaultHeight: 460,
    minWidth: 260,
    maxWidth: 640,
    minHeight: 240,
    maxHeight: Math.max(320, window.innerHeight - 140),
    horizontalAnchor: 'left',
    verticalAnchor: 'bottom',
    storageKey: 'sentinel.performancePanelSize',
  })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    const load = async () => {
      try {
        const response = await fetch('/api/telemetry/performance')
        if (response.status === 404) {
          return
        }
        if (!response.ok) {
          throw new Error(`api-perf failed: ${response.status}`)
        }
        const payload = await response.json() as ApiPerfResponse
        if (!cancelled) setApiPerf(payload)
      } catch {
        // Keep panel usable even if the perf endpoint is unavailable.
      }
    }

    void load()
    const id = window.setInterval(load, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [enabled, setApiPerf])

  if (!enabled) return null

  const requestRows = Object.values(requests).sort((a, b) => b.lastMs - a.lastMs).slice(0, 6)
  const apiRows = apiPerf?.routes.slice(0, 6) ?? []
  const copySnapshot = async () => {
    const payload = {
      captured_at: new Date().toISOString(),
      frontend: { requests, ws, map },
      api: apiPerf,
    }
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
  }

  return (
    <div
      style={{
        position: 'fixed',
        left: 12,
        bottom: 190,
        width: panelOpen ? panelWidth : 108,
        height: panelOpen ? panelHeight : 'auto',
        transform: `translate(${offset.x}px, ${offset.y}px)`,
        zIndex: 26,
        color: '#e2e8f0',
        background: 'rgba(10, 15, 30, 0.96)',
        border: '1px solid rgba(148,163,184,0.18)',
        borderRadius: 14,
        boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
        backdropFilter: 'blur(16px)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        userSelect: isDragging || isResizing ? 'none' : undefined,
      }}
    >
      {panelOpen && (
        <PanelResizeHandles
          horizontalRef={rightHandleRef}
          verticalRef={bottomHandleRef}
          cornerRef={cornerHandleRef}
          horizontalEdge="right"
          verticalEdge="top"
        />
      )}
      <div
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 12px',
          border: 'none',
          background: 'rgba(30,41,59,0.74)',
          color: '#93c5fd',
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: '0.12em',
          cursor: 'default',
        }}
      >
        <DragDots dragRef={dragHandleRef} isDragging={isDragging} />
        <span>PERF</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {panelOpen && (
            <span
              onClick={(event) => {
                event.stopPropagation()
                void copySnapshot()
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  void copySnapshot()
                }
              }}
              style={{
                padding: '3px 6px',
                borderRadius: 6,
                background: 'rgba(59,130,246,0.18)',
                color: '#bfdbfe',
                fontSize: 10,
                letterSpacing: '0.06em',
              }}
            >
              COPY
            </span>
          )}
          <button
            onClick={togglePanel}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#93c5fd',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: 0,
            }}
            title={panelOpen ? 'Collapse panel' : 'Expand panel'}
          >
            {panelOpen ? '−' : '+'}
          </button>
        </span>
      </div>

      {panelOpen && (
        <div style={{ padding: 12, display: 'grid', gap: 12, fontSize: 11, overflowY: 'auto', minHeight: 0, flex: 1 }}>
          <section>
            <div style={sectionTitleStyle}>Map</div>
            <div style={metricGridStyle}>
              <Metric label="Visible assets" value={map.visibleAssets} />
              <Metric label="Disruptions" value={map.visibleDisruptions} />
              <Metric label="Deck build" value={`${map.deckBuildMs.toFixed(1)} ms`} />
              <Metric label="Layers" value={map.layerCount} />
              <Metric label="Space priority" value={map.spacePriorityCount} />
              <Metric label="Space aggregates" value={map.spaceAggregateCount} />
            </div>
          </section>

          <section>
            <div style={sectionTitleStyle}>WebSocket</div>
            <div style={metricGridStyle}>
              <Metric label="State" value={ws.connected ? 'open' : 'closed'} />
              <Metric label="Messages" value={ws.messages} />
              <Metric label="Events" value={ws.events} />
              <Metric label="Reconnects" value={ws.reconnects} />
              <Metric label="Parse errors" value={ws.parseErrors} />
              <Metric label="Last bytes" value={ws.lastMessageBytes} />
            </div>
          </section>

          <section>
            <div style={sectionTitleStyle}>Frontend Requests</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {requestRows.length === 0 ? (
                <div style={emptyStyle}>No tracked requests yet.</div>
              ) : requestRows.map((row) => (
                <div key={row.key} style={rowStyle}>
                  <div>{row.key}</div>
                  <div style={{ color: '#93c5fd' }}>{row.lastMs.toFixed(1)} ms</div>
                  <div style={{ color: '#64748b' }}>avg {row.avgMs.toFixed(1)}</div>
                  <div style={{ color: row.errors > 0 ? '#fca5a5' : '#94a3b8' }}>{row.lastStatus}</div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div style={sectionTitleStyle}>API Routes</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {apiRows.length === 0 ? (
                <div style={emptyStyle}>No backend perf snapshot yet.</div>
              ) : apiRows.map((row) => (
                <div key={row.path} style={rowStyle}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.path}</div>
                  <div style={{ color: '#93c5fd' }}>{row.last_ms.toFixed(1)} ms</div>
                  <div style={{ color: '#64748b' }}>avg {row.avg_ms.toFixed(1)}</div>
                  <div style={{ color: row.errors > 0 ? '#fca5a5' : '#94a3b8' }}>{row.count}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontSize: 12, color: '#e2e8f0' }}>{value}</div>
    </div>
  )
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  marginBottom: 6,
  fontWeight: 800,
}

const metricGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
}

const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto auto auto',
  gap: 8,
  padding: '6px 8px',
  borderRadius: 10,
  background: 'rgba(15,23,42,0.48)',
  border: '1px solid rgba(148,163,184,0.10)',
}

const emptyStyle: React.CSSProperties = {
  color: '#64748b',
  fontSize: 11,
}

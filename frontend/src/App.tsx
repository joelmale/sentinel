/**
 * App — root component.
 *
 * Layout (z-layers, bottom → top):
 *   1. MapCanvas            — fills entire viewport
 *   2. Header bar           — thin top strip
 *   3. SourcePanel          — left floating panel
 *   4. AssetCard            — right floating panel (slides in on selection)
 *   5. TimelinePanel        — bottom floating bar
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { MapCanvas } from '@/components/MapCanvas'
import { SourcePanel } from '@/components/SourcePanel'
import { TimelinePanel } from '@/components/TimelinePanel'
import { AssetCard } from '@/components/AssetCard'
import { AnnotationModal } from '@/components/AnnotationModal'
import { AlertNotification } from '@/components/AlertNotification'
import { SpaceWatchDashboard, type SpaceWatchDashboardPayload } from '@/components/SpaceWatchDashboard'
import { useLiveStream } from '@/hooks/useLiveStream'
import { useMapStore } from '@/store/useMapStore'
import type { TrackEventProperties, TrackFeatureCollection, WsMessage } from '@/types/track'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false },
  },
})

function SentinelApp() {
  const {
    playback,
    upsertAssets,
    liveAssets,
    addAlert,
    selectedTrackId,
    selectedDomain,
    setSelectedTrackHistory,
    clearSelectedTrackHistory,
    spaceTrackDuration,
    setSelectedOrbitPoints,
    clearSelectedOrbitPoints,
  } = useMapStore()
  const [annotationPos, setAnnotationPos] = useState<{ lon: number; lat: number } | null>(null)
  const [now, setNow] = useState(new Date())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [spaceDashboardOpen, setSpaceDashboardOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement | null>(null)
  const { simpleMap, toggleSimpleMap, showTrails, toggleShowTrails, globeView, toggleGlobeView } = useMapStore()

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setSettingsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const liveSnapshotQuery = useQuery({
    queryKey: ['live-assets'],
    queryFn: async (): Promise<TrackEventProperties[]> => {
      const response = await fetch('/api/tracks/live')
      if (!response.ok) {
        throw new Error(`live snapshot failed: ${response.status}`)
      }
      const payload: TrackFeatureCollection = await response.json()
      return payload.features.map((feature) => ({
        ...feature.properties,
        lon: feature.geometry?.coordinates[0],
        lat: feature.geometry?.coordinates[1],
        timestamp: feature.properties.last_seen ?? feature.properties.timestamp,
      }))
    },
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (liveSnapshotQuery.data?.length) {
      upsertAssets(liveSnapshotQuery.data)
    }
  }, [liveSnapshotQuery.data, upsertAssets])

  const selectedTrackHistoryQuery = useQuery({
    queryKey: [
      'track-history',
      selectedDomain,
      selectedTrackId,
      playback.timeWindow.start.toISOString(),
      playback.timeWindow.end.toISOString(),
    ],
    enabled: Boolean(selectedDomain && selectedTrackId),
    queryFn: async () => {
      const params = new URLSearchParams({
        domain: selectedDomain!,
        track_id: selectedTrackId!,
        t_start: playback.timeWindow.start.toISOString(),
        t_end: playback.timeWindow.end.toISOString(),
        limit: '5000',
      })
      const response = await fetch(`/api/tracks/history?${params.toString()}`)
      if (!response.ok) {
        throw new Error(`track history failed: ${response.status}`)
      }
      const payload: TrackFeatureCollection = await response.json()
      return payload.features
        .filter((feature) => Array.isArray(feature.geometry?.coordinates))
        .map((feature) => ({
          lon: feature.geometry!.coordinates[0],
          lat: feature.geometry!.coordinates[1],
          timestamp: new Date(feature.properties.timestamp).getTime(),
        }))
    },
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (!selectedTrackId || !selectedDomain) {
      clearSelectedTrackHistory()
      return
    }
    setSelectedTrackHistory(selectedTrackHistoryQuery.data ?? [])
  }, [
    selectedTrackId,
    selectedDomain,
    selectedTrackHistoryQuery.data,
    setSelectedTrackHistory,
    clearSelectedTrackHistory,
  ])

  // ── Orbital track query (Space domain) ──────────────────────────────────
  // Fetches a predicted ground track from the backend which uses skyfield's
  // SGP4 propagator to forward-propagate the satellite's TLE elements.
  const orbitalTrackQuery = useQuery({
    queryKey: ['orbital-track', selectedTrackId, selectedDomain, spaceTrackDuration],
    enabled: Boolean(selectedDomain === 'Space' && selectedTrackId),
    queryFn: async () => {
      const params = new URLSearchParams({
        track_id: selectedTrackId!,
        duration: spaceTrackDuration,
      })
      const response = await fetch(`/api/tracks/orbital?${params.toString()}`)
      if (!response.ok) {
        throw new Error(`orbital track failed: ${response.status}`)
      }
      const data = await response.json()
      return (data.points as Array<{ lon: number; lat: number; alt_km: number; timestamp: string }>)
        .map((p) => ({ ...p, timestamp: new Date(p.timestamp).getTime() }))
    },
    refetchOnWindowFocus: false,
  })

  const spaceWatchStatusQuery = useQuery({
    queryKey: ['space-watch-status'],
    enabled: spaceDashboardOpen,
    queryFn: async (): Promise<SpaceWatchDashboardPayload> => {
      const response = await fetch('/api/satellites/watchlist/status')
      if (!response.ok) {
        throw new Error(`space watch status failed: ${response.status}`)
      }
      return response.json()
    },
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (!selectedTrackId || selectedDomain !== 'Space') {
      clearSelectedOrbitPoints()
      return
    }
    setSelectedOrbitPoints(orbitalTrackQuery.data ?? [])
  }, [
    selectedTrackId,
    selectedDomain,
    orbitalTrackQuery.data,
    setSelectedOrbitPoints,
    clearSelectedOrbitPoints,
  ])

  // Route WebSocket messages into the shared store
  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (msg.type === 'track_events') {
      upsertAssets(msg.events)
    } else if (msg.type === 'alert') {
      addAlert({
        alertId: msg.rule_id + ':' + Date.now(),
        ruleId: msg.rule_id,
        trackId: msg.track_id,
        domain: msg.domain,
        triggeredAt: new Date().toISOString(),
      })
    }
  }, [upsertAssets, addAlert])

  // Live stream only active in live mode
  useLiveStream({
    enabled: playback.mode === 'live',
    onMessage: handleWsMessage,
  })

  const assetsArray = Array.from(liveAssets.values())

  // Domain counts for the header
  const counts = assetsArray.reduce<Record<string, number>>((acc, a) => {
    acc[a.source_domain] = (acc[a.source_domain] ?? 0) + 1
    return acc
  }, {})

  const totalTracked = assetsArray.length
  const statItems = [
    { icon: '✈', key: 'Air', color: '#60a5fa' },
    { icon: '⚓', key: 'Maritime', color: '#22d3ee' },
    { icon: '🛰', key: 'Space', color: '#c084fc' },
    { icon: '📡', key: 'GPS', color: '#f87171' },
    { icon: '🌐', key: 'Infra', color: '#f59e0b' },
  ] as const

  return (
    <div className="relative w-screen h-screen bg-slate-950">
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: 72,
          zIndex: 20,
          background: 'rgba(15, 23, 42, 0.96)',
          borderBottom: '2px solid rgba(255,255,255,0.16)',
          boxSizing: 'border-box',
          backdropFilter: 'blur(10px)',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(240px, 320px) 1fr auto',
            alignItems: 'center',
            gap: 16,
            height: '100%',
            padding: '0 16px',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.24em', color: '#5eead4' }}>SENTINEL</span>
              <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                OSINT Geospatial Intelligence
              </span>
            </div>
            <div style={{ width: 1, height: 38, background: 'rgba(148,163,184,0.24)' }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#64748b' }}>UTC</span>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 16, color: '#f8fafc' }}>
                {format(now, 'HH:mm:ss')}
              </span>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{format(now, 'dd MMM yyyy')}</span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, justifyContent: 'center', overflow: 'hidden' }}>
            <div style={headerCardStyle}>
              <span style={headerLabelStyle}>Tracked</span>
              <span style={headerValueStyle}>{totalTracked.toLocaleString()}</span>
              <span style={headerMetaStyle}>Live assets</span>
            </div>
            {statItems.map(({ icon, key, color }) => (
              <div
                key={key}
                style={key === 'Space' ? clickableHeaderCardStyle : headerCardStyle}
                onClick={key === 'Space' ? () => setSpaceDashboardOpen(true) : undefined}
                role={key === 'Space' ? 'button' : undefined}
                tabIndex={key === 'Space' ? 0 : undefined}
                onKeyDown={key === 'Space' ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSpaceDashboardOpen(true)
                  }
                } : undefined}
                title={key === 'Space' ? 'Open curated space watch dashboard' : undefined}
              >
                <span style={headerLabelStyle}>{key}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 14 }}>{icon}</span>
                  <span style={{ ...headerValueStyle, color }}>{(counts[key] ?? 0).toLocaleString()}</span>
                </div>
                <span style={headerMetaStyle}>{key === 'GPS' ? 'Interference' : 'Tracks'}</span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifySelf: 'end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#64748b' }}>Mode</span>
              <span style={{ fontSize: 12, color: '#cbd5e1' }}>{playback.mode === 'live' ? 'Live monitoring' : 'Replay analysis'}</span>
            </div>

            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 10px',
                borderRadius: 999,
                border: playback.mode === 'live'
                  ? '1px solid rgba(16,185,129,0.35)'
                  : '1px solid rgba(59,130,246,0.35)',
                background: playback.mode === 'live'
                  ? 'rgba(16,185,129,0.12)'
                  : 'rgba(59,130,246,0.12)',
                color: playback.mode === 'live' ? '#86efac' : '#93c5fd',
                fontSize: 12,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: playback.mode === 'live' ? '#22c55e' : '#60a5fa',
                }}
              />
              {playback.mode === 'live' ? 'Connected' : 'Replay'}
            </span>

            <div ref={settingsRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setSettingsOpen((open) => !open)}
                style={settingsButtonStyle}
                title="Settings"
              >
                Settings
              </button>
              {settingsOpen && (
                <div style={settingsMenuStyle}>
                  <label style={settingsRowStyle}>
                    <span>Globe view (3D)</span>
                    <input type="checkbox" checked={globeView} onChange={toggleGlobeView} />
                  </label>
                  <label style={settingsRowStyle}>
                    <span>Simple map</span>
                    <input type="checkbox" checked={simpleMap} onChange={toggleSimpleMap} />
                  </label>
                  <label style={settingsRowStyle}>
                    <span>Show trails</span>
                    <input type="checkbox" checked={showTrails} onChange={toggleShowTrails} />
                  </label>
                  <div style={settingsHintStyle}>Globe view best shows satellite orbital paths. Simple map uses raster OSM tiles.</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Map canvas (fills everything) ─────────────────────── */}
      {/* zIndex: 1 creates a stacking context so DeckGL's internal z-index:0
          canvas stays contained within this layer, below the panels at z-20 */}
      <div className="fixed inset-0" style={{ zIndex: 1, paddingTop: 72 }}>
        <MapCanvas liveAssets={assetsArray} onMapClick={(lon, lat) => setAnnotationPos({ lon, lat })} />
      </div>

      {/* ── Left panel ─────────────────────────────────────────── */}
      <SourcePanel />

      {/* ── Bottom timeline panel ──────────────────────────────── */}
      <TimelinePanel />

      {/* ── Right asset detail panel ───────────────────────────── */}
      <AssetCard />

      {/* ── Annotation modal ───────────────────────────────────── */}
      {annotationPos && (
        <AnnotationModal
          lon={annotationPos.lon}
          lat={annotationPos.lat}
          onClose={() => setAnnotationPos(null)}
        />
      )}

      {/* ── Alert notifications ────────────────────────────────── */}
      <AlertNotification />

      <SpaceWatchDashboard
        open={spaceDashboardOpen}
        loading={spaceWatchStatusQuery.isLoading}
        error={spaceWatchStatusQuery.error instanceof Error ? spaceWatchStatusQuery.error.message : null}
        data={spaceWatchStatusQuery.data}
        onClose={() => setSpaceDashboardOpen(false)}
      />
    </div>
  )
}

const headerCardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  minWidth: '92px',
  padding: '8px 10px',
  borderRadius: '12px',
  border: '1px solid rgba(148, 163, 184, 0.2)',
  background: 'rgba(30, 41, 59, 0.55)',
}

const clickableHeaderCardStyle: React.CSSProperties = {
  ...headerCardStyle,
  cursor: 'pointer',
  boxShadow: '0 0 0 1px rgba(192,132,252,0.08), inset 0 1px 0 rgba(255,255,255,0.03)',
}

const headerLabelStyle: React.CSSProperties = {
  fontSize: '10px',
  textTransform: 'uppercase',
  letterSpacing: '0.16em',
  color: '#64748b',
}

const headerValueStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '18px',
  fontWeight: 700,
  color: '#ffffff',
}

const headerMetaStyle: React.CSSProperties = {
  fontSize: '10px',
  color: '#94a3b8',
}

const settingsButtonStyle: React.CSSProperties = {
  padding: '9px 12px',
  borderRadius: '10px',
  border: '1px solid rgba(148,163,184,0.28)',
  background: 'rgba(30,41,59,0.72)',
  color: '#f8fafc',
  fontSize: '12px',
  cursor: 'pointer',
}

const settingsMenuStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 10px)',
  right: 0,
  width: '260px',
  padding: '12px',
  borderRadius: '12px',
  border: '1px solid rgba(148,163,184,0.28)',
  background: 'rgba(15,23,42,0.98)',
  boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
  // Must exceed AssetCard/SourcePanel z-index (20) and the header (20).
  // The header itself is z:20, so this dropdown at z:30 floats above both.
  zIndex: 30,
  boxSizing: 'border-box',
}

const settingsRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  color: '#e2e8f0',
  fontSize: '12px',
  padding: '6px 0',
}

const settingsHintStyle: React.CSSProperties = {
  marginTop: '8px',
  fontSize: '11px',
  lineHeight: 1.45,
  color: '#94a3b8',
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SentinelApp />
    </QueryClientProvider>
  )
}

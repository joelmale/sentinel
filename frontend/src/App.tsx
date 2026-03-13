/**
 * App — root component.
 *
 * Layout (z-layers, bottom → top):
 *   1. MapCanvas            — fills entire viewport
 *   2. Header bar           — thin top strip
 *   3. SourcePanel          — left floating panel
 *   4. AssetCard            — right floating panel (slides in on selection)
 *   5. TimelinePanel        — bottom floating bar
 *   6. AlertQueuePanel      — bottom-right investigation workbench (z:25)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { MapCanvas } from '@/components/MapCanvas'
import { SourcePanel } from '@/components/SourcePanel'
import { TimelinePanel } from '@/components/TimelinePanel'
import { AssetCard } from '@/components/AssetCard'
import { UnderseaLandingPointCard } from '@/components/UnderseaLandingPointCard'
import { AnnotationModal } from '@/components/AnnotationModal'
import { AlertQueuePanel } from '@/components/AlertQueuePanel'
import { InvestigationPanel } from '@/components/InvestigationPanel'
import { PerformancePanel } from '@/components/PerformancePanel'
import { SpaceWatchDashboard, type SpaceWatchDashboardPayload } from '@/components/SpaceWatchDashboard'
import { DomainStatusDashboard, type DomainStatusDashboardPayload } from '@/components/DomainStatusDashboard'
import { DisruptionDashboard, type DisruptionDashboardPayload } from '@/components/DisruptionDashboard'
import { useLiveStream } from '@/hooks/useLiveStream'
import { trackedFetchJson } from '@/lib/perf'
import { useLiveDataStore } from '@/store/useLiveDataStore'
import { useMapStore } from '@/store/useMapStore'
import type {
  DisruptionEventResponse,
  LiveSummaryResponse,
  SpaceAggregate,
  SpaceAggregateFeatureCollection,
  TrackEventProperties,
  TrackFeatureCollection,
  WsMessage,
} from '@/types/track'

function serializeBbox(bounds: { west: number; south: number; east: number; north: number } | null): string | null {
  if (!bounds) return null
  return [bounds.west, bounds.south, bounds.east, bounds.north].join(',')
}

function normalizeTrackFeatures(payload: TrackFeatureCollection): TrackEventProperties[] {
  return payload.features.map((feature) => ({
    ...feature.properties,
    lon: feature.geometry?.coordinates[0],
    lat: feature.geometry?.coordinates[1],
    timestamp: feature.properties.last_seen ?? feature.properties.timestamp,
  }))
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false },
  },
})

function SentinelApp() {
  const {
    playback,
    upsertAssets,
    addAlert,
    selectedTrackId,
    selectedDomain,
    viewport,
    viewportBounds,
    setSelectedTrackHistory,
    clearSelectedTrackHistory,
    spaceTrackDuration,
    setWatchedSpaceTrackIds,
    setSelectedOrbitPoints,
    clearSelectedOrbitPoints,
    layers,
  } = useMapStore()
  const {
    globalSummary,
    setGlobalSummary,
    viewportAssets,
    upsertViewportAssets,
    replaceDomainViewportAssets,
    spaceAggregates,
    setSpaceAggregates,
    selectedAssetDetail,
    setSelectedAssetDetail,
    clearSelectedAssetDetail,
  } = useLiveDataStore()
  const [annotationPos, setAnnotationPos] = useState<{ lon: number; lat: number } | null>(null)
  const [now, setNow] = useState(new Date())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [spaceDashboardOpen, setSpaceDashboardOpen] = useState(false)
  const [domainDashboardOpen, setDomainDashboardOpen] = useState<'Air' | 'Maritime' | null>(null)
  const [disruptionDashboardOpen, setDisruptionDashboardOpen] = useState<'GPS' | 'Infra' | null>(null)
  const settingsRef = useRef<HTMLDivElement | null>(null)
  const wsBatchRef = useRef<TrackEventProperties[]>([])
  const wsFrameRef = useRef<number | null>(null)
  const { mapMode, setMapMode, showTrails, toggleShowTrails, globeView, toggleGlobeView } = useMapStore()

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => () => {
    if (wsFrameRef.current !== null) {
      cancelAnimationFrame(wsFrameRef.current)
    }
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

  const liveSummaryQuery = useQuery({
    queryKey: ['live-assets-summary'],
    queryFn: async (): Promise<LiveSummaryResponse> => {
      return trackedFetchJson<LiveSummaryResponse>('live-assets-summary', '/api/tracks/live?scope=summary')
    },
    refetchOnWindowFocus: false,
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

  useEffect(() => {
    setGlobalSummary(liveSummaryQuery.data ?? null)
  }, [liveSummaryQuery.data, setGlobalSummary])

  const viewportBbox = serializeBbox(viewportBounds)
  const shouldLoadSpaceDetails = (
    layers.Space.visibility === 'active' ||
    viewport.zoom >= 4 ||
    selectedDomain === 'Space'
  ) && Boolean(viewportBbox)

  const liveViewportQuery = useQuery({
    queryKey: [
      'live-assets-viewport',
      viewportBbox,
      viewport.zoom,
      layers.Air.visibility,
      layers.Maritime.visibility,
      layers.Space.visibility,
      selectedDomain,
    ],
    queryFn: async (): Promise<{
      air: TrackEventProperties[]
      maritime: TrackEventProperties[]
      space: TrackEventProperties[]
      spaceAggregates: SpaceAggregate[]
    }> => {
      const bbox = serializeBbox(viewportBounds)
      const requests: Array<Promise<unknown>> = []

      if (bbox && layers.Air.visibility !== 'hidden') {
        requests.push(
          trackedFetchJson<TrackFeatureCollection>('live-air-viewport', `/api/tracks/live?domain=Air&bbox=${encodeURIComponent(bbox)}`)
            .then(normalizeTrackFeatures)
        )
      } else {
        requests.push(Promise.resolve([]))
      }

      if (bbox && layers.Maritime.visibility !== 'hidden') {
        requests.push(
          trackedFetchJson<TrackFeatureCollection>('live-maritime-viewport', `/api/tracks/live?domain=Maritime&bbox=${encodeURIComponent(bbox)}`)
            .then(normalizeTrackFeatures)
        )
      } else {
        requests.push(Promise.resolve([]))
      }

      if (layers.Space.visibility !== 'hidden') {
        const aggregateUrl = bbox
          ? `/api/tracks/live?domain=Space&scope=aggregate&bbox=${encodeURIComponent(bbox)}`
          : '/api/tracks/live?domain=Space&scope=aggregate'
        requests.push(
          trackedFetchJson<SpaceAggregateFeatureCollection>('live-space-aggregates', aggregateUrl)
            .then((payload) => payload.features
              .filter((feature) => Array.isArray(feature.geometry?.coordinates))
              .map((feature) => ({
                constellation: feature.properties.constellation,
                count: feature.properties.count,
                lon: feature.geometry!.coordinates[0],
                lat: feature.geometry!.coordinates[1],
              })))
        )
      } else {
        requests.push(Promise.resolve([]))
      }

      if (bbox && shouldLoadSpaceDetails && layers.Space.visibility !== 'hidden') {
        requests.push(
          trackedFetchJson<TrackFeatureCollection>('live-space-viewport', `/api/tracks/live?domain=Space&bbox=${encodeURIComponent(bbox)}`)
            .then(normalizeTrackFeatures)
        )
      } else {
        requests.push(Promise.resolve([]))
      }

      const [air, maritime, spaceAggregates, space] = await Promise.all(requests) as [
        TrackEventProperties[],
        TrackEventProperties[],
        SpaceAggregate[],
        TrackEventProperties[],
      ]

      return { air, maritime, space, spaceAggregates }
    },
    refetchOnWindowFocus: false,
    refetchInterval: playback.mode === 'live' ? 20_000 : false,
    staleTime: 5_000,
  })

  useEffect(() => {
    const allViewportAssets = [
      ...(liveViewportQuery.data?.air ?? []),
      ...(liveViewportQuery.data?.maritime ?? []),
      ...(liveViewportQuery.data?.space ?? []),
    ]
    replaceDomainViewportAssets('Air', liveViewportQuery.data?.air ?? [])
    replaceDomainViewportAssets('Maritime', liveViewportQuery.data?.maritime ?? [])
    replaceDomainViewportAssets('Space', liveViewportQuery.data?.space ?? [])
    setSpaceAggregates(liveViewportQuery.data?.spaceAggregates ?? [])
    if (allViewportAssets.length > 0) {
      upsertAssets(allViewportAssets)
    }
  }, [liveViewportQuery.data, replaceDomainViewportAssets, setSpaceAggregates, upsertAssets])

  const selectedAssetDetailQuery = useQuery({
    queryKey: ['selected-asset-detail', selectedDomain, selectedTrackId],
    enabled: Boolean(selectedDomain && selectedTrackId),
    queryFn: async (): Promise<TrackEventProperties> => {
      const params = new URLSearchParams({
        domain: selectedDomain!,
        track_id: selectedTrackId!,
      })
      const payload = await trackedFetchJson<{ properties: TrackEventProperties; geometry: { coordinates?: [number, number] } | null }>(
        'selected-asset-detail',
        `/api/tracks/detail?${params.toString()}`,
      )
      return {
        ...payload.properties,
        lon: payload.geometry?.coordinates?.[0],
        lat: payload.geometry?.coordinates?.[1],
        timestamp: payload.properties.last_seen ?? payload.properties.timestamp,
      }
    },
    refetchOnWindowFocus: false,
    refetchInterval: playback.mode === 'live' ? 15_000 : false,
    staleTime: 5_000,
  })

  useEffect(() => {
    if (!selectedTrackId || !selectedDomain) {
      clearSelectedAssetDetail()
      return
    }
    const viewportAsset = viewportAssets.get(`${selectedDomain}:${selectedTrackId}`) ?? null
    setSelectedAssetDetail(selectedAssetDetailQuery.data ?? viewportAsset)
  }, [
    selectedTrackId,
    selectedDomain,
    viewportAssets,
    selectedAssetDetailQuery.data,
    setSelectedAssetDetail,
    clearSelectedAssetDetail,
  ])

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
      const payload = await trackedFetchJson<TrackFeatureCollection>('track-history', `/api/tracks/history?${params.toString()}`)
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
      const data = await trackedFetchJson<{ points: Array<{ lon: number; lat: number; alt_km: number; timestamp: string }> }>('orbital-track', `/api/tracks/orbital?${params.toString()}`)
      return (data.points as Array<{ lon: number; lat: number; alt_km: number; timestamp: string }>)
        .map((p) => ({ ...p, timestamp: new Date(p.timestamp).getTime() }))
    },
    refetchOnWindowFocus: false,
  })

  const spaceWatchStatusQuery = useQuery({
    queryKey: ['space-watch-status'],
    enabled: spaceDashboardOpen,
    queryFn: async (): Promise<SpaceWatchDashboardPayload> => {
      return trackedFetchJson<SpaceWatchDashboardPayload>('space-watch-status', '/api/satellites/watchlist/status')
    },
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })

  const spaceWatchPriorityQuery = useQuery({
    queryKey: ['space-watch-priority'],
    queryFn: async (): Promise<SpaceWatchDashboardPayload> => {
      return trackedFetchJson<SpaceWatchDashboardPayload>('space-watch-priority', '/api/satellites/watchlist/status')
    },
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
    retry: false,
  })

  const domainStatusQuery = useQuery({
    queryKey: ['domain-status', domainDashboardOpen],
    enabled: Boolean(domainDashboardOpen),
    queryFn: async (): Promise<DomainStatusDashboardPayload> => {
      const params = new URLSearchParams({ domain: domainDashboardOpen! })
      try {
        return await trackedFetchJson<DomainStatusDashboardPayload>('domain-status', `/api/telemetry/dashboard?${params.toString()}`)
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith(': 404')) {
          throw error
        }
      }
      return trackedFetchJson<DomainStatusDashboardPayload>('domain-status-fallback', `/api/tracks/domain-status?${params.toString()}`)
    },
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })
  const disruptionDashboardQuery = useQuery({
    queryKey: ['disruption-dashboard', disruptionDashboardOpen],
    enabled: Boolean(disruptionDashboardOpen),
    queryFn: async (): Promise<DisruptionDashboardPayload> => {
      const params = new URLSearchParams({ domain: disruptionDashboardOpen!, hours: '72' })
      try {
        return await trackedFetchJson<DisruptionDashboardPayload>('disruption-dashboard', `/api/telemetry/dashboard?${params.toString()}`)
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith(': 404')) {
          throw error
        }
      }
      return trackedFetchJson<DisruptionDashboardPayload>('disruption-dashboard-fallback', `/api/disruptions/dashboard?${params.toString()}`)
    },
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })

  const disruptionLayersVisible = layers.GPS.visibility !== 'hidden' || layers.Infra.visibility !== 'hidden'
  const disruptionWindowStart = playback.mode === 'live'
    ? new Date(Date.now() - 72 * 60 * 60 * 1000)
    : playback.timeWindow.start
  const disruptionWindowEnd = playback.mode === 'live'
    ? new Date()
    : playback.timeWindow.end

  const disruptionEventsQuery = useQuery({
    queryKey: [
      'disruptions',
      playback.mode,
      disruptionWindowStart.toISOString(),
      disruptionWindowEnd.toISOString(),
      layers.GPS.visibility,
      layers.Infra.visibility,
    ],
    enabled: disruptionLayersVisible,
    queryFn: async (): Promise<DisruptionEventResponse> => {
      const params = new URLSearchParams({
        t_start: disruptionWindowStart.toISOString(),
        t_end: disruptionWindowEnd.toISOString(),
        limit: '5000',
      })
      return trackedFetchJson<DisruptionEventResponse>('disruption-events', `/api/disruptions/events?${params.toString()}`)
    },
    refetchOnWindowFocus: false,
    refetchInterval: playback.mode === 'live' ? 60_000 : false,
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

  useEffect(() => {
    const watchedIds = new Set(
      (spaceWatchPriorityQuery.data?.items ?? [])
        .filter((item) => item.enabled && item.norad_id != null)
        .map((item) => String(item.norad_id))
    )
    setWatchedSpaceTrackIds(watchedIds)
  }, [spaceWatchPriorityQuery.data, setWatchedSpaceTrackIds])

  const flushWsBatch = useCallback(() => {
    wsFrameRef.current = null
    if (wsBatchRef.current.length === 0) return

    const latestByKey = new Map<string, TrackEventProperties>()
    for (const event of wsBatchRef.current) {
      latestByKey.set(`${event.source_domain}:${event.track_id}`, event)
    }
    wsBatchRef.current = []
    const latest = Array.from(latestByKey.values())
    upsertAssets(latest)
    upsertViewportAssets(latest)

    if (selectedTrackId && selectedDomain) {
      const selectedKey = `${selectedDomain}:${selectedTrackId}`
      const selectedEvent = latestByKey.get(selectedKey)
      if (selectedEvent) {
        setSelectedAssetDetail({
          ...(selectedAssetDetail ?? {}),
          ...selectedEvent,
        } as TrackEventProperties)
      }
    }
  }, [upsertAssets, upsertViewportAssets, selectedTrackId, selectedDomain, selectedAssetDetail, setSelectedAssetDetail])

  const scheduleWsFlush = useCallback(() => {
    if (wsFrameRef.current !== null) return
    wsFrameRef.current = requestAnimationFrame(flushWsBatch)
  }, [flushWsBatch])

  // Route WebSocket messages into the shared store
  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (msg.type === 'track_events') {
      wsBatchRef.current.push(...msg.events)
      scheduleWsFlush()
    } else if (msg.type === 'alert') {
      addAlert({
        alertId: msg.rule_id + ':' + msg.track_id,
        ruleId: msg.rule_id,
        ruleName: msg.rule_name,
        trackId: msg.track_id,
        domain: msg.domain,
        triggeredAt: new Date().toISOString(),
      })
    }
  }, [addAlert, scheduleWsFlush])

  // Live stream only active in live mode
  useLiveStream({
    enabled: playback.mode === 'live',
    onMessage: handleWsMessage,
  })

  const assetsArray = Array.from(viewportAssets.values())

  // Domain counts for the header
  const counts = globalSummary?.domains ?? {
    Air: 0,
    Maritime: 0,
    Space: 0,
    GPS: 0,
    Infra: 0,
  }

  const totalTracked = globalSummary?.total ?? 0
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
                style={key === 'Space' || key === 'Air' || key === 'Maritime' || key === 'GPS' || key === 'Infra' ? clickableHeaderCardStyle : headerCardStyle}
                onClick={
                  key === 'Space'
                    ? () => setSpaceDashboardOpen(true)
                    : key === 'Air' || key === 'Maritime'
                      ? () => setDomainDashboardOpen(key)
                      : key === 'GPS' || key === 'Infra'
                        ? () => setDisruptionDashboardOpen(key)
                      : undefined
                }
                role={key === 'Space' || key === 'Air' || key === 'Maritime' || key === 'GPS' || key === 'Infra' ? 'button' : undefined}
                tabIndex={key === 'Space' || key === 'Air' || key === 'Maritime' || key === 'GPS' || key === 'Infra' ? 0 : undefined}
                onKeyDown={key === 'Space' || key === 'Air' || key === 'Maritime' || key === 'GPS' || key === 'Infra' ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    if (key === 'Space') setSpaceDashboardOpen(true)
                    if (key === 'Air' || key === 'Maritime') setDomainDashboardOpen(key)
                    if (key === 'GPS' || key === 'Infra') setDisruptionDashboardOpen(key)
                  }
                } : undefined}
                title={
                  key === 'Space'
                    ? 'Open curated space watch dashboard'
                    : key === 'Air' || key === 'Maritime'
                      ? `Open ${key.toLowerCase()} source status dashboard`
                      : key === 'GPS' || key === 'Infra'
                        ? `Open ${key.toLowerCase()} disruption dashboard`
                      : undefined
                }
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
                  <div style={{ ...settingsRowStyle, alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
                    <span>Map mode</span>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, width: '100%' }}>
                      {([
                        ['full', 'Full'],
                        ['simple', 'Simple'],
                        ['outline', 'Outline'],
                        ['none', 'None'],
                      ] as const).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setMapMode(value)}
                          style={mapModeButtonStyle(mapMode === value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label style={settingsRowStyle}>
                    <span>Show trails</span>
                    <input type="checkbox" checked={showTrails} onChange={toggleShowTrails} />
                  </label>
                  <div style={settingsHintStyle}>Globe view best shows orbital paths. Outline and None minimize tile and label overhead.</div>
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
        <MapCanvas
          liveAssets={assetsArray}
          disruptions={disruptionEventsQuery.data?.items ?? []}
          spaceAggregates={spaceAggregates}
          onMapClick={(lon, lat) => setAnnotationPos({ lon, lat })}
        />
      </div>

      {/* ── Left panel ─────────────────────────────────────────── */}
      <SourcePanel />

      {/* ── Bottom timeline panel ──────────────────────────────── */}
      <TimelinePanel />

      {/* ── Right asset detail panel ───────────────────────────── */}
      <AssetCard />
      <UnderseaLandingPointCard />

      {/* ── Annotation modal ───────────────────────────────────── */}
      {annotationPos && (
        <AnnotationModal
          lon={annotationPos.lon}
          lat={annotationPos.lat}
          onClose={() => setAnnotationPos(null)}
        />
      )}

      {/* ── Alert queue panel (bottom-right investigation workbench) ── */}
      <AlertQueuePanel />
      <InvestigationPanel />
      <PerformancePanel />

      <SpaceWatchDashboard
        open={spaceDashboardOpen}
        loading={spaceWatchStatusQuery.isLoading}
        error={spaceWatchStatusQuery.error instanceof Error ? spaceWatchStatusQuery.error.message : null}
        data={spaceWatchStatusQuery.data}
        onClose={() => setSpaceDashboardOpen(false)}
      />
      <DomainStatusDashboard
        open={Boolean(domainDashboardOpen)}
        loading={domainStatusQuery.isLoading}
        error={domainStatusQuery.error instanceof Error ? domainStatusQuery.error.message : null}
        domain={domainDashboardOpen ?? 'Air'}
        data={domainStatusQuery.data}
        onClose={() => setDomainDashboardOpen(null)}
      />
      <DisruptionDashboard
        open={Boolean(disruptionDashboardOpen)}
        loading={disruptionDashboardQuery.isLoading}
        error={disruptionDashboardQuery.error instanceof Error ? disruptionDashboardQuery.error.message : null}
        domain={disruptionDashboardOpen ?? 'GPS'}
        data={disruptionDashboardQuery.data}
        onClose={() => setDisruptionDashboardOpen(null)}
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

const mapModeButtonStyle = (active: boolean): React.CSSProperties => ({
  padding: '7px 8px',
  borderRadius: '8px',
  border: active ? '1px solid rgba(94,234,212,0.45)' : '1px solid rgba(148,163,184,0.22)',
  background: active ? 'rgba(20,184,166,0.14)' : 'rgba(30,41,59,0.55)',
  color: active ? '#ccfbf1' : '#cbd5e1',
  fontSize: '11px',
  cursor: 'pointer',
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SentinelApp />
    </QueryClientProvider>
  )
}

/**
 * App — root component wiring together map, panels, and live stream.
 */

import { useState, useCallback } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MapCanvas } from '@/components/MapCanvas'
import { LayerPanel } from '@/components/LayerPanel'
import { TimelineBar } from '@/components/TimelineBar'
import { useLiveStream } from '@/hooks/useLiveStream'
import { useMapStore } from '@/store/useMapStore'
import type { TrackEventProperties, WsMessage } from '@/types/track'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false },
  },
})

function SentinelApp() {
  const [liveAssets, setLiveAssets] = useState<Map<string, TrackEventProperties>>(new Map())
  const { playback } = useMapStore()

  // Handle incoming WebSocket messages
  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (msg.type === 'track_events') {
      setLiveAssets((prev) => {
        const next = new Map(prev)
        for (const event of msg.events) {
          // Keyed by domain+track_id so we always have the latest state
          next.set(`${event.source_domain}:${event.track_id}`, event)
        }
        return next
      })
    }
  }, [])

  // Only connect to live stream in live mode
  useLiveStream({
    enabled: playback.mode === 'live',
    onMessage: handleWsMessage,
  })

  const assetsArray = Array.from(liveAssets.values())

  return (
    <div className="relative w-screen h-screen bg-slate-950 overflow-hidden">
      {/* Header bar */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between
                      px-4 py-2 bg-slate-900/80 backdrop-blur border-b border-slate-700">
        <div className="flex items-center gap-3">
          <span className="text-teal-400 font-bold text-lg tracking-widest">SENTINEL</span>
          <span className="text-slate-500 text-xs">OSINT Geospatial Intelligence</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-400">
          <span>✈️ {assetsArray.filter((a) => a.source_domain === 'Air').length} aircraft</span>
          <span>🚢 {assetsArray.filter((a) => a.source_domain === 'Maritime').length} vessels</span>
          <span>🛰️ {assetsArray.filter((a) => a.source_domain === 'Space').length} satellites</span>
        </div>
      </div>

      {/* Main map */}
      <div className="absolute inset-0 pt-10">
        <MapCanvas liveAssets={assetsArray} />
      </div>

      {/* Layer control panel */}
      <LayerPanel />

      {/* Timeline / playback bar */}
      <TimelineBar />
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SentinelApp />
    </QueryClientProvider>
  )
}

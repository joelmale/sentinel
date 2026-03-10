/**
 * TimelineBar — DVR-style playback control.
 *
 * In Live mode: shows a pulsing "LIVE" indicator.
 * In Replay mode: shows a scrubber over the selected time window
 *   with play/pause, speed control, and step buttons.
 *
 * The scrubber position maps linearly to the time window.
 * Changing it updates playback.currentTime in the Zustand store,
 * which triggers React Query to refetch historical data for that
 * time slice and deck.gl to re-render the TripsLayer.
 */

import { useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { useMapStore } from '@/store/useMapStore'
import type { PlaybackState } from '@/store/useMapStore'

export function TimelineBar() {
  const { playback, setPlaybackMode, setCurrentTime, setSpeedMultiplier, tickPlayback } =
    useMapStore()

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Drive the playback tick
  useEffect(() => {
    if (playback.mode === 'replay') {
      tickRef.current = setInterval(tickPlayback, 1000)
    } else {
      if (tickRef.current) clearInterval(tickRef.current)
    }
    return () => { if (tickRef.current) clearInterval(tickRef.current) }
  }, [playback.mode, playback.speedMultiplier, tickPlayback])

  const windowMs = playback.timeWindow.end.getTime() - playback.timeWindow.start.getTime()
  const progressMs = playback.currentTime.getTime() - playback.timeWindow.start.getTime()
  const scrubberPct = windowMs > 0 ? Math.max(0, Math.min(1, progressMs / windowMs)) : 0

  function handleScrub(e: React.ChangeEvent<HTMLInputElement>) {
    const pct = parseFloat(e.target.value)
    const newTime = new Date(playback.timeWindow.start.getTime() + pct * windowMs)
    setCurrentTime(newTime)
  }

  function enterReplay() {
    setPlaybackMode('replay')
    // If currentTime is at "now", rewind to start of window
    if (playback.mode === 'live') {
      setCurrentTime(playback.timeWindow.start)
    }
  }

  const SPEEDS: PlaybackState['speedMultiplier'][] = [1, 5, 30, 60]

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3
                    bg-slate-900/95 text-white px-5 py-3 rounded-xl shadow-2xl min-w-[520px]
                    border border-slate-700">

      {/* Mode toggle */}
      <div className="flex gap-1">
        <button
          onClick={() => setPlaybackMode('live')}
          className={`px-3 py-1 rounded text-xs font-bold transition-colors ${
            playback.mode === 'live'
              ? 'bg-red-600 text-white animate-pulse'
              : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
          }`}
        >
          ● LIVE
        </button>
        <button
          onClick={enterReplay}
          className={`px-3 py-1 rounded text-xs font-bold transition-colors ${
            playback.mode !== 'live'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
          }`}
        >
          REPLAY
        </button>
      </div>

      {/* Scrubber (only visible in replay mode) */}
      {playback.mode !== 'live' && (
        <>
          {/* Play/Pause */}
          <button
            onClick={() =>
              setPlaybackMode(playback.mode === 'replay' ? 'paused' : 'replay')
            }
            className="text-xl w-8"
          >
            {playback.mode === 'replay' ? '⏸' : '▶️'}
          </button>

          {/* Time labels + scrubber */}
          <div className="flex flex-col gap-0.5 flex-1">
            <div className="flex justify-between text-xs text-slate-400">
              <span>{format(playback.timeWindow.start, 'HH:mm')}</span>
              <span className="font-mono text-blue-300">
                {format(playback.currentTime, 'HH:mm:ss')} UTC
              </span>
              <span>{format(playback.timeWindow.end, 'HH:mm')}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.0001}
              value={scrubberPct}
              onChange={handleScrub}
              className="w-full accent-blue-400"
            />
          </div>

          {/* Speed control */}
          <div className="flex gap-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setSpeedMultiplier(s)}
                className={`text-xs px-2 py-0.5 rounded ${
                  playback.speedMultiplier === s
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        </>
      )}

      {/* Live mode: just show current UTC time */}
      {playback.mode === 'live' && (
        <div className="text-sm font-mono text-green-400">
          {format(new Date(), 'HH:mm:ss')} UTC
        </div>
      )}
    </div>
  )
}

/**
 * TimelinePanel — bottom floating mission-control timeline bar.
 *
 * LIVE mode:   Pulsing indicator, UTC clock, per-domain live counts,
 *              quick-entry buttons for preset replay windows.
 *
 * REPLAY mode: Preset range chips (1h / 6h / 24h / 48h / custom),
 *              full-width styled scrubber, transport controls,
 *              speed multiplier, prominent current-time readout.
 *
 * Design principles:
 *   • One clear visual hierarchy: current time is king in replay.
 *   • Touch-friendly 36px+ targets for all interactive controls.
 *   • No raw browser inputs where possible — styled datetime pickers.
 *   • Glassmorphism matches the rest of the app.
 *   • Scrubber thumb position drives a CSS gradient for elapsed vs remaining.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { format, intervalToDuration } from 'date-fns'
import { useLiveDataStore } from '@/store/useLiveDataStore'
import { useMapStore } from '@/store/useMapStore'
import type { PlaybackState } from '@/store/useMapStore'
import type { SourceDomain } from '@/types/track'

// ── Constants ─────────────────────────────────────────────────────
const SPEEDS: PlaybackState['speedMultiplier'][] = [1, 5, 30, 60]

const DOMAIN_COLORS: Record<SourceDomain, string> = {
  Air:      '#60a5fa',
  Maritime: '#22d3ee',
  Space:    '#c084fc',
  GPS:      '#f87171',
  Infra:    '#f59e0b',
}

const DOMAIN_ICONS: Record<SourceDomain, string> = {
  Air: '✈', Maritime: '⚓', Space: '🛰', GPS: '📡', Infra: '🌐',
}

const PRESETS = [
  { label: '−1h',  ms: 1   * 3_600_000 },
  { label: '−6h',  ms: 6   * 3_600_000 },
  { label: '−24h', ms: 24  * 3_600_000 },
  { label: '−48h', ms: 48  * 3_600_000 },
]

// ── Helpers ────────────────────────────────────────────────────────
function toInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtDur(sec: number): string {
  if (sec <= 0) return '0s'
  const d = intervalToDuration({ start: 0, end: Math.round(sec) * 1000 })
  if (sec >= 3600) return `${d.hours}h ${d.minutes}m`
  if (sec >= 60)   return `${d.minutes}m ${d.seconds}s`
  return `${Math.round(sec)}s`
}

function fmtUtc(d: Date): string {
  return format(d, "dd MMM yyyy · HH:mm:ss") + ' UTC'
}

// ── Sub-components ─────────────────────────────────────────────────

function LiveDot() {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8 }}>
      <span style={{
        position: 'absolute', inset: 0, borderRadius: '50%',
        background: '#ef4444', opacity: 0.6,
        animation: 'sentinel-live-ping 1.6s cubic-bezier(0,0,0.2,1) infinite',
      }} />
      <span style={{ position: 'relative', width: 8, height: 8, borderRadius: '50%', background: '#f87171' }} />
      <style>{`@keyframes sentinel-live-ping{0%{transform:scale(1);opacity:.6}75%,100%{transform:scale(2.2);opacity:0}}`}</style>
    </span>
  )
}

function TransportBtn({
  onClick, title, children, active = false, large = false,
  disabled = false,
}: { onClick: () => void; title: string; children: React.ReactNode; active?: boolean; large?: boolean; disabled?: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <button onClick={onClick} title={title} disabled={disabled}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: large ? 40 : 32, height: large ? 40 : 32,
        borderRadius: large ? '50%' : 8, border: '1px solid',
        borderColor: disabled ? 'rgba(51,65,85,0.35)' : active || hover ? 'rgba(20,184,166,0.6)' : 'rgba(71,85,105,0.5)',
        background: disabled ? 'rgba(15,23,42,0.35)' : active ? 'rgba(13,148,136,0.4)' : hover ? 'rgba(71,85,105,0.5)' : 'rgba(30,41,59,0.6)',
        color: disabled ? '#475569' : active ? '#5eead4' : hover ? '#e2e8f0' : '#94a3b8',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: large ? 16 : 12, cursor: disabled ? 'not-allowed' : 'pointer', transition: 'all 0.15s', flexShrink: 0,
        opacity: disabled ? 0.7 : 1,
      }}
    >
      {children}
    </button>
  )
}

function SpeedChip({ speed, active, onClick }: { speed: number; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        padding: '3px 9px', borderRadius: 6, border: '1px solid',
        fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', cursor: 'pointer', transition: 'all 0.15s',
        borderColor: active ? '#14b8a6' : hover ? 'rgba(71,85,105,0.8)' : 'rgba(71,85,105,0.4)',
        background: active ? 'rgba(13,148,136,0.35)' : hover ? 'rgba(71,85,105,0.4)' : 'rgba(15,23,42,0.6)',
        color: active ? '#5eead4' : hover ? '#cbd5e1' : '#64748b',
      }}
    >
      {speed}×
    </button>
  )
}

function PresetChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        padding: '4px 12px', borderRadius: 20, border: '1px solid',
        fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', cursor: 'pointer', transition: 'all 0.15s',
        borderColor: active ? '#3b82f6' : hover ? 'rgba(59,130,246,0.4)' : 'rgba(71,85,105,0.4)',
        background: active ? 'rgba(37,99,235,0.3)' : hover ? 'rgba(37,99,235,0.15)' : 'rgba(15,23,42,0.5)',
        color: active ? '#93c5fd' : hover ? '#93c5fd' : '#64748b',
      }}
    >
      {label}
    </button>
  )
}

// ── Activity density strip ─────────────────────────────────────────
// Shows bucketed distinct-track counts per domain across the time window.
// Think of it like a spectrogram: time on X, domain on Y, brightness = activity.
// Each domain gets a horizontal lane whose cells light up proportionally to count.
//
// Analogy: it's the waveform display under a podcast player, but instead of
// audio amplitude it shows how busy each domain was at each moment in time.

const DOMAIN_ORDER_STRIP: SourceDomain[] = ['Air', 'Maritime', 'Space', 'GPS', 'Infra']
const STRIP_DOMAIN_COLORS: Record<SourceDomain, string> = {
  Air:      '#60a5fa',
  Maritime: '#22d3ee',
  Space:    '#c084fc',
  GPS:      '#f87171',
  Infra:    '#f59e0b',
}

interface ActivityBucket { bucket: string; count: number }
interface ActivityData   { domains: Partial<Record<string, ActivityBucket[]>> }

// Choose bucket_minutes so we get ~60–80 columns across the window
function chooseBucketMinutes(windowMs: number): number {
  const windowMinutes = windowMs / 60_000
  if (windowMinutes <= 120)  return 2
  if (windowMinutes <= 360)  return 5
  if (windowMinutes <= 1440) return 15
  if (windowMinutes <= 2880) return 30
  return 60
}

function DensityStrip({ tStart, tEnd }: { tStart: Date; tEnd: Date }) {
  const [data, setData] = useState<ActivityData | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const fetch_ = useCallback(() => {
    if (abortRef.current) abortRef.current.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const windowMs = tEnd.getTime() - tStart.getTime()
    const bm = chooseBucketMinutes(windowMs)
    const params = new URLSearchParams({
      t_start: tStart.toISOString(),
      t_end:   tEnd.toISOString(),
      bucket_minutes: String(bm),
    })
    fetch(`/api/tracks/activity?${params}`, { signal: ctrl.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setData(d) })
      .catch(() => { /* aborted or network error */ })
  }, [tStart, tEnd])

  useEffect(() => { fetch_() }, [fetch_])

  if (!data) {
    // Skeleton — faint placeholders while loading
    return (
      <div style={{ height: 28, display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0' }}>
        {DOMAIN_ORDER_STRIP.map((d) => (
          <div key={d} style={{ height: 3, borderRadius: 2, background: 'rgba(30,41,59,0.6)' }} />
        ))}
      </div>
    )
  }

  // Build a unified time axis from all domain buckets
  const allBuckets = Array.from(
    new Set(
      Object.values(data.domains)
        .flat()
        .filter((b): b is ActivityBucket => !!b)
        .map((b) => b.bucket)
    )
  ).sort()

  if (allBuckets.length === 0) {
    return <div style={{ height: 28 }} />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1.5, padding: '3px 0' }}>
      {DOMAIN_ORDER_STRIP.map((domain) => {
        const domainBuckets = data.domains[domain] ?? []
        const bucketMap = new Map(domainBuckets.map((b) => [b.bucket, b.count]))
        const maxCount  = Math.max(1, ...domainBuckets.map((b) => b.count))
        const color     = STRIP_DOMAIN_COLORS[domain]

        return (
          <div
            key={domain}
            title={`${domain} activity`}
            style={{
              height: 4, display: 'flex', gap: 0, borderRadius: 2, overflow: 'hidden',
            }}
          >
            {allBuckets.map((bucket) => {
              const count   = bucketMap.get(bucket) ?? 0
              const opacity = count === 0 ? 0.06 : 0.15 + 0.85 * (count / maxCount)
              return (
                <div
                  key={bucket}
                  style={{
                    flex: 1,
                    background: color,
                    opacity,
                    transition: 'opacity 0.2s',
                  }}
                  title={`${domain} · ${new Date(bucket).toLocaleTimeString()} · ${count} tracks`}
                />
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// Inject scrubber thumb styles once (can't be done purely inline)
if (typeof document !== 'undefined' && !document.getElementById('sentinel-scrubber-css')) {
  const s = document.createElement('style')
  s.id = 'sentinel-scrubber-css'
  s.textContent = `
    .s-scrubber{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:4px;outline:none;cursor:pointer;background:transparent}
    .s-scrubber::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:#38bdf8;border:2px solid rgba(186,230,253,.7);box-shadow:0 0 8px rgba(56,189,248,.6);cursor:grab;transition:transform .1s,box-shadow .1s}
    .s-scrubber::-webkit-slider-thumb:active{cursor:grabbing;transform:scale(1.25)}
    .s-scrubber::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:#38bdf8;border:2px solid rgba(186,230,253,.7);cursor:grab}
  `
  document.head.appendChild(s)
}

// ── Main component ─────────────────────────────────────────────────
export function TimelinePanel() {
  const {
    playback,
    pendingAlerts,
    investigationContext,
    layers,
    focusAlert,
    setPlaybackMode, setCurrentTime, setTimeWindow, setSpeedMultiplier, tickPlayback,
  } = useMapStore()
  const { uiViewportAssets } = useLiveDataStore()

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [activePreset, setActivePreset] = useState<number | null>(null)
  const [showCustom, setShowCustom] = useState(false)
  const [utcNow, setUtcNow] = useState(() => new Date())

  useEffect(() => {
    if (playback.mode === 'replay') {
      tickRef.current = setInterval(tickPlayback, 1000)
    } else {
      if (tickRef.current) clearInterval(tickRef.current)
    }
    return () => { if (tickRef.current) clearInterval(tickRef.current) }
  }, [playback.mode, playback.speedMultiplier, tickPlayback])

  useEffect(() => {
    if (playback.mode !== 'live') return
    const id = setInterval(() => setUtcNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [playback.mode])

  const windowMs   = playback.timeWindow.end.getTime() - playback.timeWindow.start.getTime()
  const progressMs = playback.currentTime.getTime() - playback.timeWindow.start.getTime()
  const scrubPct   = windowMs > 0 ? Math.max(0, Math.min(1, progressMs / windowMs)) : 0
  const elapsed    = Math.max(0, progressMs / 1000)
  const remaining  = Math.max(0, (windowMs - progressMs) / 1000)
  const scrubBg    = `linear-gradient(to right,rgba(20,184,166,.8) 0%,rgba(20,184,166,.8) ${scrubPct*100}%,rgba(30,41,59,.8) ${scrubPct*100}%,rgba(30,41,59,.8) 100%)`

  const domainCounts = useMemo(() => {
    const counts: Partial<Record<SourceDomain, number>> = {}
    for (const a of uiViewportAssets.values()) {
      const d = a.source_domain as SourceDomain
      counts[d] = (counts[d] ?? 0) + 1
    }
    return counts
  }, [uiViewportAssets])

  const windowAlerts = useMemo(() => {
    const startMs = playback.timeWindow.start.getTime()
    const endMs = playback.timeWindow.end.getTime()
    if (endMs <= startMs) return []

    return pendingAlerts
      .filter((alert) => {
        if (layers[alert.domain]?.visibility === 'hidden') return false
        const ts = new Date(alert.triggeredAt).getTime()
        return ts >= startMs && ts <= endMs
      })
      .sort((a, b) => new Date(a.triggeredAt).getTime() - new Date(b.triggeredAt).getTime())
      .map((alert) => {
        const timestampMs = new Date(alert.triggeredAt).getTime()
        const pct = ((timestampMs - startMs) / (endMs - startMs)) * 100
        return {
          ...alert,
          timestampMs,
          pct: Math.max(0, Math.min(100, pct)),
          isActive: alert.alertId === investigationContext?.alertId,
        }
      })
  }, [pendingAlerts, investigationContext, layers, playback.timeWindow.end, playback.timeWindow.start])

  const activeWindowAlertIndex = useMemo(() => (
    windowAlerts.findIndex((alert) => alert.alertId === investigationContext?.alertId)
  ), [windowAlerts, investigationContext])

  const previousWindowAlert = useMemo(() => {
    if (windowAlerts.length === 0) return null
    if (activeWindowAlertIndex > 0) return windowAlerts[activeWindowAlertIndex - 1]
    const currentMs = playback.currentTime.getTime()
    const candidates = windowAlerts.filter((alert) => alert.timestampMs < currentMs)
    return candidates.at(-1) ?? null
  }, [windowAlerts, activeWindowAlertIndex, playback.currentTime])

  const nextWindowAlert = useMemo(() => {
    if (windowAlerts.length === 0) return null
    if (activeWindowAlertIndex >= 0 && activeWindowAlertIndex < windowAlerts.length - 1) {
      return windowAlerts[activeWindowAlertIndex + 1]
    }
    const currentMs = playback.currentTime.getTime()
    return windowAlerts.find((alert) => alert.timestampMs > currentMs) ?? null
  }, [windowAlerts, activeWindowAlertIndex, playback.currentTime])

  const jumpToWindowAlert = useCallback((alert: (typeof windowAlerts)[number]) => {
    focusAlert(alert, { preserveWindow: true })
  }, [focusAlert])

  function enterReplay(presetMs?: number) {
    const end   = new Date()
    const start = new Date(end.getTime() - (presetMs ?? 3_600_000))
    setTimeWindow({ start, end })
    setCurrentTime(start)
    setPlaybackMode('replay')
  }

  function applyPreset(idx: number) {
    setActivePreset(idx)
    setShowCustom(false)
    enterReplay(PRESETS[idx].ms)
  }

  function goLive() {
    setPlaybackMode('live')
    setActivePreset(null)
    setShowCustom(false)
  }

  const isLive    = playback.mode === 'live'
  const isPlaying = playback.mode === 'replay'

  return (
    <div style={{
      position: 'fixed', left: '50%', bottom: 12,
      transform: 'translateX(-50%)',
      width: 'min(980px, calc(100vw - 24px))',
      zIndex: 20,
      background: 'rgba(10, 15, 30, 0.97)',
      backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 18,
      boxShadow: '0 -4px 32px rgba(0,0,0,.4), 0 20px 60px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06)',
      overflow: 'hidden',
      boxSizing: 'border-box',
      color: 'white',
    }}>

      {/* ══ TOP ROW ══════════════════════════════════════════════════ */}
      <div style={{
        display: 'flex', alignItems: 'stretch',
        borderBottom: '1px solid rgba(255,255,255,0.06)', minHeight: 38,
      }}>
        {/* LIVE tab */}
        <button onClick={goLive} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 18px',
          border: 'none',
          borderRight: '1px solid rgba(255,255,255,.06)',
          borderBottom: isLive ? '2px solid #ef4444' : '2px solid transparent',
          background: isLive ? 'rgba(239,68,68,.07)' : 'transparent',
          cursor: 'pointer', transition: 'all .15s', flexShrink: 0,
        }}>
          {isLive ? <LiveDot /> : <span style={{ width:8,height:8,borderRadius:'50%',background:'#374151',display:'inline-block' }}/>}
          <span style={{ fontSize:11, fontWeight:800, letterSpacing:'.1em', color: isLive ? '#f87171' : '#475569' }}>LIVE</span>
        </button>

        {/* REPLAY tab */}
        <button onClick={() => enterReplay()} style={{
          display: 'flex', alignItems: 'center', gap: 7, padding: '0 18px',
          border: 'none',
          borderRight: '1px solid rgba(255,255,255,.06)',
          borderBottom: !isLive ? '2px solid #3b82f6' : '2px solid transparent',
          background: !isLive ? 'rgba(59,130,246,.07)' : 'transparent',
          cursor: 'pointer', transition: 'all .15s', flexShrink: 0,
        }}>
          <span style={{ fontSize:12 }}>⏪</span>
          <span style={{ fontSize:11, fontWeight:800, letterSpacing:'.1em', color: !isLive ? '#93c5fd' : '#475569' }}>REPLAY</span>
        </button>

        {/* LIVE: domain counters + clock + enter replay */}
        {isLive && (
          <div style={{ flex:1, display:'flex', alignItems:'center', gap:16, padding:'0 18px', overflow:'hidden' }}>
            <div style={{ display:'flex', gap:14, alignItems:'center', overflow:'hidden' }}>
              {(Object.keys(DOMAIN_COLORS) as SourceDomain[]).map(domain => {
                const count = domainCounts[domain] ?? 0
                if (!count) return null
                return (
                  <div key={domain} style={{ display:'flex', alignItems:'center', gap:5, flexShrink:0 }}>
                    <span style={{ fontSize:13 }}>{DOMAIN_ICONS[domain]}</span>
                    <span style={{ fontSize:13, fontWeight:700, color: DOMAIN_COLORS[domain], fontVariantNumeric:'tabular-nums' }}>
                      {count.toLocaleString()}
                    </span>
                  </div>
                )
              })}
            </div>
            <div style={{ flex:1 }} />
            <div style={{ fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize:13, fontWeight:600, color:'#94a3b8', letterSpacing:'.04em', flexShrink:0 }}>
              {fmtUtc(utcNow)}
            </div>
            <button onClick={() => enterReplay()} style={{
              padding:'4px 12px', borderRadius:8, flexShrink:0,
              background:'rgba(37,99,235,.2)', border:'1px solid rgba(59,130,246,.35)',
              color:'#93c5fd', fontSize:11, fontWeight:700, letterSpacing:'.06em', cursor:'pointer',
            }}>
              Replay history →
            </button>
          </div>
        )}

        {/* REPLAY: current time in top bar */}
        {!isLive && (
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <div style={{ fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize:15, fontWeight:700, color:'#38bdf8', letterSpacing:'.06em' }}>
              {fmtUtc(playback.currentTime)}
            </div>
          </div>
        )}

        {/* Elapsed / remaining chip */}
        {!isLive && (
          <div style={{ display:'flex', alignItems:'center', gap:6, padding:'0 16px', borderLeft:'1px solid rgba(255,255,255,.06)', flexShrink:0 }}>
            <span style={{ fontSize:11, color:'#94a3b8', fontVariantNumeric:'tabular-nums' }}>{fmtDur(elapsed)}</span>
            <span style={{ fontSize:11, color:'#374151' }}>/</span>
            <span style={{ fontSize:11, color:'#475569', fontVariantNumeric:'tabular-nums' }}>−{fmtDur(remaining)}</span>
          </div>
        )}
      </div>

      {/* ══ REPLAY BODY ════════════════════════════════════════════════ */}
      {!isLive && (
        <div style={{ padding:'12px 16px 14px', display:'flex', flexDirection:'column', gap:10 }}>

          {/* ROW 1: Range presets */}
          <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
            <span style={{ fontSize:10, fontWeight:700, letterSpacing:'.12em', color:'#374151', textTransform:'uppercase', flexShrink:0 }}>
              Range
            </span>
            {PRESETS.map((p, i) => (
              <PresetChip key={p.label} label={p.label} active={activePreset === i} onClick={() => applyPreset(i)} />
            ))}
            <PresetChip label="Custom" active={showCustom} onClick={() => { setShowCustom(v => !v); setActivePreset(null) }} />
            {windowMs > 0 && (
              <span style={{ marginLeft:'auto', fontSize:11, fontWeight:600, color:'#475569', fontVariantNumeric:'tabular-nums' }}>
                {fmtDur(windowMs / 1000)} window
              </span>
            )}
          </div>

          {/* Custom pickers */}
          {showCustom && (
            <div style={{ display:'flex', alignItems:'flex-end', gap:12, padding:'10px 14px', borderRadius:10, background:'rgba(15,23,42,.6)', border:'1px solid rgba(71,85,105,.3)' }}>
              <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                <span style={{ fontSize:9, fontWeight:700, letterSpacing:'.12em', color:'#475569', textTransform:'uppercase' }}>From</span>
                <input type="datetime-local" value={toInputValue(playback.timeWindow.start)}
                  onChange={e => { const d=new Date(e.target.value); if(!isNaN(d.getTime())) setTimeWindow({...playback.timeWindow,start:d}) }}
                  style={{ background:'rgba(15,23,42,.8)', border:'1px solid rgba(71,85,105,.5)', borderRadius:8, padding:'5px 9px', color:'#cbd5e1', fontSize:12, fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace', outline:'none' }}
                />
              </div>
              <span style={{ color:'#374151', fontSize:18, paddingBottom:4 }}>→</span>
              <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                <span style={{ fontSize:9, fontWeight:700, letterSpacing:'.12em', color:'#475569', textTransform:'uppercase' }}>To</span>
                <input type="datetime-local" value={toInputValue(playback.timeWindow.end)}
                  onChange={e => { const d=new Date(e.target.value); if(!isNaN(d.getTime())) setTimeWindow({...playback.timeWindow,end:d}) }}
                  style={{ background:'rgba(15,23,42,.8)', border:'1px solid rgba(71,85,105,.5)', borderRadius:8, padding:'5px 9px', color:'#cbd5e1', fontSize:12, fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace', outline:'none' }}
                />
              </div>
              <button onClick={() => { setCurrentTime(playback.timeWindow.start); setPlaybackMode('replay') }}
                style={{ padding:'6px 16px', borderRadius:8, background:'rgba(37,99,235,.3)', border:'1px solid rgba(59,130,246,.4)', color:'#93c5fd', fontSize:12, fontWeight:700, cursor:'pointer', alignSelf:'flex-end' }}>
                Apply
              </button>
            </div>
          )}

          {/* ── Activity density strip ── */}
          <DensityStrip
            tStart={playback.timeWindow.start}
            tEnd={playback.timeWindow.end}
          />

          {/* ROW 2: Scrubber */}
          <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
            <div style={{ position:'relative', padding:'4px 0' }}>
              <div style={{ position:'absolute', left:0, right:0, top:'50%', height:4, borderRadius:4, marginTop:-2, background:scrubBg, pointerEvents:'none' }} />
              {windowAlerts.map((alert) => (
                <button
                  key={alert.alertId}
                  title={`${alert.domain} · ${alert.ruleName ?? alert.ruleId} · ${fmtUtc(new Date(alert.triggeredAt))}`}
                  onClick={() => jumpToWindowAlert(alert)}
                  style={{
                    position: 'absolute',
                    left: `calc(${alert.pct}% - 5px)`,
                    top: '50%',
                    width: alert.isActive ? 10 : 8,
                    height: alert.isActive ? 10 : 8,
                    marginTop: alert.isActive ? -5 : -4,
                    borderRadius: 999,
                    background: DOMAIN_COLORS[alert.domain],
                    border: alert.isActive ? '2px solid rgba(248,250,252,0.95)' : '1px solid rgba(15,23,42,0.85)',
                    boxShadow: alert.isActive
                      ? `0 0 0 3px ${DOMAIN_COLORS[alert.domain]}33`
                      : `0 0 0 2px ${DOMAIN_COLORS[alert.domain]}1F`,
                    padding: 0,
                    cursor: 'pointer',
                    zIndex: alert.isActive ? 2 : 1,
                  }}
                />
              ))}
              <input type="range" className="s-scrubber" min={0} max={1} step={0.0001} value={scrubPct}
                onChange={e => { const pct=parseFloat(e.target.value); setCurrentTime(new Date(playback.timeWindow.start.getTime()+pct*windowMs)) }} />
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'0 2px' }}>
              <span style={{ fontSize:10, color:'#374151', fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace' }}>
                {format(playback.timeWindow.start,'HH:mm dd MMM')}
              </span>
              <span style={{ fontSize:10, color:'#374151', fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace' }}>
                {format(playback.timeWindow.end,'HH:mm dd MMM')}
              </span>
            </div>
            {windowAlerts.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 16 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', color: '#475569', textTransform: 'uppercase' }}>
                  Alerts
                </span>
                {windowAlerts.slice(0, 5).map((alert) => (
                  <button
                    key={alert.alertId}
                    onClick={() => jumpToWindowAlert(alert)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 10,
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      cursor: 'pointer',
                      color: alert.isActive ? '#e2e8f0' : '#94a3b8',
                    }}
                    title={`${alert.domain} · ${alert.ruleName ?? alert.ruleId}`}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        background: DOMAIN_COLORS[alert.domain],
                        boxShadow: alert.isActive ? `0 0 0 2px ${DOMAIN_COLORS[alert.domain]}33` : undefined,
                      }}
                    />
                    {alert.ruleName ?? alert.ruleId}
                  </button>
                ))}
                {windowAlerts.length > 5 && (
                  <span style={{ fontSize: 10, color: '#64748b' }}>+{windowAlerts.length - 5} more</span>
                )}
              </div>
            )}
          </div>

          {/* ROW 3: Transport + speed + back to live */}
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <TransportBtn onClick={() => setCurrentTime(playback.timeWindow.start)} title="Jump to start">⏮</TransportBtn>
            <TransportBtn
              onClick={() => previousWindowAlert && jumpToWindowAlert(previousWindowAlert)}
              title="Jump to previous alert"
              disabled={!previousWindowAlert}
            >
              ←!
            </TransportBtn>
            <TransportBtn onClick={() => setCurrentTime(new Date(Math.max(playback.timeWindow.start.getTime(), playback.currentTime.getTime()-300_000)))} title="Back 5 minutes">−5m</TransportBtn>
            <TransportBtn large active={isPlaying} onClick={() => setPlaybackMode(isPlaying ? 'paused' : 'replay')} title={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? '⏸' : '▶'}
            </TransportBtn>
            <TransportBtn onClick={() => setCurrentTime(new Date(Math.min(playback.timeWindow.end.getTime(), playback.currentTime.getTime()+300_000)))} title="Forward 5 minutes">+5m</TransportBtn>
            <TransportBtn
              onClick={() => nextWindowAlert && jumpToWindowAlert(nextWindowAlert)}
              title="Jump to next alert"
              disabled={!nextWindowAlert}
            >
              !→
            </TransportBtn>
            <TransportBtn onClick={() => setCurrentTime(playback.timeWindow.end)} title="Jump to end">⏭</TransportBtn>

            <div style={{ width:1, height:24, background:'rgba(71,85,105,.4)', margin:'0 4px', flexShrink:0 }} />

            <div style={{ display:'flex', gap:4, alignItems:'center' }}>
              <span style={{ fontSize:10, fontWeight:700, letterSpacing:'.1em', color:'#374151', textTransform:'uppercase', marginRight:2 }}>Speed</span>
              {SPEEDS.map(s => (
                <SpeedChip key={s} speed={s} active={playback.speedMultiplier === s} onClick={() => setSpeedMultiplier(s)} />
              ))}
            </div>

            <div style={{ flex:1 }} />

            <button onClick={goLive} style={{
              display:'flex', alignItems:'center', gap:6, padding:'5px 14px', borderRadius:20,
              background:'rgba(239,68,68,.12)', border:'1px solid rgba(239,68,68,.3)',
              color:'#f87171', fontSize:11, fontWeight:700, letterSpacing:'.06em', cursor:'pointer',
              flexShrink:0, transition:'all .15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background='rgba(239,68,68,.22)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background='rgba(239,68,68,.12)' }}>
              <LiveDot /><span>Back to Live</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

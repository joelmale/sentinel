/**
 * SourcePanel — left floating panel.
 *
 * Structure (top → bottom):
 *   1. Header: grab-to-move handle + title + asset count + hide button
 *   2. Search box (filters across all domains)
 *   3. Domain rows: per-domain checkbox + icon + count + collapse toggle
 *      ↳ Expanded: classification filter chips + track list rows
 *      ↳ Space domain: orbital track duration selector
 *   4. Map Overlays: COCOM boundaries toggle, Globe View toggle
 *
 * State stored in Zustand (layer enabled/disabled, classFilter, globeView)
 * and localStorage (panel width + drag position).
 */

import { useMemo, useState } from 'react'
import { useMapStore } from '@/store/useMapStore'
import { useResize } from '@/hooks/useResize'
import { useDrag } from '@/hooks/useDrag'
import type { SourceDomain, TrackEventProperties } from '@/types/track'

// ── Domain display config ─────────────────────────────────────────
const DOMAIN_ORDER: SourceDomain[] = ['Air', 'Maritime', 'Space', 'GPS', 'Infra']

const DOMAIN_META: Record<SourceDomain, { icon: string; colorHex: string }> = {
  Air:      { icon: '✈', colorHex: '#60a5fa' },  // blue-400
  Maritime: { icon: '⚓', colorHex: '#22d3ee' },  // cyan-400
  Space:    { icon: '🛰', colorHex: '#c084fc' },  // purple-400
  GPS:      { icon: '📡', colorHex: '#f87171' },  // red-400
  Infra:    { icon: '🌐', colorHex: '#f59e0b' },  // amber-400
}

// ── Classification badge colours ──────────────────────────────────
const CLASS_COLORS: Record<string, string> = {
  Military:   '#f87171',
  Commercial: '#60a5fa',
  Government: '#fbbf24',
  Fishing:    '#4ade80',
  Passenger:  '#38bdf8',
  Cargo:      '#94a3b8',
  Tanker:     '#fb923c',
  Unknown:    '#475569',
}

function clsAbbr(cls: string): string {
  return (
    cls === 'Commercial' ? 'COM' :
    cls === 'Military'   ? 'MIL' :
    cls === 'Government' ? 'GOV' :
    cls === 'Passenger'  ? 'PAX' :
    cls === 'Unknown'    ? 'UNK' :
    cls.slice(0, 3).toUpperCase()
  )
}

// ── Drag handle: 6-dot grid ───────────────────────────────────────
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
        borderRadius: '6px',
        background: 'transparent',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.background = 'rgba(148,163,184,0.18)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
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

// ── Toggle checkbox ───────────────────────────────────────────────
function LayerToggle({
  checked,
  onChange,
  colorHex,
}: {
  checked: boolean
  onChange: () => void
  colorHex: string
}) {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onChange() }}
      style={{
        width: 18,
        height: 18,
        borderRadius: 5,
        border: `2px solid ${checked ? colorHex : 'rgba(148,163,184,0.35)'}`,
        background: checked ? `${colorHex}30` : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'all 0.15s',
      }}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <polyline
            points="1.5,5.5 4,8 8.5,2"
            stroke={colorHex}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  )
}

// ── Classification filter chips ───────────────────────────────────
// Think of this like a Boolean mask on the layer — each chip toggles one
// classification string in/out of the "hidden" set for its domain.
function ClassFilterChips({
  assets,
  hidden,
  onToggle,
}: {
  assets: TrackEventProperties[]
  hidden: string[]
  onToggle: (cls: string) => void
}) {
  const classes = useMemo(() => {
    const set = new Set<string>()
    assets.forEach((a) => set.add(a.classification ?? 'Unknown'))
    return Array.from(set).sort()
  }, [assets])

  // No point showing chips if every asset has the same classification
  if (classes.length <= 1) return null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '4px 10px 6px 28px' }}>
      {classes.map((cls) => {
        const isVisible = !hidden.includes(cls)
        const color = CLASS_COLORS[cls] ?? CLASS_COLORS.Unknown
        return (
          <div
            key={cls}
            onClick={() => onToggle(cls)}
            style={{
              padding: '2px 7px',
              borderRadius: 4,
              border: `1px solid ${isVisible ? color + '80' : 'rgba(100,116,139,0.3)'}`,
              background: isVisible ? `${color}20` : 'transparent',
              color: isVisible ? color : '#475569',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              transition: 'all 0.15s',
              userSelect: 'none',
            }}
            title={`${isVisible ? 'Hide' : 'Show'} ${cls}`}
          >
            {clsAbbr(cls)}
          </div>
        )
      })}
    </div>
  )
}

// ── Track row ─────────────────────────────────────────────────────
function TrackRow({
  asset,
  isSelected,
  onSelect,
}: {
  asset: TrackEventProperties
  isSelected: boolean
  onSelect: () => void
}) {
  const label = asset.callsign || asset.track_id
  const cls = asset.classification ?? 'Unknown'
  const clsColor = CLASS_COLORS[cls] ?? CLASS_COLORS.Unknown
  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 10px 5px 28px',
        cursor: 'pointer',
        background: isSelected ? 'rgba(20,184,166,0.18)' : 'transparent',
        borderLeft: isSelected ? '2px solid #14b8a6' : '2px solid transparent',
        transition: 'background 0.1s',
      }}
      onMouseEnter={(e) => {
        if (!isSelected)
          (e.currentTarget as HTMLDivElement).style.background = 'rgba(148,163,184,0.08)'
      }}
      onMouseLeave={(e) => {
        if (!isSelected)
          (e.currentTarget as HTMLDivElement).style.background = 'transparent'
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: 11,
          color: '#cbd5e1',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: clsColor,
          background: `${clsColor}20`,
          border: `1px solid ${clsColor}50`,
          borderRadius: 4,
          padding: '1px 5px',
          flexShrink: 0,
          textTransform: 'uppercase',
        }}
      >
        {clsAbbr(cls)}
      </span>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────
export function SourcePanel() {
  const {
    sourcePanelOpen,
    toggleSourcePanel,
    liveAssets,
    selectAsset,
    selectedTrackId,
    selectedDomain,
    flyTo,
    layers,
    setLayerEnabled,
    showCocom,
    toggleCocom,
    globeView,
    toggleGlobeView,
    classFilter,
    setClassFilter,
    spaceTrackDuration,
    setSpaceTrackDuration,
  } = useMapStore()

  const [search, setSearch] = useState('')
  // Which domains have their track list expanded
  const [expanded, setExpanded] = useState<Set<SourceDomain>>(
    () => new Set<SourceDomain>(['Air', 'Maritime'])
  )
  // Per-domain "show all" toggle (when count > MAX_VISIBLE_PER_DOMAIN)
  const MAX_VISIBLE = 12
  const [showAll, setShowAll] = useState<Set<SourceDomain>>(new Set())

  // Width resize — right-edge drag handle
  const { size: panelWidth, handleRef: resizeHandleRef, isDragging: isResizing } = useResize({
    direction: 'right',
    defaultSize: 320,
    minSize: 260,
    maxSize: 520,
    storageKey: 'sentinel.sourcePanelWidth',
  })

  // Drag-to-move — grab handle in header
  const { offset, dragHandleRef, isDragging: isDragging } = useDrag({
    storageKey: 'sentinel.sourcePanelPosition',
  })

  // Group assets by domain
  const assetsByDomain = useMemo(() => {
    const map = new Map<SourceDomain, TrackEventProperties[]>()
    for (const d of DOMAIN_ORDER) map.set(d, [])
    for (const a of liveAssets.values()) {
      const domain = a.source_domain as SourceDomain
      if (map.has(domain)) map.get(domain)!.push(a)
    }
    // Sort each group: selected asset first, then by callsign/id
    for (const [, arr] of map) {
      arr.sort((a, b) => {
        const aSelected = a.track_id === selectedTrackId && a.source_domain === selectedDomain
        const bSelected = b.track_id === selectedTrackId && b.source_domain === selectedDomain
        if (aSelected !== bSelected) return aSelected ? -1 : 1
        return (a.callsign || a.track_id).localeCompare(b.callsign || b.track_id)
      })
    }
    return map
  }, [liveAssets, selectedTrackId, selectedDomain])

  // Flat filtered list for search mode
  const filteredAssets = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    return Array.from(liveAssets.values())
      .filter((a) =>
        a.track_id.toLowerCase().includes(q) ||
        (a.callsign ?? '').toLowerCase().includes(q) ||
        (a.classification ?? '').toLowerCase().includes(q)
      )
      .sort((a, b) => (a.callsign || a.track_id).localeCompare(b.callsign || b.track_id))
      .slice(0, 200)
  }, [liveAssets, search])

  const toggleExpanded = (d: SourceDomain) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(d)) next.delete(d)
      else next.add(d)
      return next
    })
  }

  const toggleShowAll = (d: SourceDomain) => {
    setShowAll((prev) => {
      const next = new Set(prev)
      if (next.has(d)) next.delete(d)
      else next.add(d)
      return next
    })
  }

  const handleSelectTrack = (a: TrackEventProperties) => {
    selectAsset(a.track_id, a.source_domain as SourceDomain)
    if (typeof a.lon === 'number' && typeof a.lat === 'number') {
      flyTo(a.lon, a.lat, 7)
    }
  }

  // Toggle a single classification in the hidden list for a domain
  const handleToggleClass = (domain: SourceDomain, cls: string) => {
    const hidden = classFilter[domain] ?? []
    const next = hidden.includes(cls)
      ? hidden.filter((c) => c !== cls)  // remove → make visible
      : [...hidden, cls]                  // add → hide
    setClassFilter(domain, next)
  }

  // ── Collapsed / icon-only state ──────────────────────────────────
  if (!sourcePanelOpen) {
    return (
      <button
        onClick={toggleSourcePanel}
        style={{
          position: 'fixed',
          left: '12px',
          top: '82px',
          width: '44px',
          height: '44px',
          zIndex: 999999,
          border: '2px solid rgba(255,255,255,0.9)',
          background: 'rgba(15,23,42,0.92)',
          color: 'white',
          borderRadius: '12px',
          fontSize: '20px',
          cursor: 'pointer',
        }}
        title="Open track panel"
      >
        ≡
      </button>
    )
  }

  // ── Section separator ─────────────────────────────────────────────
  const SectionLabel = ({ label }: { label: string }) => (
    <div
      style={{
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: '#475569',
        padding: '10px 14px 4px',
      }}
    >
      {label}
    </div>
  )

  return (
    <div
      style={{
        position: 'fixed',
        left: '12px',
        top: '82px',
        width: panelWidth,
        height: '90vh',
        zIndex: 20,
        background: 'rgba(15, 23, 42, 0.96)',
        border: '2px solid rgba(255,255,255,0.9)',
        color: 'white',
        borderRadius: '14px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transform: `translate(${offset.x}px, ${offset.y}px)`,
        userSelect: isResizing || isDragging ? 'none' : undefined,
      }}
    >
      {/* ── Right-edge resize handle ── */}
      <div
        ref={resizeHandleRef}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          width: '8px',
          height: '100%',
          cursor: 'col-resize',
          zIndex: 10,
          background: 'transparent',
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.background = 'rgba(148,163,184,0.18)'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
        }}
      />

      {/* ── Header ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 10px 8px 6px',
          borderBottom: '1px solid rgba(148,163,184,0.22)',
          background: 'rgba(30,41,59,0.9)',
          flexShrink: 0,
        }}
      >
        <DragDots dragRef={dragHandleRef} isDragging={isDragging} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: '#5eead4' }}>
            TRACK PANEL
          </div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>
            {liveAssets.size.toLocaleString()} assets live
          </div>
        </div>
        <button
          onClick={toggleSourcePanel}
          style={{
            border: '1px solid rgba(148,163,184,0.28)',
            background: 'rgba(15,23,42,0.6)',
            color: '#94a3b8',
            borderRadius: '8px',
            padding: '4px 9px',
            fontSize: 11,
            cursor: 'pointer',
            flexShrink: 0,
          }}
          title="Collapse panel"
        >
          Hide
        </button>
      </div>

      {/* ── Search ── */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(148,163,184,0.14)', flexShrink: 0 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍  Filter callsign, ID, class…"
          style={{
            width: '100%',
            background: 'rgba(15,23,42,0.85)',
            color: 'white',
            border: '1px solid rgba(148,163,184,0.28)',
            borderRadius: '8px',
            padding: '7px 10px',
            fontSize: 12,
            boxSizing: 'border-box',
            outline: 'none',
          }}
        />
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* ── SEARCH RESULTS (flat list when query is active) ── */}
        {filteredAssets !== null ? (
          <>
            <SectionLabel label={`${filteredAssets.length} result${filteredAssets.length !== 1 ? 's' : ''}`} />
            {filteredAssets.length === 0 ? (
              <div style={{ padding: '16px 14px', fontSize: 12, color: '#475569', textAlign: 'center' }}>
                No matches
              </div>
            ) : (
              filteredAssets.map((a) => {
                const isSelected = a.track_id === selectedTrackId && a.source_domain === selectedDomain
                return (
                  <div key={`${a.source_domain}:${a.track_id}`}>
                    <TrackRow
                      asset={a}
                      isSelected={isSelected}
                      onSelect={() => handleSelectTrack(a)}
                    />
                  </div>
                )
              })
            )}
          </>
        ) : (
          <>
            {/* ── DOMAIN ROWS (grouped, collapsible) ── */}
            <SectionLabel label="Layers" />
            {DOMAIN_ORDER.map((domain) => {
              const meta = DOMAIN_META[domain]
              const layerEnabled = layers[domain]?.enabled ?? true
              const isExpanded = expanded.has(domain)
              const domainAssets = assetsByDomain.get(domain) ?? []
              const count = domainAssets.length
              const isShowingAll = showAll.has(domain)
              const visibleAssetsList = isShowingAll ? domainAssets : domainAssets.slice(0, MAX_VISIBLE)
              const hiddenCount = domainAssets.length - visibleAssetsList.length
              const hiddenClasses = classFilter[domain] ?? []

              return (
                <div key={domain}>
                  {/* Domain header row */}
                  <div
                    onClick={() => toggleExpanded(domain)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 12px 7px 10px',
                      cursor: 'pointer',
                      borderBottom: '1px solid rgba(148,163,184,0.08)',
                      background: isExpanded ? 'rgba(30,41,59,0.5)' : 'transparent',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={(e) => {
                      if (!isExpanded)
                        (e.currentTarget as HTMLDivElement).style.background = 'rgba(148,163,184,0.06)'
                    }}
                    onMouseLeave={(e) => {
                      if (!isExpanded)
                        (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                    }}
                  >
                    <LayerToggle
                      checked={layerEnabled}
                      onChange={() => setLayerEnabled(domain, !layerEnabled)}
                      colorHex={meta.colorHex}
                    />
                    <span style={{ fontSize: 14, lineHeight: 1, flexShrink: 0 }}>{meta.icon}</span>
                    <span
                      style={{
                        flex: 1,
                        fontSize: 12,
                        fontWeight: 600,
                        color: layerEnabled ? '#e2e8f0' : '#475569',
                        transition: 'color 0.15s',
                      }}
                    >
                      {domain}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: count > 0 ? meta.colorHex : '#475569',
                        background: count > 0 ? `${meta.colorHex}20` : 'rgba(71,85,105,0.2)',
                        border: `1px solid ${count > 0 ? `${meta.colorHex}40` : 'rgba(71,85,105,0.3)'}`,
                        borderRadius: 10,
                        padding: '1px 7px',
                        minWidth: 28,
                        textAlign: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {count}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        color: '#64748b',
                        flexShrink: 0,
                        transition: 'transform 0.2s',
                        display: 'inline-block',
                        transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                      }}
                    >
                      ▾
                    </span>
                  </div>

                  {/* Track list (expanded) */}
                  {isExpanded && (
                    <div style={{ borderBottom: '1px solid rgba(148,163,184,0.12)' }}>

                      {/* ── Classification filter chips ── */}
                      {count > 0 && (
                        <ClassFilterChips
                          assets={domainAssets}
                          hidden={hiddenClasses}
                          onToggle={(cls) => handleToggleClass(domain, cls)}
                        />
                      )}

                      {/* ── Space orbital track duration selector ── */}
                      {domain === 'Space' && count > 0 && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '2px 10px 6px 28px',
                          }}
                        >
                          <span
                            style={{
                              fontSize: 9,
                              color: '#64748b',
                              letterSpacing: '0.12em',
                              textTransform: 'uppercase',
                              marginRight: 2,
                              flexShrink: 0,
                            }}
                          >
                            Orbit track:
                          </span>
                          {(['1h', '24h', 'orbit'] as const).map((d) => (
                            <div
                              key={d}
                              onClick={() => setSpaceTrackDuration(d)}
                              style={{
                                padding: '2px 8px',
                                borderRadius: 4,
                                border: `1px solid ${spaceTrackDuration === d ? '#c084fc80' : 'rgba(100,116,139,0.3)'}`,
                                background: spaceTrackDuration === d ? '#c084fc20' : 'transparent',
                                color: spaceTrackDuration === d ? '#c084fc' : '#64748b',
                                fontSize: 9,
                                fontWeight: 700,
                                letterSpacing: '0.08em',
                                textTransform: 'uppercase',
                                cursor: 'pointer',
                                transition: 'all 0.15s',
                                userSelect: 'none',
                              }}
                              title={
                                d === '1h'    ? '1-hour predicted track' :
                                d === '24h'   ? '24-hour predicted track' :
                                               'One full orbital period (~90 min LEO)'
                              }
                            >
                              {d === 'orbit' ? '1 orbit' : d}
                            </div>
                          ))}
                        </div>
                      )}

                      {count === 0 ? (
                        <div
                          style={{
                            padding: '8px 14px 8px 28px',
                            fontSize: 11,
                            color: '#475569',
                            fontStyle: 'italic',
                          }}
                        >
                          No {domain} tracks live
                        </div>
                      ) : (
                        <>
                          {visibleAssetsList.map((a) => (
                            <TrackRow
                              key={`${a.source_domain}:${a.track_id}`}
                              asset={a}
                              isSelected={
                                a.track_id === selectedTrackId &&
                                a.source_domain === selectedDomain
                              }
                              onSelect={() => handleSelectTrack(a)}
                            />
                          ))}
                          {hiddenCount > 0 && (
                            <div
                              onClick={() => toggleShowAll(domain)}
                              style={{
                                padding: '5px 10px 7px 28px',
                                fontSize: 11,
                                color: '#5eead4',
                                cursor: 'pointer',
                              }}
                            >
                              {isShowingAll
                                ? '↑ Show fewer'
                                : `↓ Show ${hiddenCount} more…`}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {/* ── MAP OVERLAYS ── */}
            <SectionLabel label="Map Overlays" />

            {/* COCOM boundaries */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 12px 7px 10px',
                borderBottom: '1px solid rgba(148,163,184,0.08)',
                cursor: 'pointer',
              }}
              onClick={toggleCocom}
            >
              <LayerToggle checked={showCocom} onChange={toggleCocom} colorHex="#14b8a6" />
              <span style={{ fontSize: 14, flexShrink: 0 }}>🗺</span>
              <span
                style={{
                  flex: 1,
                  fontSize: 12,
                  fontWeight: 600,
                  color: showCocom ? '#e2e8f0' : '#475569',
                  transition: 'color 0.15s',
                }}
              >
                COCOM Boundaries
              </span>
              <span style={{ fontSize: 9, color: '#64748b', letterSpacing: '0.06em', flexShrink: 0 }}>
                AOR
              </span>
            </div>

            {/* Globe View toggle */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 12px 7px 10px',
                borderBottom: '1px solid rgba(148,163,184,0.08)',
                cursor: 'pointer',
              }}
              onClick={toggleGlobeView}
            >
              <LayerToggle checked={globeView} onChange={toggleGlobeView} colorHex="#38bdf8" />
              <span style={{ fontSize: 14, flexShrink: 0 }}>🌍</span>
              <span
                style={{
                  flex: 1,
                  fontSize: 12,
                  fontWeight: 600,
                  color: globeView ? '#e2e8f0' : '#475569',
                  transition: 'color 0.15s',
                }}
              >
                Globe View
              </span>
              <span style={{ fontSize: 9, color: '#64748b', letterSpacing: '0.06em', flexShrink: 0 }}>
                3D
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

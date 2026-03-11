/**
 * SourcePanel — left floating panel.
 *
 * Structure (top → bottom):
 *   1. Header: grab-to-move handle + title + asset count + hide button
 *   2. Search box (filters across all domains)
 *   3. Domain rows: per-domain checkbox + icon + count + collapse toggle
 *      ↳ Expanded: classification filter chips + group-by mode chips + track list/tree
 *      ↳ Space domain: orbital track duration selector + 3-axis tree (type → orbit → constellation)
 *      ↳ Air domain: flat list or airline groups (ICAO 3-char prefix)
 *      ↳ Maritime domain: flat list or flag-state groups (MMSI MID prefix)
 *   4. Map Overlays: COCOM boundaries toggle, Globe View toggle
 *
 * State stored in Zustand (layer enabled/disabled, classFilter, globeView)
 * and localStorage (panel width + drag position).
 */

import { useMemo, useState } from 'react'
import { useMapStore } from '@/store/useMapStore'
import type { LayerVisibility } from '@/store/useMapStore'
import { useResize } from '@/hooks/useResize'
import { useDrag } from '@/hooks/useDrag'
import type { SourceDomain, TrackEventProperties } from '@/types/track'
import {
  getAirlineGroup,
  getMmsiCountry,
  getConstellation,
  normalizeObjectType,
  normalizeOrbitClass,
  objectTypeSort,
  orbitClassSort,
} from '@/data/grouping'

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
        (e.currentTarget as HTMLDivElement).style.background = 'rgba(148,163,184,0.18)'
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = 'transparent'
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

// ── Tri-state layer toggle ─────────────────────────────────────────
// Three states cycle on click: active → muted → hidden → active
//   active  = filled checkmark (fully visible, in track list & alerts)
//   muted   = dash (context-only: dimmed on map, greyed in list)
//   hidden  = empty (off: not rendered, not listed, not alerted)
//
// Think of it like a camera aperture wheel — three distinct stops,
// not just open/closed.
function TriStateToggle({
  visibility,
  onCycle,
  colorHex,
}: {
  visibility: LayerVisibility
  onCycle: () => void
  colorHex: string
}) {
  const isActive = visibility === 'active'
  const isMuted  = visibility === 'muted'
  const isHidden = visibility === 'hidden'

  const borderColor = isHidden
    ? 'rgba(148,163,184,0.25)'
    : isMuted
    ? `${colorHex}60`
    : colorHex
  const bgColor = isActive
    ? `${colorHex}30`
    : isMuted
    ? `${colorHex}10`
    : 'transparent'

  const title = isActive ? 'Active — click to mute' : isMuted ? 'Muted (context only) — click to hide' : 'Hidden — click to activate'

  return (
    <div
      onClick={(e) => { e.stopPropagation(); onCycle() }}
      title={title}
      style={{
        width: 18, height: 18, borderRadius: 5,
        border: `2px solid ${borderColor}`,
        background: bgColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s',
      }}
    >
      {isActive && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <polyline points="1.5,5.5 4,8 8.5,2" stroke={colorHex} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {isMuted && (
        <svg width="10" height="4" viewBox="0 0 10 4" fill="none">
          <line x1="1" y1="2" x2="9" y2="2" stroke={colorHex} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
    </div>
  )
}

// ── Group-by mode chips ───────────────────────────────────────────
// Rendered inside a domain's expanded section, above the track list.
// Acts like a radio group: exactly one mode is active at a time.
// Analogy: think of these as "view mode" tabs for each domain —
// the same underlying data rendered differently.
function GroupByChips({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: string; label: string }>
  value: string
  onChange: (key: string) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px 5px 28px' }}>
      <span style={{ fontSize: 9, color: '#475569', letterSpacing: '0.1em', textTransform: 'uppercase', marginRight: 2, flexShrink: 0 }}>
        Group:
      </span>
      {options.map((opt) => (
        <div
          key={opt.key}
          onClick={() => onChange(opt.key)}
          title={`Group by ${opt.label}`}
          style={{
            padding: '2px 7px', borderRadius: 4,
            border: `1px solid ${value === opt.key ? 'rgba(94,234,212,0.5)' : 'rgba(100,116,139,0.25)'}`,
            background: value === opt.key ? 'rgba(20,184,166,0.12)' : 'transparent',
            color: value === opt.key ? '#5eead4' : '#64748b',
            fontSize: 9, fontWeight: 600, letterSpacing: '0.06em',
            cursor: 'pointer', transition: 'all 0.15s', userSelect: 'none',
          }}
        >
          {opt.label}
        </div>
      ))}
    </div>
  )
}

// ── Group header row ──────────────────────────────────────────────
// Collapsible section header used inside the grouped track tree.
// indent=0 is a primary group (e.g. object type), indent=1 is a
// sub-group (e.g. orbit class), indent=2 is a leaf group (constellation).
// Each level of indentation adds 14px of left padding, analogous to
// an outline-view tree control.
function GroupHeader({
  label,
  count,
  colorHex,
  isOpen,
  onToggle,
  isFilteredOut = false,
  onToggleFilter,
  indent = 0,
}: {
  label: string
  count: number
  colorHex: string
  isOpen: boolean
  onToggle: () => void
  isFilteredOut?: boolean
  onToggleFilter?: () => void
  indent?: number
}) {
  const paddingLeft = 28 + indent * 14
  const fontSize = indent === 0 ? 11 : 10
  const fontWeight = indent === 0 ? 700 : 600
  const borderTop = indent === 0 ? '1px solid rgba(148,163,184,0.07)' : 'none'
  const openColor = indent === 0 ? '#cbd5e1' : indent === 1 ? '#94a3b8' : '#64748b'
  const closedColor = indent === 0 ? '#94a3b8' : '#64748b'

  return (
    <div
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: `4px 10px 4px ${paddingLeft}px`,
        cursor: 'pointer', transition: 'background 0.1s',
        background: isOpen ? `rgba(30,41,59,${0.5 - indent * 0.12})` : 'transparent',
        borderTop,
      }}
      onMouseEnter={(e) => {
        if (!isOpen) (e.currentTarget as HTMLDivElement).style.background = 'rgba(148,163,184,0.06)'
      }}
      onMouseLeave={(e) => {
        if (!isOpen) (e.currentTarget as HTMLDivElement).style.background = 'transparent'
      }}
    >
      <span style={{
        fontSize: 9, color: '#475569', width: 10, textAlign: 'center',
        display: 'inline-block', flexShrink: 0,
        transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
        transition: 'transform 0.15s',
      }}>▾</span>
      <span style={{
        flex: 1, fontSize, fontWeight,
        color: isFilteredOut ? '#475569' : isOpen ? openColor : closedColor,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        transition: 'color 0.15s',
      }}>
        {label}
      </span>
      {onToggleFilter && (
        <span
          onClick={(e) => {
            e.stopPropagation()
            onToggleFilter()
          }}
          title={isFilteredOut ? `Show ${label}` : `Hide ${label}`}
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: isFilteredOut ? '#64748b' : '#e2e8f0',
            background: isFilteredOut ? 'rgba(71,85,105,0.18)' : 'rgba(20,184,166,0.14)',
            border: `1px solid ${isFilteredOut ? 'rgba(100,116,139,0.3)' : 'rgba(20,184,166,0.35)'}`,
            borderRadius: 8,
            padding: '1px 6px',
            flexShrink: 0,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          {isFilteredOut ? 'OFF' : 'ON'}
        </span>
      )}
      <span style={{
        fontSize: 9, fontWeight: 700,
        color: isFilteredOut ? '#94a3b8' : colorHex,
        background: isFilteredOut ? 'rgba(71,85,105,0.18)' : `${colorHex}18`,
        border: `1px solid ${isFilteredOut ? 'rgba(100,116,139,0.3)' : `${colorHex}35`}`,
        borderRadius: 8, padding: '1px 6px', flexShrink: 0,
        cursor: onToggleFilter ? 'pointer' : 'default',
      }}>
        {count}
      </span>
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
  indent = 0,
}: {
  asset: TrackEventProperties
  isSelected: boolean
  onSelect: () => void
  indent?: number
}) {
  const label = asset.callsign || asset.track_id
  const cls = asset.classification ?? 'Unknown'
  const clsColor = CLASS_COLORS[cls] ?? CLASS_COLORS.Unknown
  const paddingLeft = 28 + indent * 14
  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: `5px 10px 5px ${paddingLeft}px`,
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
    cycleLayerVisibility,
    showCocom,
    toggleCocom,
    globeView,
    toggleGlobeView,
    classFilter,
    setClassFilter,
    hiddenGroupFilters,
    toggleHiddenGroupFilter,
    clearHiddenGroupFilters,
    spaceTrackDuration,
    setSpaceTrackDuration,
    workspaceSearch,
    setWorkspaceSearch,
    declutterMode,
    toggleDeclutterMode,
  } = useMapStore()

  // Which domains have their track list expanded
  const [expanded, setExpanded] = useState<Set<SourceDomain>>(
    () => new Set<SourceDomain>()
  )
  // Per-domain "show all" toggle (when count > MAX_VISIBLE_PER_DOMAIN)
  const MAX_VISIBLE = 12
  const [showAll, setShowAll] = useState<Set<SourceDomain>>(new Set())

  // ── Grouping state ────────────────────────────────────────────────
  // Per-domain grouping mode. Defaults: Air=airline, Maritime=flag, Space=grouped.
  // Other domains (GPS, Infra) have no grouping mode.
  // Think of this like choosing a SQL GROUP BY column per domain.
  const [groupModes, setGroupModes] = useState<Partial<Record<SourceDomain, string>>>({
    Air: 'airline',
    Maritime: 'flag',
    Space: 'grouped',
  })

  // Which group headers are expanded in the tree (identified by path key).
  // Key format: "Domain:Level1" or "Domain:Level1:Level2" or "Domain:L1:L2:L3"
  // Space Payload groups open by default; Rocket Body and Debris start collapsed
  // (most analysts care about payloads, debris is noise until selected).
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(['Space:Payload'])
  )

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const isGroupFiltered = (domain: SourceDomain, key: string) => {
    const hiddenGroups = hiddenGroupFilters[domain] ?? []
    const parts = key.split(':')
    for (let i = 2; i <= parts.length; i += 1) {
      if (hiddenGroups.includes(parts.slice(0, i).join(':'))) return true
    }
    return false
  }

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

  // Flat filtered list for search mode — driven by workspace-wide search in store
  const filteredAssets = useMemo(() => {
    const q = workspaceSearch.trim().toLowerCase()
    if (!q) return null
    return Array.from(liveAssets.values())
      .filter((a) => {
        // Exclude hidden domains from search results
        if (layers[a.source_domain as keyof typeof layers]?.visibility === 'hidden') return false
        return (
          a.track_id.toLowerCase().includes(q) ||
          (a.callsign ?? '').toLowerCase().includes(q) ||
          (a.classification ?? '').toLowerCase().includes(q)
        )
      })
      .sort((a, b) => (a.callsign || a.track_id).localeCompare(b.callsign || b.track_id))
      .slice(0, 200)
  }, [liveAssets, workspaceSearch, layers])

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
          (e.currentTarget as HTMLDivElement).style.background = 'rgba(148,163,184,0.18)'
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.background = 'transparent'
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
        {/* Declutter toggle — dims non-matching tracks on the map when search is active */}
        <button
          onClick={toggleDeclutterMode}
          title={declutterMode ? 'Declutter ON — non-matching tracks are dimmed. Click to disable.' : 'Declutter OFF — enable to dim non-matching tracks on map'}
          style={{
            border: `1px solid ${declutterMode ? 'rgba(20,184,166,0.6)' : 'rgba(148,163,184,0.28)'}`,
            background: declutterMode ? 'rgba(13,148,136,0.25)' : 'rgba(15,23,42,0.6)',
            color: declutterMode ? '#5eead4' : '#64748b',
            borderRadius: '8px',
            padding: '4px 7px',
            fontSize: 11,
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'all 0.15s',
            letterSpacing: '0.04em',
          }}
        >
          {declutterMode ? '◎' : '○'}
        </button>
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
      <div style={{ padding: '8px 12px 6px', borderBottom: '1px solid rgba(148,163,184,0.14)', flexShrink: 0 }}>
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={workspaceSearch}
            onChange={(e) => setWorkspaceSearch(e.target.value)}
            placeholder="🔍  Search callsign, ID, class… (workspace-wide)"
            style={{
              width: '100%',
              background: workspaceSearch ? 'rgba(37,99,235,0.1)' : 'rgba(15,23,42,0.85)',
              color: 'white',
              border: `1px solid ${workspaceSearch ? 'rgba(59,130,246,0.5)' : 'rgba(148,163,184,0.28)'}`,
              borderRadius: '8px',
              padding: '7px 10px',
              fontSize: 12,
              boxSizing: 'border-box' as const,
              outline: 'none',
              paddingRight: workspaceSearch ? 28 : 10,
            }}
          />
          {workspaceSearch && (
            <button
              onClick={() => setWorkspaceSearch('')}
              style={{
                position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', color: '#64748b', cursor: 'pointer',
                fontSize: 14, lineHeight: 1, padding: 0,
              }}
              title="Clear search"
            >×</button>
          )}
        </div>
        {/* Active constraints summary — shows when any filters are set */}
        {(() => {
          const mutedDomains  = DOMAIN_ORDER.filter(d => layers[d]?.visibility === 'muted')
          const hiddenDomains = DOMAIN_ORDER.filter(d => layers[d]?.visibility === 'hidden')
          const totalFiltered = Object.values(classFilter).reduce((n, arr) => n + (arr?.length ?? 0), 0)
          if (!mutedDomains.length && !hiddenDomains.length && !totalFiltered && !declutterMode) return null
          return (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
              {hiddenDomains.map(d => (
                <span key={d} style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                  color: '#ef4444', background: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: 4, padding: '1px 6px', textTransform: 'uppercase',
                }} title={`${d} is hidden — click to cycle`}>
                  {d} hidden
                </span>
              ))}
              {mutedDomains.map(d => (
                <span key={d} style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                  color: '#f59e0b', background: 'rgba(245,158,11,0.1)',
                  border: '1px solid rgba(245,158,11,0.3)',
                  borderRadius: 4, padding: '1px 6px', textTransform: 'uppercase',
                }}>
                  {d} muted
                </span>
              ))}
              {totalFiltered > 0 && (
                <span style={{
                  fontSize: 9, fontWeight: 700,
                  color: '#94a3b8', background: 'rgba(148,163,184,0.1)',
                  border: '1px solid rgba(148,163,184,0.25)',
                  borderRadius: 4, padding: '1px 6px',
                }}>
                  {totalFiltered} class filter{totalFiltered > 1 ? 's' : ''}
                </span>
              )}
              {declutterMode && (
                <span style={{
                  fontSize: 9, fontWeight: 700,
                  color: '#5eead4', background: 'rgba(20,184,166,0.1)',
                  border: '1px solid rgba(20,184,166,0.3)',
                  borderRadius: 4, padding: '1px 6px',
                }}>
                  ◎ declutter
                </span>
              )}
            </div>
          )
        })()}
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
              const layerVisibility = layers[domain]?.visibility ?? 'active'
              const isMuted  = layerVisibility === 'muted'
              const isHidden = layerVisibility === 'hidden'
              const isExpanded = expanded.has(domain)
              const domainAssets = assetsByDomain.get(domain) ?? []
              const count = domainAssets.length
              const isShowingAll = showAll.has(domain)
              const visibleAssetsList = isShowingAll ? domainAssets : domainAssets.slice(0, MAX_VISIBLE)
              const hiddenCount = domainAssets.length - visibleAssetsList.length
              const hiddenClasses = classFilter[domain] ?? []
              const activeFilterCount = hiddenClasses.length
              const groupMode = groupModes[domain] ?? 'none'
              const activeGroupFilters = hiddenGroupFilters[domain] ?? []

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
                    <TriStateToggle
                      visibility={layerVisibility}
                      onCycle={() => cycleLayerVisibility(domain)}
                      colorHex={meta.colorHex}
                    />
                    <span style={{ fontSize: 14, lineHeight: 1, flexShrink: 0, opacity: isHidden ? 0.3 : 1 }}>{meta.icon}</span>
                    <span
                      style={{
                        flex: 1,
                        fontSize: 12,
                        fontWeight: 600,
                        color: isHidden ? '#374151' : isMuted ? '#64748b' : '#e2e8f0',
                        transition: 'color 0.15s',
                      }}
                    >
                      {domain}
                      {isMuted && <span style={{ fontSize: 9, fontWeight: 400, color: '#475569', marginLeft: 5 }}>MUTED</span>}
                    </span>
                    {/* Active filter count badge */}
                    {activeFilterCount > 0 && (
                      <span style={{
                        fontSize: 9, fontWeight: 700, color: '#f59e0b',
                        background: 'rgba(245,158,11,0.15)',
                        border: '1px solid rgba(245,158,11,0.3)',
                        borderRadius: 8, padding: '1px 5px', flexShrink: 0,
                        marginRight: 4,
                      }} title={`${activeFilterCount} classification filter${activeFilterCount > 1 ? 's' : ''} active`}>
                        {activeFilterCount}F
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: isHidden ? '#374151' : count > 0 ? (isMuted ? `${meta.colorHex}80` : meta.colorHex) : '#475569',
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

                      {/* ── Group-by mode selector ── */}
                      {count > 0 && (domain === 'Air' || domain === 'Maritime' || domain === 'Space') && (
                        <GroupByChips
                          options={
                            domain === 'Air'      ? [{ key: 'none', label: 'Flat' }, { key: 'airline', label: 'By Airline' }] :
                            domain === 'Maritime' ? [{ key: 'none', label: 'Flat' }, { key: 'flag',    label: 'By Flag State' }] :
                                                    [{ key: 'none', label: 'Flat' }, { key: 'grouped', label: 'Type › Orbit › Const.' }]
                          }
                          value={groupMode}
                          onChange={(m) => setGroupModes((prev) => ({ ...prev, [domain]: m }))}
                        />
                      )}

                      {activeGroupFilters.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 10px 8px 28px' }}>
                          <span style={{
                            fontSize: 9,
                            color: '#64748b',
                            letterSpacing: '0.1em',
                            textTransform: 'uppercase',
                            marginRight: 2,
                          }}>
                            Group filters:
                          </span>
                          {activeGroupFilters.slice(0, 4).map((key) => (
                            <span
                              key={key}
                              style={{
                                fontSize: 9,
                                fontWeight: 700,
                                color: '#f59e0b',
                                background: 'rgba(245,158,11,0.14)',
                                border: '1px solid rgba(245,158,11,0.32)',
                                borderRadius: 8,
                                padding: '1px 6px',
                              }}
                            >
                              {key.split(':').slice(1).join(' / ')}
                            </span>
                          ))}
                          {activeGroupFilters.length > 4 && (
                            <span style={{ fontSize: 9, color: '#94a3b8' }}>+{activeGroupFilters.length - 4}</span>
                          )}
                          <span
                            onClick={() => clearHiddenGroupFilters(domain)}
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              color: '#5eead4',
                              cursor: 'pointer',
                              userSelect: 'none',
                            }}
                            title={`Clear ${domain} group filters`}
                          >
                            Clear
                          </span>
                        </div>
                      )}

                      {/* ── Track list ── */}
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

                      // ── AIR: airline grouping ─────────────────────────────────────
                      ) : domain === 'Air' && groupMode === 'airline' ? (
                        (() => {
                          // Bucket by airline group (ICAO 3-char prefix → airline name).
                          // Analogous to a GROUP BY on the callsign prefix column.
                          const grouped = new Map<string, TrackEventProperties[]>()
                          for (const a of domainAssets) {
                            const key = getAirlineGroup(a.callsign, a.classification)
                            if (!grouped.has(key)) grouped.set(key, [])
                            grouped.get(key)!.push(a)
                          }
                          // Sort buckets by size descending (busiest airlines first)
                          const sorted = Array.from(grouped.entries())
                            .sort((a, b) => b[1].length - a[1].length)

                          return (
                            <>
                              {sorted.map(([groupName, groupAssets]) => {
                                const gKey = `Air:${groupName}`
                                const isGroupOpen = openGroups.has(gKey)
                                const isFilteredOut = isGroupFiltered(domain, gKey)
                                return (
                                  <div key={gKey}>
                                    <GroupHeader
                                      label={groupName}
                                      count={groupAssets.length}
                                      colorHex={meta.colorHex}
                                      isOpen={isGroupOpen}
                                      isFilteredOut={isFilteredOut}
                                      onToggle={() => toggleGroup(gKey)}
                                      onToggleFilter={() => toggleHiddenGroupFilter(domain, gKey)}
                                      indent={0}
                                    />
                                    {isGroupOpen && !isFilteredOut && groupAssets.map((a) => (
                                      <TrackRow
                                        key={`${a.source_domain}:${a.track_id}`}
                                        asset={a}
                                        isSelected={a.track_id === selectedTrackId && a.source_domain === selectedDomain}
                                        onSelect={() => handleSelectTrack(a)}
                                        indent={1}
                                      />
                                    ))}
                                  </div>
                                )
                              })}
                            </>
                          )
                        })()

                      // ── MARITIME: flag-state grouping ─────────────────────────────
                      ) : domain === 'Maritime' && groupMode === 'flag' ? (
                        (() => {
                          // MMSI encodes the flag state directly in its first 3 digits
                          // (Maritime Identification Digit). 100% coverage since every
                          // vessel must have an MMSI to be tracked via AIS.
                          const grouped = new Map<string, TrackEventProperties[]>()
                          for (const a of domainAssets) {
                            const key = getMmsiCountry(a.track_id)
                            if (!grouped.has(key)) grouped.set(key, [])
                            grouped.get(key)!.push(a)
                          }
                          const sorted = Array.from(grouped.entries())
                            .sort((a, b) => b[1].length - a[1].length)

                          return (
                            <>
                              {sorted.map(([country, countryAssets]) => {
                                const gKey = `Maritime:${country}`
                                const isGroupOpen = openGroups.has(gKey)
                                const isFilteredOut = isGroupFiltered(domain, gKey)
                                return (
                                  <div key={gKey}>
                                    <GroupHeader
                                      label={country}
                                      count={countryAssets.length}
                                      colorHex={meta.colorHex}
                                      isOpen={isGroupOpen}
                                      isFilteredOut={isFilteredOut}
                                      onToggle={() => toggleGroup(gKey)}
                                      onToggleFilter={() => toggleHiddenGroupFilter(domain, gKey)}
                                      indent={0}
                                    />
                                    {isGroupOpen && !isFilteredOut && countryAssets.map((a) => (
                                      <TrackRow
                                        key={`${a.source_domain}:${a.track_id}`}
                                        asset={a}
                                        isSelected={a.track_id === selectedTrackId && a.source_domain === selectedDomain}
                                        onSelect={() => handleSelectTrack(a)}
                                        indent={1}
                                      />
                                    ))}
                                  </div>
                                )
                              })}
                            </>
                          )
                        })()

                      // ── SPACE: 3-axis tree (Object Type → Orbit Class → Constellation)
                      ) : domain === 'Space' && groupMode === 'grouped' ? (
                        (() => {
                          // Three-level hierarchy: think of it as three SQL GROUP BY columns
                          // applied in sequence. The deepest level (constellation) gives the
                          // most specific operational identity — "which program is this?"
                          //
                          //  Level 0  Object Type  (Payload / Rocket Body / Debris)
                          //  Level 1  Orbit Class  (LEO / MEO / GEO / HEO)
                          //  Level 2  Constellation (Starlink, GPS, ISS, etc.)

                          // ── L0: Object Type ───────────────────────────────────────
                          const byType = new Map<string, TrackEventProperties[]>()
                          for (const a of domainAssets) {
                            const t = normalizeObjectType(a.object_type)
                            if (!byType.has(t)) byType.set(t, [])
                            byType.get(t)!.push(a)
                          }
                          const typeKeys = Array.from(byType.keys()).sort(objectTypeSort)

                          return (
                            <>
                              {typeKeys.map((objType) => {
                                const typeAssets = byType.get(objType)!
                                const typeKey = `Space:${objType}`
                                const isTypeOpen = openGroups.has(typeKey)
                                const isTypeFiltered = isGroupFiltered(domain, typeKey)

                                // ── L1: Orbit Class ─────────────────────────────────
                                const byOrbit = new Map<string, TrackEventProperties[]>()
                                for (const a of typeAssets) {
                                  const o = normalizeOrbitClass(a.orbit_class, a.orbital_period_min)
                                  if (!byOrbit.has(o)) byOrbit.set(o, [])
                                  byOrbit.get(o)!.push(a)
                                }
                                const orbitKeys = Array.from(byOrbit.keys()).sort(orbitClassSort)

                                return (
                                  <div key={typeKey}>
                                    <GroupHeader
                                      label={objType}
                                      count={typeAssets.length}
                                      colorHex={meta.colorHex}
                                      isOpen={isTypeOpen}
                                      isFilteredOut={isTypeFiltered}
                                      onToggle={() => toggleGroup(typeKey)}
                                      onToggleFilter={() => toggleHiddenGroupFilter(domain, typeKey)}
                                      indent={0}
                                    />
                                    {isTypeOpen && !isTypeFiltered && orbitKeys.map((orbitClass) => {
                                      const orbitAssets = byOrbit.get(orbitClass)!
                                      const orbitKey = `Space:${objType}:${orbitClass}`
                                      const isOrbitOpen = openGroups.has(orbitKey)
                                      const isOrbitFiltered = isGroupFiltered(domain, orbitKey)

                                      // ── L2: Constellation ──────────────────────────
                                      const byConst = new Map<string, TrackEventProperties[]>()
                                      for (const a of orbitAssets) {
                                        const c = getConstellation(a.callsign)
                                        if (!byConst.has(c)) byConst.set(c, [])
                                        byConst.get(c)!.push(a)
                                      }
                                      // Sort constellations by track count descending
                                      const constKeys = Array.from(byConst.keys())
                                        .sort((a, b) => byConst.get(b)!.length - byConst.get(a)!.length)

                                      return (
                                        <div key={orbitKey}>
                                          <GroupHeader
                                            label={orbitClass}
                                            count={orbitAssets.length}
                                            colorHex={meta.colorHex}
                                            isOpen={isOrbitOpen}
                                            isFilteredOut={isOrbitFiltered}
                                            onToggle={() => toggleGroup(orbitKey)}
                                            onToggleFilter={() => toggleHiddenGroupFilter(domain, orbitKey)}
                                            indent={1}
                                          />
                                          {isOrbitOpen && !isOrbitFiltered && constKeys.map((constellation) => {
                                            const cAssets = byConst.get(constellation)!
                                            const cKey = `Space:${objType}:${orbitClass}:${constellation}`
                                            const isCOpen = openGroups.has(cKey)
                                            const isConstellationFiltered = isGroupFiltered(domain, cKey)
                                            return (
                                              <div key={cKey}>
                                                <GroupHeader
                                                  label={constellation}
                                                  count={cAssets.length}
                                                  colorHex={meta.colorHex}
                                                  isOpen={isCOpen}
                                                  isFilteredOut={isConstellationFiltered}
                                                  onToggle={() => toggleGroup(cKey)}
                                                  onToggleFilter={() => toggleHiddenGroupFilter(domain, cKey)}
                                                  indent={2}
                                                />
                                                {isCOpen && !isConstellationFiltered && cAssets.map((a) => (
                                                  <TrackRow
                                                    key={`${a.source_domain}:${a.track_id}`}
                                                    asset={a}
                                                    isSelected={a.track_id === selectedTrackId && a.source_domain === selectedDomain}
                                                    onSelect={() => handleSelectTrack(a)}
                                                    indent={3}
                                                  />
                                                ))}
                                              </div>
                                            )
                                          })}
                                        </div>
                                      )
                                    })}
                                  </div>
                                )
                              })}
                            </>
                          )
                        })()

                      // ── FLAT LIST (all other domains, or when grouping is 'none') ──
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
              <TriStateToggle visibility={showCocom ? 'active' : 'hidden'} onCycle={toggleCocom} colorHex="#14b8a6" />
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
              <TriStateToggle visibility={globeView ? 'active' : 'hidden'} onCycle={toggleGlobeView} colorHex="#38bdf8" />
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

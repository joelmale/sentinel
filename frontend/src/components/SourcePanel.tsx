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
 *   4. Map Overlays: COCOM boundaries, undersea cables, Globe View
 *
 * State stored in Zustand (layer enabled/disabled, classFilter, globeView)
 * and localStorage (panel width + drag position).
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLiveDataStore } from '@/store/useLiveDataStore'
import { useMapStore } from '@/store/useMapStore'
import type { LayerVisibility } from '@/store/useMapStore'
import { useResizePanel } from '@/hooks/useResizePanel'
import { useDrag } from '@/hooks/useDrag'
import { trackedFetchJson } from '@/lib/perf'
import { buildTrackScopeParams } from '@/lib/trackScopes'
import type { DomainQuickScopeId, DomainScopeState, ScopedLivePreviewResponse, SourceDomain, TrackEventProperties } from '@/types/track'
import {
  getAirlineGroup,
  getConstellationCategory,
  getMmsiCountry,
  getConstellation,
  normalizeObjectType,
  normalizeOrbitClass,
  objectTypeSort,
  orbitClassSort,
  SPACE_CONSTELLATION_CATEGORY_ORDER,
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

const DOMAIN_LIST_MAX_HEIGHT = 216

const QUICK_SCOPE_OPTIONS: Record<SourceDomain, Array<{ id: DomainQuickScopeId; label: string; description: string }>> = {
  Air: [
    { id: 'military', label: 'Military', description: 'Recommended narrow starting set' },
    { id: 'commercial_sample', label: 'Commercial sample', description: 'Small representative live slice' },
    { id: 'recent_alerts', label: 'Recent alerts', description: 'Only aircraft tied to current alerts' },
    { id: 'viewport', label: 'Viewport only', description: 'Constrain to current map window' },
    { id: 'by_operator', label: 'By operator', description: 'Target a specific airline/operator' },
  ],
  Maritime: [
    { id: 'government', label: 'Government', description: 'Military and state vessels first' },
    { id: 'major_routes', label: 'Major routes', description: 'High-traffic shipping context' },
    { id: 'recent_alerts', label: 'Recent alerts', description: 'Only vessels tied to current alerts' },
    { id: 'viewport', label: 'Viewport only', description: 'Constrain to current map window' },
    { id: 'by_operator', label: 'By operator', description: 'Target a carrier or flag operator' },
  ],
  Space: [
    { id: 'watchlist', label: 'Watchlist', description: 'Recommended narrow starting set' },
    { id: 'priority_constellations', label: 'Priority constellations', description: 'Common demo fleets, not the full catalog' },
    { id: 'by_function', label: 'By function', description: 'Communications, weather, science, ISR' },
    { id: 'by_constellation', label: 'By constellation', description: 'One fleet at a time' },
    { id: 'recent_alerts', label: 'Recent alerts', description: 'Only satellites tied to current alerts' },
  ],
  GPS: [
    { id: 'active_disruptions', label: 'Active disruptions', description: 'Operationally relevant starting set' },
    { id: 'high_severity', label: 'High severity', description: 'Only the highest-scoring cells' },
    { id: 'near_selected', label: 'Near selected', description: 'Context around the active investigation' },
    { id: 'recent_alerts', label: 'Recent alerts', description: 'Only disruptions tied to current alerts' },
  ],
  Infra: [
    { id: 'active_disruptions', label: 'Active disruptions', description: 'Operationally relevant starting set' },
    { id: 'high_severity', label: 'High severity', description: 'Only the most severe outages/stress' },
    { id: 'near_selected', label: 'Near selected', description: 'Context around the active investigation' },
    { id: 'recent_alerts', label: 'Recent alerts', description: 'Only disruptions tied to current alerts' },
  ],
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

function PanelTab({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: '7px 10px',
        border: 'none',
        borderBottom: active ? '2px solid #5eead4' : '2px solid transparent',
        background: active ? 'rgba(20,184,166,0.10)' : 'transparent',
        color: active ? '#e2e8f0' : '#64748b',
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

function QuickScopeCards({
  domain,
  scope,
  previewBbox,
  alertTrackIds,
  watchedSpaceTrackIds,
  selectedTrackId,
  onSelect,
  onApply,
}: {
  domain: SourceDomain
  scope: DomainScopeState
  previewBbox: string | null
  alertTrackIds: string[]
  watchedSpaceTrackIds: string[]
  selectedTrackId: string | null
  onSelect: (scope: DomainQuickScopeId) => void
  onApply: () => void
}) {
  const options = QUICK_SCOPE_OPTIONS[domain]
  const previewParams = useMemo(() => buildTrackScopeParams({
    domain,
    scope,
    bbox: previewBbox,
    alertTrackIds,
    watchedSpaceTrackIds,
    selectedTrackId,
  }), [alertTrackIds, domain, previewBbox, scope, selectedTrackId, watchedSpaceTrackIds])
  const previewQuery = useQuery({
    queryKey: ['track-scope-preview', domain, previewParams.toString()],
    enabled: scope.selectedQuickScope !== null,
    queryFn: async (): Promise<ScopedLivePreviewResponse> => (
      trackedFetchJson<ScopedLivePreviewResponse>('track-scope-preview', `/api/tracks/live/preview?${previewParams.toString()}`)
    ),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const previewCount = previewQuery.data?.count ?? null
  const selectedScope = scope.selectedQuickScope
  const appliedScope = scope.appliedQuickScope

  return (
    <div style={{ padding: '8px 10px 10px 28px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 9, color: '#64748b', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          Quick Scope
        </span>
        <span style={{ fontSize: 10, color: previewQuery.isError ? '#fca5a5' : '#94a3b8' }}>
          {previewQuery.isError
            ? 'Preview unavailable'
            : previewCount === null
              ? 'Preview pending'
              : `${previewCount.toLocaleString()} projected`}
        </span>
        <button
          type="button"
          onClick={onApply}
          disabled={!selectedScope}
          style={{
            border: `1px solid ${selectedScope ? 'rgba(94,234,212,0.45)' : 'rgba(100,116,139,0.28)'}`,
            background: selectedScope ? 'rgba(20,184,166,0.16)' : 'rgba(15,23,42,0.5)',
            color: selectedScope ? '#99f6e4' : '#64748b',
            borderRadius: 8,
            padding: '4px 8px',
            fontSize: 10,
            fontWeight: 700,
            cursor: selectedScope ? 'pointer' : 'not-allowed',
          }}
        >
          Apply scope
        </button>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {options.map((option) => {
          const isSelected = selectedScope === option.id
          const isApplied = appliedScope === option.id
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onSelect(option.id)}
              style={{
                border: `1px solid ${isSelected ? 'rgba(96,165,250,0.42)' : 'rgba(100,116,139,0.24)'}`,
                background: isSelected ? 'rgba(30,64,175,0.18)' : 'rgba(15,23,42,0.45)',
                color: '#e2e8f0',
                borderRadius: 10,
                padding: '8px 10px',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700 }}>{option.label}</span>
                {isApplied && (
                  <span style={{
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: '0.08em',
                    color: '#5eead4',
                    textTransform: 'uppercase',
                  }}>
                    Active
                  </span>
                )}
              </div>
              <div style={{ marginTop: 4, fontSize: 10, color: '#94a3b8', lineHeight: 1.35 }}>
                {option.description}
              </div>
            </button>
          )
        })}
      </div>
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
  isExcluded = false,
  onToggleExclude,
  indent = 0,
}: {
  label: string
  count: number
  colorHex: string
  isOpen: boolean
  onToggle: () => void
  isFilteredOut?: boolean
  onToggleFilter?: () => void
  // Badge-click exclusion — dims tracks on map rather than hiding them entirely.
  // Analogy: like closing the aperture half-way vs switching the camera off.
  isExcluded?: boolean
  onToggleExclude?: () => void
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
        opacity: isExcluded ? 0.4 : 1,
      }}>▾</span>
      <span style={{
        flex: 1, fontSize, fontWeight,
        color: isFilteredOut ? '#475569' : isOpen ? openColor : closedColor,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        transition: 'color 0.15s',
        opacity: isExcluded ? 0.4 : 1,
        textDecoration: isExcluded ? 'line-through' : undefined,
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
      {/* Count badge — click to exclude (dim on map) / restore. Red tint when excluded. */}
      <span
        onClick={(e) => {
          e.stopPropagation()
          onToggleExclude?.()
        }}
        title={
          isExcluded
            ? `Restore ${label} (click to un-dim on map)`
            : onToggleExclude
              ? `Exclude ${label} — dim on map, hide from list`
              : undefined
        }
        style={{
          fontSize: 9, fontWeight: 700,
          color: isExcluded ? '#ef4444' : isFilteredOut ? '#94a3b8' : colorHex,
          background: isExcluded ? 'rgba(239,68,68,0.15)' : isFilteredOut ? 'rgba(71,85,105,0.18)' : `${colorHex}18`,
          border: `1px solid ${isExcluded ? 'rgba(239,68,68,0.4)' : isFilteredOut ? 'rgba(100,116,139,0.3)' : `${colorHex}35`}`,
          borderRadius: 8, padding: '1px 6px', flexShrink: 0,
          cursor: onToggleExclude ? 'pointer' : 'default',
          transition: 'all 0.15s',
          userSelect: 'none',
        }}
      >
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
    selectAsset,
    selectedTrackId,
    selectedDomain,
    viewportBounds,
    flyTo,
    layers,
    cycleLayerVisibility,
    showCocom,
    showUnderseaCables,
    toggleCocom,
    toggleUnderseaCables,
    globeView,
    toggleGlobeView,
    classFilter,
    setClassFilter,
    hiddenGroupFilters,
    toggleHiddenGroupFilter,
    clearHiddenGroupFilters,
    hiddenSpaceConstellations,
    toggleHiddenSpaceConstellation,
    clearHiddenSpaceConstellations,
    spaceTrackDuration,
    setSpaceTrackDuration,
    workspaceSearch,
    setWorkspaceSearch,
    domainScopes,
    setSelectedQuickScope,
    applyDomainScope,
    declutterMode,
    toggleDeclutterMode,
    setGroupExcludedTracks,
    spacePriorityOnly,
    toggleSpacePriorityOnly,
    expandedSpaceConstellations,
    toggleExpandedSpaceConstellation,
    pendingAlerts,
    watchedSpaceTrackIds,
  } = useMapStore()
  const { uiViewportAssets } = useLiveDataStore()
  const previewBbox = useMemo(() => {
    if (!viewportBounds) return null
    return [viewportBounds.west, viewportBounds.south, viewportBounds.east, viewportBounds.north].join(',')
  }, [viewportBounds])
  const alertTrackIdsByDomain = useMemo(() => {
    const grouped: Record<SourceDomain, string[]> = {
      Air: [],
      Maritime: [],
      Space: [],
      GPS: [],
      Infra: [],
    }
    for (const alert of pendingAlerts) {
      if (!grouped[alert.domain].includes(alert.trackId)) {
        grouped[alert.domain].push(alert.trackId)
      }
    }
    return grouped
  }, [pendingAlerts])

  // Which domains have their track list expanded
  const [expanded, setExpanded] = useState<Set<SourceDomain>>(
    () => new Set<SourceDomain>()
  )
  // Per-domain "show all" toggle (when count > MAX_VISIBLE_PER_DOMAIN)
  const MAX_VISIBLE = 12
  const [showAll, setShowAll] = useState<Set<SourceDomain>>(new Set())
  const [panelMode, setPanelMode] = useState<'browse' | 'workspace'>('browse')

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

  // ── Badge-click group exclusion (dim on map) ──────────────────────
  // Separate from hiddenGroupFilters (full hide): exclusion dims tracks to ~10% alpha
  // while keeping them in visibleAssets. Like a dimmer vs a kill switch.
  //
  // Key format per domain:
  //   Air:      airline group name        e.g. "Delta Air Lines"
  //   Maritime: flag-state country name   e.g. "Panama"
  //   Space:    path fragment             e.g. "Payload", "Payload:LEO", "Payload:LEO:Starlink"
  const [groupFilters, setGroupFilters] = useState<Partial<Record<SourceDomain, Set<string>>>>({})

  const toggleGroupFilter = (domain: SourceDomain, key: string) => {
    setGroupFilters((prev) => {
      const cur = new Set(prev[domain] ?? [])
      if (cur.has(key)) cur.delete(key); else cur.add(key)
      return { ...prev, [domain]: cur }
    })
  }

  const clearGroupFilters = (domain: SourceDomain) => {
    setGroupFilters((prev) => ({ ...prev, [domain]: new Set() }))
  }

  // Sync local groupFilters → store groupExcludedTracks so MapCanvas can dim them.
  // This is a derived Set computed whenever the filter or asset list changes —
  // analogous to a SQL JOIN between the exclusion keys and the live track table.
  useEffect(() => {
    const excluded = new Set<string>()
    for (const a of uiViewportAssets.values()) {
      const domain = a.source_domain as SourceDomain
      const filters = groupFilters[domain]
      if (!filters?.size) continue

      if (domain === 'Air') {
        const g = getAirlineGroup(a.callsign, a.classification)
        if (filters.has(g)) excluded.add(`${domain}:${a.track_id}`)
      } else if (domain === 'Maritime') {
        const c = getMmsiCountry(a.track_id)
        if (filters.has(c)) excluded.add(`${domain}:${a.track_id}`)
      } else if (domain === 'Space') {
        const L0 = normalizeObjectType(a.object_type)
        const L1 = normalizeOrbitClass(a.orbit_class, a.orbital_period_min)
        const L2 = getConstellation(a.callsign, a.object_type)
        const full = `${L0}:${L1}:${L2}`
        for (const f of filters) {
          if (full === f || full.startsWith(f + ':') || f === L0 || f === `${L0}:${L1}`) {
            excluded.add(`${domain}:${a.track_id}`)
            break
          }
        }
      }
    }
    setGroupExcludedTracks(excluded)
  }, [groupFilters, uiViewportAssets, setGroupExcludedTracks])

  // 2-D resize — right edge (width), bottom edge (height), corner (both)
  const {
    width: panelWidth,
    height: panelHeight,
    rightHandleRef,
    bottomHandleRef,
    cornerHandleRef,
    isDragging: isResizing,
  } = useResizePanel({
    defaultWidth: 320,
    defaultHeight: Math.round(window.innerHeight * 0.81),
    minWidth: 260,
    maxWidth: 520,
    minHeight: 300,
    maxHeight: Math.round(window.innerHeight - 120),
    storageKey: 'sentinel.sourcePanelSize',
  })

  // Drag-to-move — grab handle in header
  const { offset, dragHandleRef, isDragging: isDragging } = useDrag({
    storageKey: 'sentinel.sourcePanelPosition',
  })

  // Group assets by domain
  const rawAssetsByDomain = useMemo(() => {
    const map = new Map<SourceDomain, TrackEventProperties[]>()
    for (const d of DOMAIN_ORDER) map.set(d, [])
    for (const a of uiViewportAssets.values()) {
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
  }, [uiViewportAssets, selectedTrackId, selectedDomain])

  const assetsByDomain = useMemo(() => {
    const map = new Map<SourceDomain, TrackEventProperties[]>()
    for (const domain of DOMAIN_ORDER) {
      const filtered = (rawAssetsByDomain.get(domain) ?? []).filter((asset) => {
        if (domain === 'Space' && hiddenSpaceConstellations.includes(getConstellation(asset.callsign, asset.object_type))) return false
        return true
      })
      map.set(domain, filtered)
    }
    return map
  }, [rawAssetsByDomain, hiddenSpaceConstellations])

  // Flat filtered list for search mode — driven by workspace-wide search in store
  const filteredAssets = useMemo(() => {
    const q = workspaceSearch.trim().toLowerCase()
    if (!q) return null
    return Array.from(uiViewportAssets.values())
      .filter((a) => {
        // Exclude hidden domains from search results
        if (layers[a.source_domain as keyof typeof layers]?.visibility === 'hidden') return false
        if (a.source_domain === 'Space' && hiddenSpaceConstellations.includes(getConstellation(a.callsign, a.object_type))) return false
        return (
          a.track_id.toLowerCase().includes(q) ||
          (a.callsign ?? '').toLowerCase().includes(q) ||
          (a.classification ?? '').toLowerCase().includes(q)
        )
      })
      .sort((a, b) => (a.callsign || a.track_id).localeCompare(b.callsign || b.track_id))
      .slice(0, 200)
  }, [uiViewportAssets, workspaceSearch, layers, hiddenSpaceConstellations])

  const visibleDomains = useMemo(
    () => DOMAIN_ORDER.filter((domain) => layers[domain]?.visibility === 'active'),
    [layers]
  )
  const mutedDomains = useMemo(
    () => DOMAIN_ORDER.filter((domain) => layers[domain]?.visibility === 'muted'),
    [layers]
  )
  const hiddenDomains = useMemo(
    () => DOMAIN_ORDER.filter((domain) => layers[domain]?.visibility === 'hidden'),
    [layers]
  )
  const workspaceTrackCount = useMemo(
    () => DOMAIN_ORDER.reduce((total, domain) => (
      layers[domain]?.visibility === 'hidden'
        ? total
        : total + (assetsByDomain.get(domain)?.length ?? 0)
    ), 0),
    [assetsByDomain, layers]
  )
  const hiddenClassCount = useMemo(
    () => Object.values(classFilter).reduce((total, values) => total + (values?.length ?? 0), 0),
    [classFilter]
  )
  const hiddenGroupCount = useMemo(
    () => Object.values(hiddenGroupFilters).reduce((total, values) => total + (values?.length ?? 0), 0),
    [hiddenGroupFilters]
  )
  const excludedGroupCount = useMemo(
    () => Object.values(groupFilters).reduce((total, values) => total + (values?.size ?? 0), 0),
    [groupFilters]
  )
  const largeSpaceConstellations = useMemo(() => {
    const counts = new Map<string, number>()
    for (const asset of assetsByDomain.get('Space') ?? []) {
      const constellation = getConstellation(asset.callsign, asset.object_type)
      counts.set(constellation, (counts.get(constellation) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .filter(([, count]) => count >= 50)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
  }, [assetsByDomain])

  const spaceConstellationFilters = useMemo(() => {
    const counts = new Map<string, number>()
    for (const asset of rawAssetsByDomain.get('Space') ?? []) {
      const constellation = getConstellation(asset.callsign, asset.object_type)
      counts.set(constellation, (counts.get(constellation) ?? 0) + 1)
    }
    const byCategory = new Map<string, Array<{ constellation: string; count: number }>>()
    for (const [constellation, count] of counts.entries()) {
      const category = getConstellationCategory(constellation)
      const bucket = byCategory.get(category) ?? []
      bucket.push({ constellation, count })
      byCategory.set(category, bucket)
    }
    for (const items of byCategory.values()) {
      items.sort((a, b) => b.count - a.count || a.constellation.localeCompare(b.constellation))
    }
    return SPACE_CONSTELLATION_CATEGORY_ORDER
      .map((category) => ({
        category,
        items: (byCategory.get(category) ?? []).slice(0, 8),
      }))
      .filter((entry) => entry.items.length > 0)
  }, [rawAssetsByDomain])

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
        height: panelHeight,
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
      {/* ── Right-edge resize handle (width) ── */}
      <div
        ref={rightHandleRef}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          width: '12px',
          height: '100%',
          cursor: 'col-resize',
          zIndex: 10,
          background: 'linear-gradient(270deg, rgba(94,234,212,0.2), rgba(94,234,212,0))',
          opacity: 0.45,
          transition: 'opacity 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.opacity = '0.9'
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.opacity = '0.45'
        }}
      >
        <div style={{
          position: 'absolute',
          right: 3,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 3,
          height: 48,
          borderRadius: 999,
          background: 'rgba(226,232,240,0.45)',
          pointerEvents: 'none',
        }} />
      </div>

      {/* ── Bottom-edge resize handle (height) ── */}
      <div
        ref={bottomHandleRef}
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: 'calc(100% - 16px)',
          height: '12px',
          cursor: 'row-resize',
          zIndex: 10,
          background: 'linear-gradient(0deg, rgba(94,234,212,0.2), rgba(94,234,212,0))',
          opacity: 0.45,
          transition: 'opacity 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.opacity = '0.9'
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.opacity = '0.45'
        }}
      >
        <div style={{
          position: 'absolute',
          left: '50%',
          bottom: 3,
          transform: 'translateX(-50%)',
          width: 56,
          height: 3,
          borderRadius: 999,
          background: 'rgba(226,232,240,0.45)',
          pointerEvents: 'none',
        }} />
      </div>

      {/* ── Bottom-right corner resize handle (width + height) ── */}
      <div
        ref={cornerHandleRef}
        style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: '22px',
          height: '22px',
          cursor: 'se-resize',
          zIndex: 11,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderTopLeftRadius: '10px',
          background: 'linear-gradient(135deg, rgba(94,234,212,0), rgba(94,234,212,0.22))',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ opacity: 0.7, pointerEvents: 'none' }}>
          <path d="M4 11L11 4" stroke="#e2e8f0" strokeWidth="1.25" strokeLinecap="round" />
          <path d="M7 11L11 7" stroke="#e2e8f0" strokeWidth="1.25" strokeLinecap="round" />
          <path d="M1 11L11 1" stroke="#94a3b8" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      </div>

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
            {workspaceTrackCount.toLocaleString()} tracks in workspace
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
        <div style={{ fontSize: 9, color: '#64748b', marginTop: 6, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Workspace constraints
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
          {workspaceSearch && (
            <span style={constraintChipStyle('#3b82f6')}>
              Query active
            </span>
          )}
          {declutterMode && (
            <span style={constraintChipStyle('#14b8a6')}>
              Declutter on
            </span>
          )}
          {mutedDomains.length > 0 && (
            <span style={constraintChipStyle('#f59e0b')}>
              {mutedDomains.length} muted domain{mutedDomains.length > 1 ? 's' : ''}
            </span>
          )}
          {hiddenDomains.length > 0 && (
            <span style={constraintChipStyle('#ef4444')}>
              {hiddenDomains.length} hidden domain{hiddenDomains.length > 1 ? 's' : ''}
            </span>
          )}
          {hiddenClassCount > 0 && (
            <span style={constraintChipStyle('#94a3b8')}>
              {hiddenClassCount} class constraint{hiddenClassCount > 1 ? 's' : ''}
            </span>
          )}
          {hiddenGroupCount > 0 && (
            <span style={constraintChipStyle('#a78bfa')}>
              {hiddenGroupCount} group hide rule{hiddenGroupCount > 1 ? 's' : ''}
            </span>
          )}
          {excludedGroupCount > 0 && (
            <span style={constraintChipStyle('#f87171')}>
              {excludedGroupCount} exclusion{excludedGroupCount > 1 ? 's' : ''}
            </span>
          )}
          {!workspaceSearch && !declutterMode && mutedDomains.length === 0 && hiddenDomains.length === 0 && hiddenClassCount === 0 && hiddenGroupCount === 0 && excludedGroupCount === 0 && (
            <span style={{ fontSize: 10, color: '#475569' }}>
              No active constraints
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid rgba(148,163,184,0.14)', flexShrink: 0 }}>
        <PanelTab label="Browse" active={panelMode === 'browse'} onClick={() => setPanelMode('browse')} />
        <PanelTab label="Workspace" active={panelMode === 'workspace'} onClick={() => setPanelMode('workspace')} />
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {panelMode === 'browse' ? (
          <>
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
            <SectionLabel label="Track Domains" />
            {DOMAIN_ORDER.map((domain) => {
              const meta = DOMAIN_META[domain]
              const layerVisibility = layers[domain]?.visibility ?? 'active'
              const isMuted  = layerVisibility === 'muted'
              const isHidden = layerVisibility === 'hidden'
              const isExpanded = expanded.has(domain)
              const domainAssets = assetsByDomain.get(domain) ?? []
              const rawDomainAssets = rawAssetsByDomain.get(domain) ?? []
              const count = domainAssets.length
              const totalCount = rawDomainAssets.length
              const isShowingAll = showAll.has(domain)
              const visibleAssetsList = isShowingAll ? domainAssets : domainAssets.slice(0, MAX_VISIBLE)
              const hiddenCount = domainAssets.length - visibleAssetsList.length
              const domainScope = domainScopes[domain]
              const hasAppliedScope = domainScope.appliedQuickScope !== null
              const hiddenClasses = classFilter[domain] ?? []
              const activeFilterCount = hiddenClasses.length
              const groupMode = groupModes[domain] ?? 'none'
              const activeGroupFilters = hiddenGroupFilters[domain] ?? []
              // Badge-click exclusion keys for this domain (dim on map, hide from list)
              const activeFilters = groupFilters[domain] ?? new Set<string>()

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
                      title={totalCount > count ? `${count} shown of ${totalCount} loaded` : `${count} loaded`}
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
                      <QuickScopeCards
                        domain={domain}
                        scope={domainScope}
                        previewBbox={previewBbox}
                        alertTrackIds={alertTrackIdsByDomain[domain]}
                        watchedSpaceTrackIds={Array.from(watchedSpaceTrackIds)}
                        selectedTrackId={selectedTrackId}
                        onSelect={(scope) => setSelectedQuickScope(domain, scope)}
                        onApply={() => applyDomainScope(domain)}
                      />

                      {!hasAppliedScope && (
                        <div style={{ padding: '0 10px 12px 28px', fontSize: 11, color: '#64748b', lineHeight: 1.45 }}>
                          Choose a quick scope first. Sentinel should narrow to a useful subset before loading a dense domain into the map.
                        </div>
                      )}

                      {/* ── Classification filter chips ── */}
                      {hasAppliedScope && count > 0 && (
                        <ClassFilterChips
                          assets={domainAssets}
                          hidden={hiddenClasses}
                          onToggle={(cls) => handleToggleClass(domain, cls)}
                        />
                      )}

                      {/* ── Space orbital track duration selector ── */}
                      {hasAppliedScope && domain === 'Space' && count > 0 && (
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
                      {hasAppliedScope && count > 0 && (domain === 'Air' || domain === 'Maritime' || domain === 'Space') && (
                        <GroupByChips
                          options={
                            domain === 'Air'      ? [{ key: 'none', label: 'Flat' }, { key: 'airline', label: 'By Airline' }] :
                            domain === 'Maritime' ? [{ key: 'none', label: 'Flat' }, { key: 'flag',    label: 'By Flag State' }] :
                                                    [{ key: 'none', label: 'Flat' }, { key: 'grouped', label: 'Type › Orbit › Const.' }]
                          }
                          value={groupMode}
                          onChange={(m) => {
                            setGroupModes((prev) => ({ ...prev, [domain]: m }))
                            // Clear exclusions when switching to Flat — the group keys no longer apply
                            if (m === 'none') clearGroupFilters(domain)
                          }}
                        />
                      )}

                      {hasAppliedScope && domain === 'Space' && spaceConstellationFilters.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 10px 8px 28px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{
                              fontSize: 9,
                              color: '#64748b',
                              letterSpacing: '0.1em',
                              textTransform: 'uppercase',
                            }}>
                              Constellations
                            </span>
                            {hiddenSpaceConstellations.length > 0 && (
                              <button
                                type="button"
                                onClick={clearHiddenSpaceConstellations}
                                style={{
                                  border: 'none',
                                  background: 'transparent',
                                  color: '#5eead4',
                                  fontSize: 9,
                                  fontWeight: 700,
                                  cursor: 'pointer',
                                  padding: 0,
                                }}
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          {spaceConstellationFilters.map(({ category, items }) => (
                            <div key={category} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8' }}>{category}</span>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {items.map(({ constellation, count }) => {
                                  const hidden = hiddenSpaceConstellations.includes(constellation)
                                  return (
                                    <button
                                      key={constellation}
                                      type="button"
                                      onClick={() => toggleHiddenSpaceConstellation(constellation)}
                                      style={{
                                        borderRadius: 999,
                                        border: `1px solid ${hidden ? 'rgba(239,68,68,0.35)' : 'rgba(192,132,252,0.28)'}`,
                                        background: hidden ? 'rgba(127,29,29,0.28)' : 'rgba(88,28,135,0.18)',
                                        color: hidden ? '#fca5a5' : '#e9d5ff',
                                        fontSize: 10,
                                        fontWeight: 700,
                                        lineHeight: 1.2,
                                        padding: '4px 8px',
                                        cursor: 'pointer',
                                      }}
                                      title={`${hidden ? 'Show' : 'Hide'} ${constellation}`}
                                    >
                                      {constellation} · {count}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
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

                      {/* ── Active exclusion strip (badge-click dim exclusions) ── */}
                      {activeFilters.size > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 10px 8px 28px', alignItems: 'center' }}>
                          <span style={{
                            fontSize: 9, color: '#64748b',
                            letterSpacing: '0.1em', textTransform: 'uppercase', marginRight: 2, flexShrink: 0,
                          }}>
                            Excluded:
                          </span>
                          {Array.from(activeFilters).map((key) => (
                            <span
                              key={key}
                              onClick={() => toggleGroupFilter(domain, key)}
                              title={`Restore ${key}`}
                              style={{
                                fontSize: 9, fontWeight: 700,
                                color: '#ef4444',
                                background: 'rgba(239,68,68,0.12)',
                                border: '1px solid rgba(239,68,68,0.35)',
                                borderRadius: 8, padding: '1px 6px',
                                cursor: 'pointer', userSelect: 'none',
                              }}
                            >
                              {key} ×
                            </span>
                          ))}
                          <span
                            onClick={() => clearGroupFilters(domain)}
                            title={`Clear all ${domain} exclusions`}
                            style={{
                              fontSize: 9, fontWeight: 700,
                              color: '#5eead4',
                              cursor: 'pointer', userSelect: 'none', marginLeft: 4,
                            }}
                          >
                            Clear all
                          </span>
                        </div>
                      )}

                      {/* ── Track list ── */}
                      {hasAppliedScope && (count === 0 ? (
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
                        <div
                          style={{
                            maxHeight: DOMAIN_LIST_MAX_HEIGHT,
                            overflowY: 'auto',
                            overscrollBehavior: 'contain',
                            borderTop: '1px solid rgba(148,163,184,0.08)',
                          }}
                        >

                      {/* ── AIR: airline grouping ───────────────────────────────────── */}
                      {domain === 'Air' && groupMode === 'airline' ? (
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
                                const isExcluded = activeFilters.has(groupName)
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
                                      isExcluded={isExcluded}
                                      onToggleExclude={() => toggleGroupFilter(domain, groupName)}
                                      indent={0}
                                    />
                                    {isGroupOpen && !isFilteredOut && !isExcluded && groupAssets.map((a) => (
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
                                const isExcluded = activeFilters.has(country)
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
                                      isExcluded={isExcluded}
                                      onToggleExclude={() => toggleGroupFilter(domain, country)}
                                      indent={0}
                                    />
                                    {isGroupOpen && !isFilteredOut && !isExcluded && countryAssets.map((a) => (
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
                                const isTypeExcluded = activeFilters.has(objType)

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
                                      isExcluded={isTypeExcluded}
                                      onToggleExclude={() => toggleGroupFilter(domain, objType)}
                                      indent={0}
                                    />
                                    {isTypeOpen && !isTypeFiltered && !isTypeExcluded && orbitKeys.map((orbitClass) => {
                                      const orbitAssets = byOrbit.get(orbitClass)!
                                      const orbitKey = `Space:${objType}:${orbitClass}`
                                      const orbitFilterKey = `${objType}:${orbitClass}`
                                      const isOrbitOpen = openGroups.has(orbitKey)
                                      const isOrbitFiltered = isGroupFiltered(domain, orbitKey)
                                      const isOrbitExcluded = activeFilters.has(orbitFilterKey)

                                      // ── L2: Constellation ──────────────────────────
                                      const byConst = new Map<string, TrackEventProperties[]>()
                                      for (const a of orbitAssets) {
                                        const c = getConstellation(a.callsign, a.object_type)
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
                                            isExcluded={isOrbitExcluded}
                                            onToggleExclude={() => toggleGroupFilter(domain, orbitFilterKey)}
                                            indent={1}
                                          />
                                          {isOrbitOpen && !isOrbitFiltered && !isOrbitExcluded && constKeys.map((constellation) => {
                                            const cAssets = byConst.get(constellation)!
                                            const cKey = `Space:${objType}:${orbitClass}:${constellation}`
                                            const constFilterKey = `${objType}:${orbitClass}:${constellation}`
                                            const isCOpen = openGroups.has(cKey)
                                            const isConstellationFiltered = isGroupFiltered(domain, cKey)
                                            const isConstExcluded = activeFilters.has(constFilterKey)
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
                                                  isExcluded={isConstExcluded}
                                                  onToggleExclude={() => toggleGroupFilter(domain, constFilterKey)}
                                                  indent={2}
                                                />
                                                {isCOpen && !isConstellationFiltered && !isConstExcluded && cAssets.map((a) => (
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
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

              </>
            )}
          </>
        ) : (
          <>
            <SectionLabel label="Workspace Scope" />
            {DOMAIN_ORDER.map((domain) => {
              const meta = DOMAIN_META[domain]
              const visibility = layers[domain]?.visibility ?? 'hidden'
              const domainCount = assetsByDomain.get(domain)?.length ?? 0
              const hiddenClasses = classFilter[domain] ?? []
              const groupHides = hiddenGroupFilters[domain] ?? []
              const exclusions = groupFilters[domain]?.size ?? 0

              return (
                <div
                  key={domain}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px 8px 10px',
                    borderBottom: '1px solid rgba(148,163,184,0.08)',
                  }}
                >
                  <TriStateToggle
                    visibility={visibility}
                    onCycle={() => cycleLayerVisibility(domain)}
                    colorHex={meta.colorHex}
                  />
                  <span style={{ fontSize: 14, flexShrink: 0 }}>{meta.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0' }}>{domain}</div>
                    <div style={{ fontSize: 10, color: '#64748b' }}>
                      {visibility === 'active' ? 'Active in workspace' : visibility === 'muted' ? 'Context only' : 'Hidden from workspace'}
                      {' · '}
                      {domainCount.toLocaleString()} track{domainCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                  {(hiddenClasses.length + groupHides.length + exclusions) > 0 && (
                    <span style={{
                      fontSize: 9,
                      fontWeight: 700,
                      color: '#f59e0b',
                      background: 'rgba(245,158,11,0.14)',
                      border: '1px solid rgba(245,158,11,0.30)',
                      borderRadius: 8,
                      padding: '1px 6px',
                    }}>
                      {hiddenClasses.length + groupHides.length + exclusions} constraints
                    </span>
                  )}
                </div>
              )
            })}

            <SectionLabel label="Space Rendering" />
            <div style={{ padding: '8px 12px 10px', display: 'grid', gap: 10 }}>
              <div style={summaryBlockStyle}>
                <div style={summaryLabelStyle}>Priority set</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.45 }}>
                    Selected, alerted, watched, and search-matching satellites stay interactive.
                  </div>
                  <button
                    onClick={toggleSpacePriorityOnly}
                    style={{
                      border: `1px solid ${spacePriorityOnly ? 'rgba(192,132,252,0.42)' : 'rgba(100,116,139,0.35)'}`,
                      background: spacePriorityOnly ? 'rgba(168,85,247,0.16)' : 'rgba(30,41,59,0.55)',
                      color: spacePriorityOnly ? '#d8b4fe' : '#cbd5e1',
                      borderRadius: 999,
                      padding: '6px 10px',
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    {spacePriorityOnly ? 'Priority only' : 'All individuals'}
                  </button>
                </div>
              </div>
              {largeSpaceConstellations.length > 0 && (
                <div style={summaryBlockStyle}>
                  <div style={summaryLabelStyle}>Expanded constellations</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.45, marginBottom: 8 }}>
                    Large constellations stay aggregated by default. Expand only when needed.
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {largeSpaceConstellations.map(([constellation, count]) => {
                      const expanded = expandedSpaceConstellations.has(constellation)
                      return (
                        <button
                          key={constellation}
                          onClick={() => toggleExpandedSpaceConstellation(constellation)}
                          style={{
                            border: `1px solid ${expanded ? 'rgba(96,165,250,0.45)' : 'rgba(100,116,139,0.35)'}`,
                            background: expanded ? 'rgba(59,130,246,0.16)' : 'rgba(15,23,42,0.52)',
                            color: expanded ? '#bfdbfe' : '#cbd5e1',
                            borderRadius: 999,
                            padding: '4px 8px',
                            fontSize: 10,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                          title={`${expanded ? 'Collapse' : 'Expand'} ${constellation}`}
                        >
                          {constellation} · {count}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            <SectionLabel label="Context Layers" />

            <div
              style={workspaceRowStyle}
              onClick={toggleCocom}
            >
              <TriStateToggle visibility={showCocom ? 'active' : 'hidden'} onCycle={toggleCocom} colorHex="#14b8a6" />
              <span style={{ fontSize: 14, flexShrink: 0 }}>🗺</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: showCocom ? '#e2e8f0' : '#64748b' }}>COCOM Boundaries</div>
                <div style={{ fontSize: 10, color: '#64748b' }}>Area-of-responsibility context</div>
              </div>
            </div>

            <div
              style={workspaceRowStyle}
              onClick={toggleUnderseaCables}
            >
              <TriStateToggle visibility={showUnderseaCables ? 'active' : 'hidden'} onCycle={toggleUnderseaCables} colorHex="#f59e0b" />
              <span style={{ fontSize: 14, flexShrink: 0 }}>🪢</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: showUnderseaCables ? '#e2e8f0' : '#64748b' }}>Undersea Cables</div>
                <div style={{ fontSize: 10, color: '#64748b' }}>Infrastructure and landing-point context</div>
              </div>
            </div>

            <div
              style={workspaceRowStyle}
              onClick={toggleGlobeView}
            >
              <TriStateToggle visibility={globeView ? 'active' : 'hidden'} onCycle={toggleGlobeView} colorHex="#38bdf8" />
              <span style={{ fontSize: 14, flexShrink: 0 }}>🌍</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: globeView ? '#e2e8f0' : '#64748b' }}>Globe View</div>
                <div style={{ fontSize: 10, color: '#64748b' }}>3D context for global monitoring</div>
              </div>
            </div>

            <SectionLabel label="Workspace Summary" />
            <div style={{ padding: '8px 12px 14px', display: 'grid', gap: 8 }}>
              <div style={summaryBlockStyle}>
                <div style={summaryLabelStyle}>Search</div>
                <div style={summaryValueStyle}>
                  {workspaceSearch ? `"${workspaceSearch}"` : 'No active query'}
                </div>
              </div>
              <div style={summaryBlockStyle}>
                <div style={summaryLabelStyle}>Domain scope</div>
                <div style={summaryValueStyle}>
                  {visibleDomains.length} active · {mutedDomains.length} muted · {hiddenDomains.length} hidden
                </div>
              </div>
              <div style={summaryBlockStyle}>
                <div style={summaryLabelStyle}>Filter pressure</div>
                <div style={summaryValueStyle}>
                  {hiddenClassCount + hiddenGroupCount + excludedGroupCount > 0
                    ? `${hiddenClassCount} class, ${hiddenGroupCount} group-hide, ${excludedGroupCount} exclusion`
                    : 'No additional filter pressure'}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const constraintChipStyle = (color: string): React.CSSProperties => ({
  fontSize: 9,
  fontWeight: 700,
  color,
  background: `${color}14`,
  border: `1px solid ${color}35`,
  borderRadius: 4,
  padding: '1px 6px',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
})

const workspaceRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px 8px 10px',
  borderBottom: '1px solid rgba(148,163,184,0.08)',
  cursor: 'pointer',
}

const summaryBlockStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 10,
  background: 'rgba(15,23,42,0.5)',
  border: '1px solid rgba(148,163,184,0.10)',
}

const summaryLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: '#64748b',
  marginBottom: 3,
}

const summaryValueStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#cbd5e1',
}

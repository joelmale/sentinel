/**
 * AssetCard — right floating panel ("baseball card" for a selected asset).
 *
 * Air domain enhancements:
 *   - Hero aircraft photo fetched from Planespotters.net by registration
 *   - Country flag emoji next to origin country
 *   - Registration, ICAO type code + human description, ADS-B category
 *   - Airborne / On Ground status indicator
 *   - Domain-aware search button → Google search for the selected asset
 *
 * Space domain enhancements:
 *   - Orbit class badge (LEO / MEO / GEO / SSO / HEO)
 *   - Country flag from SATCAT country code
 *   - International designator, RCS size, launch date
 *
 * Layout: stat grid with 2-column cells. Left-edge drag = resize width.
 */

import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { trackedFetchJson } from '@/lib/perf'
import { useLiveDataStore } from '@/store/useLiveDataStore'
import { useMapStore } from '@/store/useMapStore'
import { useResize } from '@/hooks/useResize'
import { useDrag } from '@/hooks/useDrag'
import type {
  MaritimeEnrichmentResponse,
  SatelliteCatalogEntry,
  SatelliteFieldStatus,
  SatelliteTleResponse,
  SourceDomain,
} from '@/types/track'

// ── Domain colour/icon config ─────────────────────────────────────
const DOMAIN_META: Record<SourceDomain, { icon: string; color: string; border: string; accent: string }> = {
  Air:      { icon: '✈',  color: 'text-blue-400',   border: 'border-blue-500/60',   accent: '#3b82f6' },
  Maritime: { icon: '⚓',  color: 'text-cyan-400',   border: 'border-cyan-500/60',   accent: '#06b6d4' },
  Space:    { icon: '🛰', color: 'text-purple-400', border: 'border-purple-500/60', accent: '#a855f7' },
  GPS:      { icon: '📡', color: 'text-red-400',    border: 'border-red-500/60',    accent: '#ef4444' },
  Infra:    { icon: '🌐', color: 'text-amber-400',  border: 'border-amber-500/60',  accent: '#f59e0b' },
}

const CLASSIFICATION_STYLES: Record<string, string> = {
  Military:   'bg-red-700/80 text-red-100 border border-red-500/60',
  Commercial: 'bg-blue-700/80 text-blue-100 border border-blue-500/60',
  Government: 'bg-yellow-700/80 text-yellow-100 border border-yellow-500/60',
  Fishing:    'bg-green-700/80 text-green-100 border border-green-500/60',
  Passenger:  'bg-sky-700/80 text-sky-100 border border-sky-500/60',
  Cargo:      'bg-slate-600/80 text-slate-200 border border-slate-500/60',
  Tanker:     'bg-orange-700/80 text-orange-100 border border-orange-500/60',
  Unknown:    'bg-slate-700/60 text-slate-400 border border-slate-600/60',
}

// ── Country name → ISO-2 → flag emoji ────────────────────────────
// Covers the vast majority of OpenSky origin_country values.
const COUNTRY_ISO2: Record<string, string> = {
  'United States': 'US', 'United States of America': 'US', 'USA': 'US',
  'United Kingdom': 'GB', 'Great Britain': 'GB',
  'Germany': 'DE', 'France': 'FR', 'Spain': 'ES', 'Italy': 'IT',
  'Netherlands': 'NL', 'Belgium': 'BE', 'Switzerland': 'CH', 'Austria': 'AT',
  'Sweden': 'SE', 'Norway': 'NO', 'Denmark': 'DK', 'Finland': 'FI',
  'Portugal': 'PT', 'Poland': 'PL', 'Czech Republic': 'CZ', 'Hungary': 'HU',
  'Romania': 'RO', 'Greece': 'GR', 'Turkey': 'TR', 'Russia': 'RU',
  'Ukraine': 'UA', 'China': 'CN', 'Japan': 'JP', 'South Korea': 'KR',
  'Korea': 'KR', 'India': 'IN', 'Australia': 'AU', 'New Zealand': 'NZ',
  'Canada': 'CA', 'Mexico': 'MX', 'Brazil': 'BR', 'Argentina': 'AR',
  'Chile': 'CL', 'Colombia': 'CO', 'Peru': 'PE',
  'United Arab Emirates': 'AE', 'UAE': 'AE', 'Saudi Arabia': 'SA',
  'Qatar': 'QA', 'Kuwait': 'KW', 'Oman': 'OM', 'Bahrain': 'BH',
  'Israel': 'IL', 'Egypt': 'EG', 'South Africa': 'ZA', 'Nigeria': 'NG',
  'Kenya': 'KE', 'Ethiopia': 'ET', 'Morocco': 'MA',
  'Singapore': 'SG', 'Malaysia': 'MY', 'Indonesia': 'ID', 'Thailand': 'TH',
  'Philippines': 'PH', 'Vietnam': 'VN', 'Pakistan': 'PK',
  'Ireland': 'IE', 'Luxembourg': 'LU', 'Iceland': 'IS',
  'Hong Kong': 'HK', 'Taiwan': 'TW',
  // Space-Track SATCAT country codes (different format)
  'US': 'US', 'PRC': 'CN', 'CIS': 'RU', 'UK': 'GB', 'ESA': 'EU',
  'JPN': 'JP', 'IND': 'IN', 'ISR': 'IL', 'SPN': 'ES', 'FRAN': 'FR',
  'AUS': 'AU', 'CAN': 'CA', 'KOR': 'KR', 'GER': 'DE', 'ITSO': 'EU',
  'NATO': 'UN',
}

function countryToFlag(name: string | null | undefined): string {
  if (!name) return ''
  const iso2 = COUNTRY_ISO2[name] || COUNTRY_ISO2[name.trim()]
  if (!iso2 || iso2.length !== 2) return ''
  // Unicode regional indicator trick: 'A' = U+1F1E6 ... 'Z' = U+1F1FF
  return iso2.toUpperCase().split('').map(c =>
    String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)
  ).join('')
}

// ── ADS-B category descriptions ───────────────────────────────────
const CATEGORY_DESC: Record<string, string> = {
  A0: 'No info', A1: 'Light', A2: 'Small', A3: 'Large',
  A4: 'High-vortex', A5: 'Heavy', A6: 'High-perf', A7: 'Rotorcraft',
  B0: 'No info', B1: 'Glider', B2: 'Lighter-than-air', B3: 'Parachutist',
  B4: 'Ultralight', B6: 'UAV', B7: 'Space',
  C1: 'Surface vehicle', C2: 'Service vehicle', C3: 'Fixed obstacle',
}

// ── Common ICAO type code → readable name ─────────────────────────
const TYPE_NAMES: Record<string, string> = {
  B738: 'Boeing 737-800', B737: 'Boeing 737-700', B739: 'Boeing 737-900',
  B77W: 'Boeing 777-300ER', B772: 'Boeing 777-200', B77L: 'Boeing 777-200LR',
  B788: 'Boeing 787-8', B789: 'Boeing 787-9', B78X: 'Boeing 787-10',
  B748: 'Boeing 747-8', B744: 'Boeing 747-400', B763: 'Boeing 767-300',
  B753: 'Boeing 757-300', B752: 'Boeing 757-200',
  A320: 'Airbus A320', A319: 'Airbus A319', A321: 'Airbus A321',
  A20N: 'Airbus A320neo', A21N: 'Airbus A321neo',
  A332: 'Airbus A330-200', A333: 'Airbus A330-300', A339: 'Airbus A330-900neo',
  A359: 'Airbus A350-900', A35K: 'Airbus A350-1000',
  A388: 'Airbus A380-800', A306: 'Airbus A300-600',
  E170: 'Embraer 170', E175: 'Embraer 175', E190: 'Embraer 190', E195: 'Embraer 195',
  E75L: 'Embraer 175 L1', E7W5: 'Embraer 175',
  CRJ2: 'Bombardier CRJ-200', CRJ7: 'Bombardier CRJ-700', CRJ9: 'Bombardier CRJ-900',
  DH8D: 'Bombardier Q400', AT75: 'ATR 72-500', AT76: 'ATR 72-600',
  C172: 'Cessna 172', C208: 'Cessna Caravan', PC12: 'Pilatus PC-12',
  LJ60: 'Learjet 60', C56X: 'Cessna Citation', GL7T: 'Gulfstream G700',
  B06: 'Bell 206', AS32: 'AS332 Super Puma', EC35: 'Airbus H135',
  // Military
  F16: 'F-16 Fighting Falcon', F18: 'F/A-18 Hornet', F35: 'F-35 Lightning II',
  B52: 'B-52 Stratofortress', KC135: 'KC-135 Stratotanker', C17: 'C-17 Globemaster',
  C130: 'C-130 Hercules', P8: 'P-8 Poseidon', E3TF: 'E-3 Sentry (AWACS)',
}

function typeDescription(code: string | null | undefined): string | null {
  if (!code) return null
  return TYPE_NAMES[code.toUpperCase()] || null
}

// ── Planespotters photo cache (module-level, persists across re-renders) ──
// Keyed by registration. Stores the resolved photo URL or null (no photo found).
interface AircraftPhotoResult {
  photoUrl: string | null
  photographer: string | null
  photoLink: string | null
}

const photoCache = new Map<string, AircraftPhotoResult | null>()

interface PlanespottersResponse {
  photos: Array<{
    thumbnail: { src: string; size: { width: number; height: number } }
    thumbnail_large: { src: string; size: { width: number; height: number } }
    link: string
    photographer: string
  }>
}

// ── Baseball-card stat cell ───────────────────────────────────────
function StatCell({
  label,
  value,
  mono = false,
  fullWidth = false,
  accent,
}: {
  label: string
  value: string | number | null | undefined
  mono?: boolean
  fullWidth?: boolean
  accent?: boolean
}) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div style={{ gridColumn: fullWidth ? '1 / -1' : undefined }}>
      <div style={{
        fontSize: '9px', fontWeight: 700, letterSpacing: '0.13em',
        color: '#64748b', textTransform: 'uppercase', marginBottom: '3px',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: '12px', fontWeight: 600, lineHeight: 1.35,
        color: accent ? '#93c5fd' : '#e2e8f0',
        fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
      }}>
        {value}
      </div>
    </div>
  )
}

// ── Stat section: titled block with 2-col grid ────────────────────
function StatSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(148,163,184,0.10)' }}>
      <div style={{
        fontSize: '9px', fontWeight: 800, letterSpacing: '0.16em',
        color: '#475569', textTransform: 'uppercase', marginBottom: '8px',
      }}>
        {title}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
        {children}
      </div>
    </div>
  )
}

// ── Small pill / badge ────────────────────────────────────────────
function Pill({ children, color = 'slate' }: { children: React.ReactNode; color?: string }) {
  const colors: Record<string, string> = {
    slate:  'background: rgba(71,85,105,0.6); color: #cbd5e1; border-color: rgba(100,116,139,0.4)',
    blue:   'background: rgba(37,99,235,0.25); color: #93c5fd; border-color: rgba(59,130,246,0.4)',
    green:  'background: rgba(21,128,61,0.25); color: #86efac; border-color: rgba(34,197,94,0.4)',
    red:    'background: rgba(185,28,28,0.25); color: #fca5a5; border-color: rgba(239,68,68,0.4)',
    purple: 'background: rgba(126,34,206,0.25); color: #d8b4fe; border-color: rgba(168,85,247,0.4)',
    amber:  'background: rgba(146,64,14,0.25); color: #fcd34d; border-color: rgba(245,158,11,0.4)',
    cyan:   'background: rgba(14,116,144,0.25); color: #67e8f9; border-color: rgba(6,182,212,0.4)',
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em',
      padding: '2px 7px', borderRadius: '20px', border: '1px solid',
      ...(Object.fromEntries((colors[color] || colors.slate).split('; ').map(s => {
        const [k, v] = s.split(': ')
        return [k.trim(), v?.trim()]
      }))),
    }}>
      {children}
    </span>
  )
}

// ── Orbit class → pill color ──────────────────────────────────────
const ORBIT_PILL_COLOR: Record<string, string> = {
  LEO: 'blue', SSO: 'cyan', MEO: 'purple', GEO: 'amber', HEO: 'red',
}

// ── Formatting helpers ────────────────────────────────────────────
function fmtAlt(m: number | undefined | null): string | null {
  if (m == null) return null
  const ft = Math.round(m * 3.28084)
  return `${Math.round(m).toLocaleString()} m · ${ft.toLocaleString()} ft`
}

function fmtSpeed(mps: number | undefined | null): string | null {
  if (mps == null) return null
  const kts = (mps * 1.94384).toFixed(1)
  const kmh = (mps * 3.6).toFixed(1)
  return `${kts} kts · ${kmh} km/h`
}

function fmtHeading(deg: number | undefined | null): string | null {
  if (deg == null) return null
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  const dir = dirs[Math.round(deg / 22.5) % 16]
  return `${deg.toFixed(1)}°  ${dir}`
}

function fmtCoord(lon: number | undefined, lat: number | undefined): string | null {
  if (lon == null || lat == null) return null
  const latDir = lat >= 0 ? 'N' : 'S'
  const lonDir = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(4)}° ${latDir},  ${Math.abs(lon).toFixed(4)}° ${lonDir}`
}

function fmtTime(iso: string | undefined): string | null {
  if (!iso) return null
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) }
  catch { return iso }
}

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleDateString()
  } catch {
    return iso
  }
}

function fmtVertRate(mps: number | null | undefined): string | null {
  if (mps == null) return null
  const fpm = Math.round(mps * 196.85)
  const arrow = mps > 1 ? '↑' : mps < -1 ? '↓' : '→'
  return `${arrow} ${Math.abs(fpm).toLocaleString()} ft/min`
}

function getAssetSearchLabel(
  domain: SourceDomain,
  callsign: string | null | undefined,
  trackId: string,
): string {
  const identifier = callsign || trackId
  if (domain === 'Air') return `Flight "${identifier}"`
  if (domain === 'Maritime') return `Vessel "${identifier}"`
  if (domain === 'Space') return `Satellite "${identifier}"`
  if (domain === 'GPS') return `GPS cell "${identifier}"`
  return `Asset "${identifier}"`
}

function getAssetSearchQuery(domain: SourceDomain, callsign: string | null | undefined, trackId: string): string {
  const identifier = callsign || trackId
  if (domain === 'Air') return `${identifier} flight`
  if (domain === 'Maritime') return `${identifier} vessel`
  if (domain === 'Space') return `${identifier} satellite`
  if (domain === 'GPS') return `${identifier} gps interference`
  return identifier
}

function fieldStatusColor(status: SatelliteFieldStatus): string {
  if (status === 'authoritative') return 'green'
  if (status === 'derived') return 'blue'
  if (status === 'inferred') return 'amber'
  if (status === 'curated') return 'purple'
  return 'slate'
}

// ── Action button ─────────────────────────────────────────────────
function ActionBtn({
  onClick, children, variant = 'default',
}: {
  onClick: () => void
  children: React.ReactNode
  variant?: 'default' | 'primary' | 'danger' | 'search'
}) {
  const cls = {
    default: 'bg-slate-700/60 text-slate-300 hover:bg-slate-600/80 hover:text-white border border-slate-600/60',
    primary: 'bg-teal-700/60 text-teal-200 hover:bg-teal-600/80 hover:text-white border border-teal-600/60',
    danger:  'bg-red-800/40 text-red-300 hover:bg-red-700/60 hover:text-white border border-red-700/60',
    search:  'bg-blue-700/50 text-blue-200 hover:bg-blue-600/70 hover:text-white border border-blue-500/60',
  }[variant]
  return (
    <button onClick={onClick} className={`flex-1 text-xs py-1.5 rounded-lg transition-colors ${cls}`}>
      {children}
    </button>
  )
}

// ── Aircraft hero photo ───────────────────────────────────────────
function AircraftHero({ registration, typeCode }: { registration: string | null | undefined; typeCode: string | null | undefined }) {
  const photoQuery = useQuery({
    queryKey: ['planespotters-photo', registration ?? null],
    enabled: Boolean(registration),
    queryFn: async (): Promise<AircraftPhotoResult | null> => {
      if (!registration) return null
      if (photoCache.has(registration)) {
        return photoCache.get(registration) ?? null
      }
      const response = await fetch(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(registration)}`)
      if (!response.ok) {
        photoCache.set(registration, null)
        return null
      }
      const data = await response.json() as PlanespottersResponse
      const photo = data.photos?.[0]
      const result = {
        photoUrl: photo?.thumbnail_large?.src || photo?.thumbnail?.src || null,
        photographer: photo?.photographer ?? null,
        photoLink: photo?.link ?? null,
      }
      photoCache.set(registration, result)
      return result
    },
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  })

  const photoUrl = registration
    ? (photoQuery.data?.photoUrl ?? (photoCache.get(registration)?.photoUrl ?? undefined))
    : null
  const photographer = photoQuery.data?.photographer ?? (registration ? photoCache.get(registration)?.photographer ?? null : null)
  const photoLink = photoQuery.data?.photoLink ?? (registration ? photoCache.get(registration)?.photoLink ?? null : null)

  // Nothing to render if no registration and no type code
  if (!registration && !typeCode) return null

  // Loading skeleton
  if (registration && photoUrl === undefined) {
    return (
      <div style={{
        width: '100%', aspectRatio: '16 / 7',
        background: 'linear-gradient(90deg, rgba(30,41,59,0) 0%, rgba(51,65,85,0.5) 50%, rgba(30,41,59,0) 100%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.4s infinite',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderBottom: '1px solid rgba(148,163,184,0.10)',
      }}>
        <span style={{ fontSize: 28, opacity: 0.15 }}>✈</span>
        <style>{`@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }`}</style>
      </div>
    )
  }

  // No photo — silhouette fallback using ADSBexchange SVG by type code
  if (!photoUrl) {
    if (!typeCode) return null
    const silhouetteUrl = `https://www.adsbexchange.com/silhouettes/aircraft/${typeCode.toLowerCase()}.svg`
    return (
      <div style={{
        width: '100%', padding: '16px 0 8px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
        borderBottom: '1px solid rgba(148,163,184,0.10)',
        background: 'rgba(15,23,42,0.4)',
      }}>
        <img
          src={silhouetteUrl}
          alt={typeCode}
          style={{ height: 64, maxWidth: '80%', opacity: 0.55, filter: 'invert(1)' }}
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
        />
        <div style={{ fontSize: '10px', color: '#475569' }}>{typeCode} silhouette</div>
      </div>
    )
  }

  // Real photo
  return (
    <div style={{
      width: '100%', position: 'relative',
      borderBottom: '1px solid rgba(148,163,184,0.10)',
      overflow: 'hidden',
    }}>
      <img
        src={photoUrl}
        alt={registration ?? typeCode ?? 'aircraft'}
        style={{ width: '100%', aspectRatio: '16 / 7', objectFit: 'cover', display: 'block' }}
      />
      {/* Gradient overlay for the photo credit */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        background: 'linear-gradient(transparent, rgba(0,0,0,0.72))',
        padding: '12px 10px 5px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
      }}>
        {photographer && (
          <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.55)', letterSpacing: '0.05em' }}>
            📷 {photographer} · Planespotters.net
          </div>
        )}
        {photoLink && (
          <a
            href={photoLink}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '9px', color: 'rgba(147,197,253,0.7)',
              textDecoration: 'none', letterSpacing: '0.05em',
            }}
            onClick={e => e.stopPropagation()}
          >
            View ↗
          </a>
        )}
      </div>
    </div>
  )
}

function MaritimeHero({
  imageUrl,
  vesselName,
  status,
}: {
  imageUrl: string | null
  vesselName: string | null
  status: MaritimeEnrichmentResponse['status'] | null
}) {
  if (!imageUrl) return null
  return (
    <div style={{ position: 'relative', borderBottom: '1px solid rgba(148,163,184,0.10)' }}>
      <img
        src={imageUrl}
        alt={vesselName ? `${vesselName} photo` : 'Vessel photo'}
        style={{ width: '100%', aspectRatio: '16 / 7', objectFit: 'cover', display: 'block' }}
      />
      <div
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 10,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div
          style={{
            maxWidth: '75%',
            fontSize: 13,
            fontWeight: 800,
            color: '#f8fafc',
            textShadow: '0 1px 10px rgba(2,6,23,0.9)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {vesselName || 'MarineTraffic'}
        </div>
        {status && <Pill color={status === 'fresh' ? 'cyan' : status === 'cached' ? 'blue' : status === 'blocked' ? 'amber' : 'slate'}>{status.toUpperCase()}</Pill>}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────
export function AssetCard() {
  const {
    assetCardOpen, setAssetCardOpen, selectedTrackId, selectedDomain,
    clearSelection, flyTo, setTimeWindow, setCurrentTime,
    setPlaybackMode, playback,
  } = useMapStore()
  const { viewportAssets, selectedAssetDetail } = useLiveDataStore()

  const { size: cardWidth, handleRef: resizeHandleRef, isDragging: isResizing } = useResize({
    direction: 'left', defaultSize: 380, minSize: 320, maxSize: 580,
    storageKey: 'sentinel.assetCardWidth',
  })

  const { offset, dragHandleRef, isDragging } = useDrag({ storageKey: 'sentinel.assetCardPosition' })

  const viewportAsset = selectedTrackId && selectedDomain
    ? viewportAssets.get(`${selectedDomain}:${selectedTrackId}`)
    : null

  const asset = useMemo(() => {
    if (!selectedTrackId || !selectedDomain) return null
    if (selectedAssetDetail?.track_id === selectedTrackId && selectedAssetDetail.source_domain === selectedDomain) {
      return selectedAssetDetail
    }
    return viewportAsset ?? null
  }, [selectedTrackId, selectedDomain, selectedAssetDetail, viewportAsset])

  const spaceNoradId = useMemo(() => {
    if (selectedDomain !== 'Space' || !asset) return null
    const raw = asset.norad_id ?? asset.track_id
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }, [asset, selectedDomain])

  const satelliteCatalogQuery = useQuery({
    queryKey: ['satellite-catalog', spaceNoradId],
    enabled: selectedDomain === 'Space' && spaceNoradId !== null,
    queryFn: async (): Promise<SatelliteCatalogEntry> => trackedFetchJson(
      'satellite-catalog',
      `/api/satellites/${spaceNoradId}`,
    ),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  const satelliteTlesQuery = useQuery({
    queryKey: ['satellite-tles', spaceNoradId],
    enabled: selectedDomain === 'Space' && spaceNoradId !== null,
    queryFn: async (): Promise<SatelliteTleResponse> => trackedFetchJson(
      'satellite-tles',
      `/api/satellites/${spaceNoradId}/tles?limit=5`,
    ),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  const maritimeEnrichmentQuery = useQuery({
    queryKey: ['maritime-enrichment', asset?.entity_id ?? null, asset?.track_id ?? null],
    enabled: selectedDomain === 'Maritime' && Boolean(asset?.track_id) && (Boolean(asset?.entity_id) || Boolean(asset?.track_id)),
    queryFn: async (): Promise<MaritimeEnrichmentResponse> => {
      const params = new URLSearchParams()
      if (asset?.entity_id) params.set('entity_id', String(asset.entity_id))
      if (!asset?.entity_id && selectedDomain === 'Maritime' && asset?.track_id) {
        params.set('domain', 'Maritime')
        params.set('track_id', asset.track_id)
      }
      return trackedFetchJson('maritime-enrichment', `/api/tracks/maritime-enrichment?${params.toString()}`)
    },
    staleTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  })

  const handleFocus = useCallback(() => {
    if (asset?.lon != null && asset?.lat != null) flyTo(asset.lon, asset.lat)
  }, [asset, flyTo])

  const handleReplay = useCallback(() => {
    if (!asset?.timestamp) return
    const center = new Date(asset.timestamp)
    setTimeWindow({ start: new Date(center.getTime() - 2 * 3600_000), end: new Date(center.getTime() + 2 * 3600_000) })
    setCurrentTime(new Date(center.getTime() - 2 * 3600_000))
    setPlaybackMode('replay')
  }, [asset, setTimeWindow, setCurrentTime, setPlaybackMode])

  const handleCopyId = useCallback(() => {
    if (asset?.track_id) navigator.clipboard.writeText(asset.track_id).catch(() => {})
  }, [asset])

  const handleExport = useCallback((fmt: 'csv' | 'geojson') => {
    if (!asset?.track_id || !selectedDomain) return
    const params = new URLSearchParams({
      format: fmt, domain: selectedDomain, track_id: asset.track_id,
      t_start: playback.timeWindow.start.toISOString(),
      t_end:   playback.timeWindow.end.toISOString(),
    })
    window.open(`/api/tracks/export?${params.toString()}`, '_blank')
  }, [asset, selectedDomain, playback.timeWindow])

  const handleSearch = useCallback(() => {
    if (!asset || !selectedDomain) return
    const query = getAssetSearchQuery(selectedDomain, asset.callsign, asset.track_id)
    window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank')
  }, [asset, selectedDomain])

  if (!assetCardOpen || !asset || !selectedDomain) return null

  const domain = DOMAIN_META[selectedDomain]

  // ── Domain-specific sections ───────────────────────────────────
  const domainSection = (() => {

    // ── AIR ──────────────────────────────────────────────────────
    if (selectedDomain === 'Air') {
      const registration  = asset.registration as string | undefined
      const aircraftType  = asset.aircraft_type as string | undefined
      const category      = asset.category as string | undefined
      const originCountry = asset.origin_country as string | undefined
      const onGround      = asset.on_ground as boolean | undefined
      const squawk        = asset.squawk as string | undefined
      const vertRate      = asset.vertical_rate as number | undefined
      const isMilitary    = asset.military_flag as boolean | undefined
      const flag          = countryToFlag(originCountry)
      const typeDesc      = typeDescription(aircraftType)
      const catDesc       = category ? CATEGORY_DESC[category] : undefined

      return (
        <>
          {/* Aircraft photo / silhouette hero */}
          <AircraftHero registration={registration} typeCode={aircraftType} />

          {/* Aircraft identity block */}
          {(registration || aircraftType) && (
            <StatSection title="Aircraft">
              {registration && (
                <StatCell label="Registration" value={registration} mono accent />
              )}
              {aircraftType && (
                <StatCell label="Type Code" value={aircraftType} mono />
              )}
              {typeDesc && (
                <StatCell label="Model" value={typeDesc} fullWidth />
              )}
              {catDesc && (
                <StatCell label="Category" value={catDesc} />
              )}
              {isMilitary === true && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <Pill color="red">⚠ MILITARY IDENTIFIED</Pill>
                </div>
              )}
            </StatSection>
          )}

          {/* Flight data */}
          <StatSection title="Flight Data">
            {/* Origin country with flag */}
            {originCountry && (
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{
                  fontSize: '9px', fontWeight: 700, letterSpacing: '0.13em',
                  color: '#64748b', textTransform: 'uppercase', marginBottom: '4px',
                }}>
                  Origin
                </div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {flag && <span style={{ fontSize: 16, lineHeight: 1 }}>{flag}</span>}
                  {originCountry}
                </div>
              </div>
            )}
            <StatCell label="Squawk" value={squawk} mono />
            <StatCell
              label="Status"
              value={onGround != null ? (onGround ? '⬛ On Ground' : '🟢 Airborne') : null}
            />
            <StatCell
              label="Vertical Rate"
              value={fmtVertRate(vertRate)}
              fullWidth
            />
          </StatSection>
        </>
      )
    }

    // ── MARITIME ─────────────────────────────────────────────────
    if (selectedDomain === 'Maritime') {
      const maritime = maritimeEnrichmentQuery.data
      const summary = maritime?.summary ?? {}
      const general = maritime?.general ?? {}
      const latestAis = maritime?.latest_ais ?? {}
      const vesselName = (summary.vessel_name || asset.callsign || asset.track_id) as string
      const flag = (maritime?.enrichment.flag || summary.flag || (asset.flag as string | undefined)) ?? undefined
      const countryFlag = countryToFlag(flag)
      const shipType = maritime?.enrichment.ship_type || summary.ship_type || (asset.ship_type as string | undefined)
      const destination = maritime?.enrichment.destination || summary.destination || (asset.destination as string | undefined)
      const owner = maritime?.enrichment.owner || general.owner || (asset.owner as string | undefined)
      const operator = maritime?.enrichment.operator || general.operator || (asset.operator as string | undefined)
      const status = summary.navigational_status || (asset.navigational_status as string | undefined)
      const imageUrl = maritime?.image_url ?? null
      const latestPosition = [latestAis.latitude, latestAis.longitude].filter(Boolean).join(', ')
      return (
        <>
          <MaritimeHero imageUrl={imageUrl} vesselName={summary.vessel_name ?? null} status={maritime?.status ?? null} />

          <StatSection title="Vessel Identity">
            <StatCell label="Vessel" value={vesselName} fullWidth accent />
            <StatCell label="MMSI" value={summary.mmsi || asset.track_id} mono />
            <StatCell label="IMO" value={summary.imo || (asset.imo as string | undefined)} mono />
            <StatCell label="Call Sign" value={summary.callsign || asset.callsign} mono />
            <StatCell label="Ship Type" value={shipType} />
            <div>
              <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.13em', color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>
                Flag
              </div>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: 6 }}>
                {countryFlag && <span style={{ fontSize: 16, lineHeight: 1 }}>{countryFlag}</span>}
                {flag || '—'}
              </div>
            </div>
            <StatCell label="Nav Status" value={status} fullWidth />
          </StatSection>

          <StatSection title="Voyage">
            <StatCell label="Destination" value={destination} fullWidth />
            <StatCell label="ETA" value={asset.eta as string} />
            <StatCell label="AIS Source" value={latestAis.ais_source} />
          </StatSection>

          <StatSection title="General">
            <StatCell label="Owner" value={owner} fullWidth />
            <StatCell label="Operator" value={operator} fullWidth />
            <StatCell label="Builder" value={general.builder} fullWidth />
            <StatCell label="Year Built" value={general.year_built} />
            <StatCell label="Length" value={general.length || (asset.length != null ? `${asset.length} m` : null)} />
            <StatCell label="Beam" value={general.beam} />
            <StatCell label="Draught" value={general.draught || (asset.draught != null ? `${asset.draught} m` : null)} />
            <StatCell label="Gross Tonnage" value={general.gross_tonnage} />
            <StatCell label="Deadweight" value={general.deadweight} />
          </StatSection>

          <StatSection title="Latest AIS">
            <StatCell label="Reported" value={latestAis.position_received_at} fullWidth />
            <StatCell label="Speed" value={latestAis.speed} />
            <StatCell label="Course" value={latestAis.course} />
            <StatCell label="Heading" value={latestAis.heading} />
            <StatCell label="Reported Pos" value={latestPosition || null} mono fullWidth />
          </StatSection>

          <StatSection title="Enrichment Source">
            <StatCell
              label="Status"
              value={maritimeEnrichmentQuery.isLoading ? 'Loading…' : maritime?.status?.toUpperCase() ?? 'Unavailable'}
            />
            <StatCell label="Fetched" value={fmtTime(maritime?.fetched_at ?? undefined)} />
            <StatCell label="Source" value="MarineTraffic public page" fullWidth />
            <StatCell label="Detail URL" value={maritime?.url} mono fullWidth />
          </StatSection>
        </>
      )
    }

    // ── SPACE ─────────────────────────────────────────────────────
    if (selectedDomain === 'Space') {
      const catalog        = satelliteCatalogQuery.data
      const intlDesignator = catalog?.intl_designator ?? null
      const orbitClass     = catalog?.orbit_class ?? (asset.orbit_class as string | undefined) ?? null
      const countryCode    = catalog?.country_code ?? null
      const rcsSize        = catalog?.rcs_size ?? null
      const launchDate     = catalog?.launch_date ?? null
      const period         = catalog?.period_min ?? null
      const incl           = catalog?.inclination_deg ?? null
      const altKm          = asset.altitude_km as number | undefined
      const countryFlag    = countryToFlag(countryCode)
      const tleSummary     = satelliteTlesQuery.data?.tles?.[0] ?? null
      const enrichment     = catalog?.enrichment_status ?? null

      return (
        <>
          <StatSection title="Orbital Data">
            <StatCell label="NORAD ID" value={spaceNoradId ?? asset.track_id} mono fullWidth />
            {intlDesignator && (
              <StatCell label="Intl Designator" value={intlDesignator} mono fullWidth />
            )}
            {orbitClass && (
              <div style={{ gridColumn: '1 / -1', marginBottom: 2 }}>
                <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.13em', color: '#64748b', textTransform: 'uppercase', marginBottom: 4 }}>
                  Orbit Class
                </div>
                <Pill color={ORBIT_PILL_COLOR[orbitClass] || 'slate'}>{orbitClass}</Pill>
              </div>
            )}
            {countryCode && (
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.13em', color: '#64748b', textTransform: 'uppercase', marginBottom: 4 }}>
                  Country
                </div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {countryFlag && <span style={{ fontSize: 16, lineHeight: 1 }}>{countryFlag}</span>}
                  {countryCode}
                </div>
              </div>
            )}
            <StatCell label="Period" value={period != null ? `${period.toFixed(1)} min` : null} />
            <StatCell label="Inclination" value={incl != null ? `${incl.toFixed(2)}°` : null} />
            <StatCell label="Altitude" value={altKm != null ? `${altKm.toFixed(0)} km` : null} />
            <StatCell label="Apogee" value={catalog?.apogee_km != null ? `${catalog.apogee_km.toFixed(0)} km` : null} />
            <StatCell label="Perigee" value={catalog?.perigee_km != null ? `${catalog.perigee_km.toFixed(0)} km` : null} />
            <StatCell label="RCS Size" value={rcsSize} />
            <StatCell label="Object Type" value={catalog?.object_type ?? (asset.object_type as string | undefined)} />
            <StatCell label="Operator" value={catalog?.operator} fullWidth />
            <StatCell label="Purpose" value={catalog?.purpose} fullWidth />
            <StatCell label="Contractor" value={catalog?.contractor} fullWidth />
            <StatCell label="Launch Date" value={fmtDate(launchDate)} />
            <StatCell label="Launch Site" value={catalog?.launch_site} />
          </StatSection>

          <StatSection title="Enrichment Status">
            <StatCell label="Confidence" value={enrichment?.confidence?.toUpperCase() ?? (satelliteCatalogQuery.isLoading ? 'Loading…' : 'Unavailable')} />
            <StatCell label="Completeness" value={enrichment ? `${enrichment.completeness_pct}%` : null} />
            <StatCell label="Catalog Updated" value={fmtTime(enrichment?.last_updated ?? undefined)} />
            <StatCell label="TLE Epoch" value={fmtTime(enrichment?.tle_epoch ?? undefined)} />
            <StatCell label="TLE Source" value={enrichment?.tle_source ?? tleSummary?.source ?? null} />
            <StatCell label="TLE Age" value={enrichment?.tle_age_minutes != null ? `${enrichment.tle_age_minutes} min` : null} />
            <StatCell label="Sources" value={enrichment?.sources?.join(', ') ?? null} fullWidth />
            <div style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {enrichment && Object.entries(enrichment.field_status).map(([label, status]) => (
                <Pill key={label} color={fieldStatusColor(status)}>
                  {label}: {status}
                </Pill>
              ))}
            </div>
          </StatSection>

          <StatSection title="TLE History">
            <StatCell label="Snapshots" value={satelliteTlesQuery.data?.count ?? null} />
            <StatCell label="Latest Epoch" value={fmtTime(tleSummary?.epoch)} />
            {tleSummary && (
              <>
                <StatCell label="Latest Source" value={tleSummary.source} />
                <StatCell label="Ingested" value={fmtTime(tleSummary.ingested_at ?? undefined)} />
                <StatCell label="TLE Line 1" value={tleSummary.tle_line1} mono fullWidth />
                <StatCell label="TLE Line 2" value={tleSummary.tle_line2} mono fullWidth />
              </>
            )}
            {satelliteTlesQuery.isError && (
              <StatCell label="Status" value="No TLE history available" fullWidth />
            )}
          </StatSection>
        </>
      )
    }

    // ── GPS ───────────────────────────────────────────────────────
    if (selectedDomain === 'GPS') {
      return (
        <StatSection title="Interference Data">
          <StatCell label="H3 Cell"  value={asset.h3_cell as string} mono fullWidth />
          <StatCell label="Score"    value={asset.score != null ? `${((asset.score as number) * 100).toFixed(0)}%` : null} />
          <StatCell label="Severity" value={asset.severity as string} />
        </StatSection>
      )
    }

    // ── INFRA ─────────────────────────────────────────────────────
    if (selectedDomain === 'Infra') {
      return (
        <StatSection title="Outage Data">
          <StatCell label="Type"     value={asset.outage_type as string} />
          <StatCell label="Severity" value={asset.severity as string} />
          <StatCell label="ASN"      value={asset.asn as string} mono />
          <StatCell label="Region"   value={asset.region as string} />
        </StatSection>
      )
    }
    return null
  })()

  // ── Airborne / ground status indicator (Air domain only) ──────
  const statusChip = selectedDomain === 'Air' ? (() => {
    const onGround = asset.on_ground as boolean | undefined
    if (onGround == null) return null
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em',
        padding: '2px 8px', borderRadius: 20,
        background: onGround ? 'rgba(71,85,105,0.6)' : 'rgba(20,83,45,0.5)',
        border: `1px solid ${onGround ? 'rgba(100,116,139,0.4)' : 'rgba(34,197,94,0.35)'}`,
        color: onGround ? '#94a3b8' : '#86efac',
        marginTop: 4,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: onGround ? '#64748b' : '#22c55e',
          boxShadow: onGround ? 'none' : '0 0 6px #22c55e',
          animation: onGround ? 'none' : 'pulse-green 1.8s infinite',
        }} />
        {onGround ? 'ON GROUND' : 'AIRBORNE'}
        <style>{`@keyframes pulse-green { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
      </span>
    )
  })() : null

  return (
    <div
      style={{
        position: 'fixed', right: '12px', top: '88px',
        width: cardWidth, height: 'auto', maxHeight: 'calc(100vh - 150px)',
        background: 'rgba(15, 23, 42, 0.97)',
        border: '1px solid rgba(255,255,255,0.1)',
        color: 'white', zIndex: 20, boxSizing: 'border-box', borderRadius: '14px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        userSelect: isResizing || isDragging ? 'none' : undefined,
        transform: `translate(${offset.x}px, ${offset.y}px)`,
      }}
    >
      {/* ── Left-edge resize handle ── */}
      <div
        ref={resizeHandleRef}
        style={{
          position: 'absolute', left: 0, top: 0, width: '8px', height: '100%',
          cursor: 'col-resize', zIndex: 10, background: 'transparent', transition: 'background 0.15s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(148,163,184,0.18)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
      />

      {/* ── Header ── */}
      <div
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 8,
          padding: '10px 10px 10px 18px', flexShrink: 0,
          background: 'linear-gradient(135deg, rgba(30,41,59,0.95), rgba(15,23,42,0.95))',
          borderBottom: `1px solid rgba(255,255,255,0.08)`,
          borderLeft: `3px solid ${domain?.accent || '#3b82f6'}`,
        }}
      >
        {/* Drag handle */}
        <div
          ref={dragHandleRef}
          title="Drag to move panel"
          style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3,
            padding: '4px 6px', cursor: isDragging ? 'grabbing' : 'grab',
            flexShrink: 0, alignSelf: 'flex-start', marginTop: 3,
            borderRadius: 6, background: 'transparent', transition: 'background 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(148,163,184,0.18)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ width: 3, height: 3, borderRadius: '50%', background: '#64748b' }} />
          ))}
        </div>

        <div className="flex-1 min-w-0">
          {/* Domain icon + callsign */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            {domain && (
              <span className={`text-xl leading-none ${domain.color}`}>{domain.icon}</span>
            )}
            <span style={{
              fontSize: 15, fontWeight: 800, letterSpacing: '-0.01em',
              color: '#f1f5f9', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {asset.callsign || asset.track_id}
            </span>
          </div>

          {/* ICAO hex / track id subtitle */}
          {asset.callsign && (
            <div style={{ fontSize: '10px', color: '#64748b', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', marginBottom: 4 }}>
              {asset.track_id}
            </div>
          )}

          {/* Classification badge + status chip */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {asset.classification && (
              <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full ${CLASSIFICATION_STYLES[asset.classification] ?? CLASSIFICATION_STYLES.Unknown}`}>
                {asset.classification.toUpperCase()}
              </span>
            )}
            {statusChip}
          </div>
        </div>

        <button
          onClick={() => { clearSelection(); setAssetCardOpen(false) }}
          style={{
            color: '#475569', fontSize: 18, lineHeight: 1, background: 'none', border: 'none',
            cursor: 'pointer', flexShrink: 0, padding: '0 4px', marginTop: 2, transition: 'color 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#475569' }}
          title="Close"
        >
          ✕
        </button>
      </div>

      {/* ── Body — scrollable stat sections ── */}
      <div className="overflow-y-auto flex-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">

        {/* Domain-specific section (may include hero photo for Air) */}
        {domainSection}

        {/* Position & Motion */}
        <StatSection title="Position &amp; Motion">
          <StatCell label="Speed"    value={fmtSpeed(asset.speed_mps as number)} />
          <StatCell label="Heading"  value={fmtHeading(asset.heading_deg as number)} />
          <StatCell label="Altitude" value={fmtAlt(asset.altitude_m as number)} fullWidth />
          <StatCell label="Position" value={fmtCoord(asset.lon, asset.lat)} mono fullWidth />
        </StatSection>

        {/* Identity */}
        <StatSection title="Identity">
          <StatCell label="Domain"    value={asset.source_domain} />
          <StatCell label="Feed"      value={asset.source_feed} />
          <StatCell label="Last Seen" value={fmtTime(asset.timestamp)} fullWidth />
          <StatCell label="Track ID"  value={asset.track_id} mono fullWidth />
        </StatSection>

      </div>

      {/* ── Actions ── */}
      <div style={{
        padding: '10px 12px', borderTop: '1px solid rgba(148,163,184,0.10)',
        background: 'rgba(15,23,42,0.8)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div className="flex gap-2">
          <ActionBtn onClick={handleFocus}  variant="primary">📍 Focus</ActionBtn>
          <ActionBtn onClick={handleReplay}>⏪ History</ActionBtn>
          <ActionBtn onClick={handleCopyId}>⎘ Copy ID</ActionBtn>
        </div>
        <div className="flex gap-2">
          <ActionBtn onClick={() => handleExport('csv')}>⬇ CSV</ActionBtn>
          <ActionBtn onClick={() => handleExport('geojson')}>⬇ GeoJSON</ActionBtn>
        </div>
        {selectedDomain === 'Maritime' && maritimeEnrichmentQuery.data?.url && (
          <div className="flex gap-2">
            <ActionBtn onClick={() => window.open(maritimeEnrichmentQuery.data?.url ?? '', '_blank')} variant="search">
              🌐 Open MarineTraffic
            </ActionBtn>
          </div>
        )}
        {/* Search button — domain-aware search query and label */}
        <ActionBtn onClick={handleSearch} variant="search">
          🔍 Search {getAssetSearchLabel(selectedDomain, asset.callsign, asset.track_id)} on Google
        </ActionBtn>
      </div>
    </div>
  )
}

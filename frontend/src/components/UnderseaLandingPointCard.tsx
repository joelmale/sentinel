import { useMapStore } from '@/store/useMapStore'

function parseLocation(name: string): { locality: string; country: string } {
  const parts = name.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length >= 2) {
    return {
      locality: parts.slice(0, -1).join(', '),
      country: parts[parts.length - 1],
    }
  }
  return { locality: name, country: 'TBD' }
}

function fmtCoord(lon: number, lat: number): string {
  const latDir = lat >= 0 ? 'N' : 'S'
  const lonDir = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(4)}° ${latDir}, ${Math.abs(lon).toFixed(4)}° ${lonDir}`
}

function Stat({
  label,
  value,
  accent = false,
}: {
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div>
      <div style={statLabelStyle}>{label}</div>
      <div style={{ ...statValueStyle, color: accent ? '#fde68a' : '#e2e8f0' }}>{value}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>{title}</div>
      <div style={sectionGridStyle}>{children}</div>
    </div>
  )
}

export function UnderseaLandingPointCard() {
  const selectedLandingPoint = useMapStore((state) => state.selectedLandingPoint)
  const clearLandingPointSelection = useMapStore((state) => state.clearLandingPointSelection)
  const flyTo = useMapStore((state) => state.flyTo)

  if (!selectedLandingPoint) return null

  const { locality, country } = parseLocation(selectedLandingPoint.name)

  return (
    <aside style={panelStyle}>
      <div style={headerStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={eyebrowStyle}>Undersea Landing Point</div>
          <div style={titleStyle}>{selectedLandingPoint.name}</div>
          <div style={subheadStyle}>Cable hub context and outage triage surface</div>
        </div>
        <button
          type="button"
          onClick={clearLandingPointSelection}
          style={closeButtonStyle}
          aria-label="Close undersea landing point card"
        >
          ×
        </button>
      </div>

      <Section title="Location">
        <Stat label="Locality" value={locality} accent />
        <Stat label="Country" value={country} />
        <Stat label="Coordinates" value={fmtCoord(selectedLandingPoint.lon, selectedLandingPoint.lat)} />
        <Stat label="Landing Point ID" value={selectedLandingPoint.id} />
      </Section>

      <Section title="Cable Context">
        <Stat label="Connected Cables" value="TBD" />
        <Stat label="Cable Count" value="TBD" />
        <Stat label="Operators / Owners" value="TBD" />
        <Stat label="System Status" value="TBD" />
      </Section>

      <Section title="Impact Analysis">
        <Stat label="Criticality" value="TBD" />
        <Stat label="Redundancy Score" value="TBD" />
        <Stat label="Likely Affected Regions" value="TBD" />
        <Stat label="Repair / Restoration Context" value="TBD" />
      </Section>

      <Section title="Collector Backlog">
        <Stat label="Capacity" value="TBD" />
        <Stat label="Counterpart Landing Sites" value="TBD" />
        <Stat label="Incident History" value="TBD" />
        <Stat label="Nearby Strategic Infra" value="TBD" />
      </Section>

      <div style={footerStyle}>
        <button
          type="button"
          onClick={() => flyTo(selectedLandingPoint.lon, selectedLandingPoint.lat, 6)}
          style={actionButtonStyle}
        >
          Center Map
        </button>
      </div>
    </aside>
  )
}

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 88,
  right: 16,
  width: 360,
  maxHeight: 'calc(100vh - 176px)',
  overflowY: 'auto',
  borderRadius: 18,
  border: '1px solid rgba(245,158,11,0.32)',
  background: 'rgba(15,23,42,0.96)',
  boxShadow: '0 22px 70px rgba(0,0,0,0.45)',
  zIndex: 22,
  backdropFilter: 'blur(14px)',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  padding: '16px 18px 14px',
  borderBottom: '1px solid rgba(148,163,184,0.12)',
}

const eyebrowStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#f59e0b',
  marginBottom: 6,
}

const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  lineHeight: 1.2,
  color: '#f8fafc',
}

const subheadStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: '#94a3b8',
  lineHeight: 1.45,
}

const closeButtonStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 999,
  border: '1px solid rgba(148,163,184,0.22)',
  background: 'rgba(30,41,59,0.75)',
  color: '#e2e8f0',
  fontSize: 20,
  lineHeight: 1,
  cursor: 'pointer',
  flexShrink: 0,
}

const sectionStyle: React.CSSProperties = {
  padding: '12px 18px',
  borderBottom: '1px solid rgba(148,163,184,0.10)',
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#64748b',
  marginBottom: 10,
}

const sectionGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '12px 16px',
}

const statLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.13em',
  textTransform: 'uppercase',
  color: '#64748b',
  marginBottom: 4,
}

const statValueStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.35,
}

const footerStyle: React.CSSProperties = {
  padding: 18,
}

const actionButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 12,
  border: '1px solid rgba(245,158,11,0.32)',
  background: 'rgba(120,53,15,0.65)',
  color: '#fde68a',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
}

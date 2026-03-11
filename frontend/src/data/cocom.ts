/**
 * COCOM color mapping for real GeoJSON boundaries.
 *
 * The full boundary polygons are fetched at runtime from the jonahadkins
 * Combatant-Commands GeoJSON (built from Natural Earth 1:10m admin data):
 *   https://raw.githubusercontent.com/jonahadkins/Combatant-Commands/master/cocom.geojson
 *
 * deck.gl's GeoJsonLayer accepts a URL string as its `data` prop and fetches
 * it from the BROWSER — so it bypasses any server-side egress restrictions.
 * GitHub raw content sets permissive CORS headers (access-control-allow-origin: *).
 *
 * This file provides:
 *   1. COCOM_GEOJSON_URL  — URL passed to GeoJsonLayer
 *   2. getCocomColors()   — robust color lookup keyed by NAME/AOR property
 *   3. COCOM_LABELS       — static centroid positions for the TextLayer overlay
 */

export interface CocomColors {
  line: [number, number, number, number]
  fill: [number, number, number, number]
}

/** URL used by GeoJsonLayer — browser fetches this directly (CORS-friendly). */
export const COCOM_GEOJSON_URL =
  'https://raw.githubusercontent.com/jonahadkins/Combatant-Commands/main/cocom.geojson'

/**
 * Color table keyed by uppercase abbreviation substrings.
 * We match against the feature property value to handle multiple naming
 * conventions ("NORTHCOM", "USNORTHCOM", "Northern Command", etc.).
 */
const COCOM_COLOR_MAP: Record<string, CocomColors> = {
  NORTHCOM:  { line: [ 59, 130, 246, 210], fill: [ 59, 130, 246, 22] }, // blue-500
  SOUTHCOM:  { line: [ 34, 197,  94, 210], fill: [ 34, 197,  94, 22] }, // green-500
  EUCOM:     { line: [168,  85, 247, 210], fill: [168,  85, 247, 22] }, // purple-500
  CENTCOM:   { line: [249, 115,  22, 210], fill: [249, 115,  22, 22] }, // orange-500
  AFRICOM:   { line: [239,  68,  68, 210], fill: [239,  68,  68, 22] }, // red-500
  INDOPACOM: { line: [ 20, 184, 166, 210], fill: [ 20, 184, 166, 22] }, // teal-500
  PACOM:     { line: [ 20, 184, 166, 210], fill: [ 20, 184, 166, 22] }, // legacy PACOM alias
  SPACECOM:  { line: [192, 132, 252, 210], fill: [192, 132, 252, 22] }, // violet-400
  SOCOM:     { line: [245, 158,  11, 210], fill: [245, 158,  11, 22] }, // amber-500
  TRANSCOM:  { line: [ 99, 102, 241, 210], fill: [ 99, 102, 241, 22] }, // indigo-500
  STRATCOM:  { line: [ 20, 184, 166, 210], fill: [ 20, 184, 166, 22] }, // teal alias
  CYBERCOM:  { line: [239,  68,  68, 210], fill: [239,  68,  68, 22] }, // red alias
}

const FALLBACK: CocomColors = {
  line: [100, 100, 100, 150],
  fill: [100, 100, 100,  15],
}

/**
 * Resolve a GeoJSON feature's properties to COCOM colors.
 * Tries multiple property-name conventions used by different GeoJSON sources
 * (NAME, COCOM, name, AOR, command, label).
 */
export function getCocomColors(properties: Record<string, unknown>): CocomColors {
  const raw = (
    properties.NAME ??
    properties.COCOM ??
    properties.name ??
    properties.AOR ??
    properties.command ??
    properties.label ??
    ''
  ) as string

  // Strip the "US" prefix before matching (e.g. "USNORTHCOM" → "NORTHCOM")
  const upper = raw.toUpperCase().replace(/^US/, '')

  for (const [key, colors] of Object.entries(COCOM_COLOR_MAP)) {
    if (upper.includes(key)) return colors
  }
  return FALLBACK
}

/**
 * Static centroid positions used for TextLayer command labels.
 * One entry per unique AOR — placed approximately in the geographic centre.
 */
export const COCOM_LABELS: Array<{
  id: string
  abbr: string
  lon: number
  lat: number
  color: [number, number, number, number]
}> = [
  { id: 'northcom',  abbr: 'USNORTHCOM',  lon: -110, lat:  55, color: [ 59, 130, 246, 210] },
  { id: 'southcom',  abbr: 'USSOUTHCOM',  lon:  -65, lat: -20, color: [ 34, 197,  94, 210] },
  { id: 'eucom',     abbr: 'USEUCOM',     lon:   20, lat:  58, color: [168,  85, 247, 210] },
  { id: 'centcom',   abbr: 'USCENTCOM',   lon:   50, lat:  28, color: [249, 115,  22, 210] },
  { id: 'africom',   abbr: 'USAFRICOM',   lon:   18, lat:   0, color: [239,  68,  68, 210] },
  { id: 'indopacom', abbr: 'USINDOPACOM', lon:  110, lat:  10, color: [ 20, 184, 166, 210] },
]

/**
 * Grouping utilities for the SourcePanel track tree.
 *
 * Provides lookup tables and pure derivation functions for sub-domain
 * grouping of Air, Maritime, and Space tracks.
 *
 * Design note: all functions are pure (no side-effects) so they can be
 * used safely inside useMemo without referential instability.
 */

// ── Air: ICAO 3-letter airline designator → airline name ──────────
// Covers ~200 carriers representing the bulk of global commercial traffic.
// Unknown prefixes fall back to displaying the raw 3-char code.
export const ICAO_AIRLINE: Record<string, string> = {
  // ── North America ────────────────────────────────────────────────
  AAL: 'American Airlines',
  UAL: 'United Airlines',
  DAL: 'Delta Air Lines',
  SWA: 'Southwest',
  ASA: 'Alaska Airlines',
  JBU: 'JetBlue',
  FFT: 'Frontier Airlines',
  NKS: 'Spirit Airlines',
  SNA: 'Sun Country',
  HAL: 'Hawaiian Airlines',
  RPA: 'Republic Airways',
  SKW: 'SkyWest',
  ENY: 'Envoy Air',
  PDT: 'Piedmont Airlines',
  PSA: 'PSA Airlines',
  QXE: 'Horizon Air',
  CPZ: 'Compass Airlines',
  AWE: 'America West',
  ATN: 'Air Transport Intl',
  FDX: 'FedEx',
  UPS: 'UPS Airlines',
  ABX: 'ABX Air',
  GTI: 'Atlas Air',
  KMI: 'Southern Air',
  // Canada
  ACA: 'Air Canada',
  WJA: 'WestJet',
  TCA: 'Air Transat',
  MPE: 'Sunwing',
  // Mexico / Caribbean
  AMX: 'Aeroméxico',
  VOI: 'Volaris',
  VIV: 'VivaAerobus',
  IBB: 'Interjet',
  CUB: 'Cubana',
  JBU2: 'Caribbean Airlines',
  BWA: 'Caribbean Airlines',

  // ── Europe ───────────────────────────────────────────────────────
  BAW: 'British Airways',
  EZY: 'easyJet',
  RYR: 'Ryanair',
  VIR: 'Virgin Atlantic',
  TCX: 'TUI Airways',
  AFR: 'Air France',
  AEE: 'Aegean Airlines',
  BEL: 'Brussels Airlines',
  DLH: 'Lufthansa',
  EWG: 'Eurowings',
  AUA: 'Austrian Airlines',
  SWR: 'Swiss',
  KLM: 'KLM',
  TRA: 'Transavia',
  VLG: 'Vueling',
  IBE: 'Iberia',
  AEA: 'Air Europa',
  AZU: 'Azul',
  TAP: 'TAP Air Portugal',
  AZA: 'ITA Airways',
  EJU: 'easyJet Europe',
  WZZ: 'Wizz Air',
  LOT: 'LOT Polish',
  CSA: 'Czech Airlines',
  TOM: 'TUI fly',
  MON: 'Monarch',
  EXS: 'Jet2',
  SAS: 'Scandinavian Airlines',
  NOZ: 'Norwegian Air Shuttle',
  NHT: 'Norwegian',
  SKS: 'Skyways',
  FIN: 'Finnair',
  ICE: 'Icelandair',
  ARK: 'Arik Air',
  // Russia / Eastern Europe
  AFL: 'Aeroflot',
  SDM: 'S7 Airlines',
  SVR: 'Ural Airlines',
  NWS: 'Nordwind',
  TYA: 'Pobeda',

  // ── Middle East ──────────────────────────────────────────────────
  UAE: 'Emirates',
  ETD: 'Etihad Airways',
  QTR: 'Qatar Airways',
  GFA: 'Gulf Air',
  KAC: 'Kuwait Airways',
  OMA: 'Oman Air',
  FDB: 'Flydubai',
  ABY: 'Air Arabia',
  SVA: 'Saudia',
  FLY: 'Flynas',
  THY: 'Turkish Airlines',
  TGT: 'TUIfly',
  IAW: 'Iraqi Airways',
  IRA: 'Iran Air',

  // ── Asia-Pacific ─────────────────────────────────────────────────
  CPA: 'Cathay Pacific',
  HDA: 'Cathay Dragon',
  CXA: 'Xiamen Air',
  CSN: 'China Southern',
  CCA: 'Air China',
  CES: 'China Eastern',
  HNA: 'Hainan Airlines',
  CHH: 'Shenzhen Airlines',
  SZX: 'Sichuan Airlines',
  JAL: 'Japan Airlines',
  ANA: 'All Nippon Airways',
  JJP: 'Jetstar Japan',
  SJO: 'Skymark Airlines',
  KAL: 'Korean Air',
  AAR: 'Asiana Airlines',
  JJA: 'Jeju Air',
  SIA: 'Singapore Airlines',
  TGW: 'Scoot',
  MAS: 'Malaysia Airlines',
  AXM: 'AirAsia',
  GAR: 'Garuda Indonesia',
  BTK: 'Batik Air',
  THL: 'Thai Airways',
  TBA: 'Bangkok Airways',
  VNA: 'Vietnam Airlines',
  VJC: 'VietJet',
  PAL: 'Philippine Airlines',
  CEB: 'Cebu Pacific',
  AIC: 'Air India',
  IGO: 'IndiGo',
  SEJ: 'SpiceJet',
  QFA: 'Qantas',
  VOZ: 'Virgin Australia',
  JST: 'Jetstar',
  NZL: 'Air New Zealand',
  ANZ: 'Air New Zealand',
  // Pacific freight
  CDG: 'Air China Cargo',

  // ── Africa ───────────────────────────────────────────────────────
  ETH: 'Ethiopian Airlines',
  KQA: 'Kenya Airways',
  EAL: 'EgyptAir',
  SAA: 'South African Airways',
  MSR: 'EgyptAir',
  RAM: 'Royal Air Maroc',
  CAW: 'Comair',

  // ── Latin America ────────────────────────────────────────────────
  TAM: 'LATAM Brazil',
  LAN: 'LATAM Airlines',
  ARG: 'Aerolíneas Argentinas',
  AVA: 'Avianca',
  COA: 'Copa Airlines',
  BOV: 'Boliviana',

  // ── Cargo specialists ────────────────────────────────────────────
  CKS: 'Kalitta Air',
  NCR: 'National Air Cargo',
  DHL: 'DHL Air',
  BCS: 'European Air Transport',
  FLG: 'Florida West',
  CXS: 'Cargolux',
  CLX: 'Cargolux',
  QEC: 'LATAM Cargo',

  // ── Military / Government ────────────────────────────────────────
  RCH: 'USAF AMC',
  SAM: 'US Special Air Mission',
  PAT: 'US Presidential',
  NAF: 'US Navy',
  MAC: 'Military Airlift Cmd',
  RAM2: 'USMC',
  AIO: 'ARIA/Airborne',
}

// ── Maritime: MMSI Maritime Identification Digit → country ────────
// First 3 digits of MMSI = MID code per ITU-R M.585.
// Sorted by MID value (200–799 range).
export const MID_COUNTRY: Record<string, string> = {
  // ── Europe ───────────────────────────────────────────────────────
  '201': 'Albania', '202': 'Andorra', '203': 'Austria', '204': 'Portugal (Azores)',
  '205': 'Belgium', '206': 'Belarus', '207': 'Bulgaria', '208': 'Vatican',
  '209': 'Cyprus', '210': 'Cyprus', '211': 'Germany', '212': 'Cyprus',
  '213': 'Georgia', '214': 'Moldova', '215': 'Malta', '216': 'Armenia',
  '218': 'Germany', '219': 'Denmark', '220': 'Denmark',
  '224': 'Spain', '225': 'Spain',
  '226': 'France', '227': 'France', '228': 'France',
  '229': 'Malta', '230': 'Finland', '231': 'Faroe Islands',
  '232': 'United Kingdom', '233': 'United Kingdom',
  '234': 'United Kingdom', '235': 'United Kingdom',
  '236': 'Gibraltar', '237': 'Greece', '238': 'Croatia',
  '239': 'Greece', '240': 'Greece', '241': 'Greece',
  '242': 'Morocco', '243': 'Hungary',
  '244': 'Netherlands', '245': 'Netherlands', '246': 'Netherlands',
  '247': 'Italy', '248': 'Malta', '249': 'Malta',
  '250': 'Ireland', '251': 'Iceland', '252': 'Liechtenstein',
  '253': 'Luxembourg', '254': 'Monaco', '255': 'Portugal (Madeira)',
  '256': 'Malta', '257': 'Norway', '258': 'Norway', '259': 'Norway',
  '261': 'Poland', '262': 'Montenegro', '263': 'Portugal',
  '264': 'Romania', '265': 'Sweden', '266': 'Sweden',
  '267': 'Slovakia', '268': 'San Marino', '269': 'Switzerland',
  '270': 'Czech Republic', '271': 'Turkey', '272': 'Ukraine',
  '273': 'Russia', '274': 'North Macedonia',
  '275': 'Latvia', '276': 'Estonia', '277': 'Lithuania',
  '278': 'Slovenia', '279': 'Serbia',
  // ── North America ────────────────────────────────────────────────
  '303': 'United States (Alaska)', '316': 'Canada',
  '338': 'United States', '366': 'United States',
  '367': 'United States', '368': 'United States', '369': 'United States',
  '301': 'Anguilla', '304': 'Antigua & Barbuda', '305': 'Antigua & Barbuda',
  '306': 'Netherlands Antilles', '307': 'Aruba', '308': 'Bahamas',
  '309': 'Bahamas', '310': 'Bermuda', '311': 'Bahamas',
  '312': 'Belize', '314': 'Barbados',
  '319': 'Cayman Islands', '321': 'Costa Rica', '323': 'Cuba',
  '325': 'Dominica', '327': 'Dominican Republic',
  '329': 'Guadeloupe', '330': 'Grenada', '331': 'Greenland',
  '332': 'Guatemala', '334': 'Honduras', '336': 'Haiti',
  '340': 'Martinique', '341': 'Montserrat',
  '343': 'Nicaragua',
  '345': 'Panama', '347': 'Panama', '351': 'Panama', '352': 'Panama',
  '353': 'Panama', '354': 'Panama', '355': 'Panama', '356': 'Panama',
  '357': 'Panama', '358': 'Panama', '359': 'Panama',
  '370': 'Panama', '371': 'Panama', '372': 'Panama',
  '373': 'Panama', '374': 'Panama',
  '348': 'Puerto Rico', '361': 'Turks & Caicos',
  '362': 'Trinidad & Tobago', '364': 'St. Vincent',
  // ── Central / South America ──────────────────────────────────────
  '701': 'Argentina', '710': 'Brazil', '720': 'Bolivia',
  '725': 'Chile', '730': 'Colombia', '735': 'Ecuador',
  '740': 'Falkland Islands', '745': 'French Guiana',
  '750': 'Guyana', '755': 'Paraguay', '760': 'Peru',
  '765': 'Suriname', '770': 'Uruguay', '775': 'Venezuela',
  // ── Middle East & Central Asia ───────────────────────────────────
  '401': 'Afghanistan', '403': 'Saudi Arabia', '405': 'Bangladesh',
  '408': 'Bahrain', '410': 'Bhutan',
  '412': 'China', '413': 'China', '414': 'China',
  '416': 'Taiwan', '417': 'Sri Lanka',
  '419': 'India', '422': 'Iran', '423': 'Azerbaijan',
  '425': 'Iraq', '428': 'Israel',
  '431': 'Japan', '432': 'Japan',
  '434': 'Turkmenistan', '436': 'Kazakhstan', '437': 'Uzbekistan',
  '438': 'Jordan', '440': 'South Korea', '441': 'South Korea',
  '443': 'Palestine', '445': 'North Korea',
  '447': 'Kuwait', '450': 'Lebanon', '451': 'Kyrgyzstan',
  '453': 'Macao', '455': 'Maldives', '457': 'Mongolia',
  '459': 'Nepal', '461': 'Oman', '463': 'Pakistan',
  '466': 'Qatar', '468': 'Syria',
  '470': 'UAE', '471': 'UAE',
  '472': 'Tajikistan', '473': 'Yemen',
  '477': 'Hong Kong', '478': 'Bosnia',
  // ── Asia-Pacific ─────────────────────────────────────────────────
  '503': 'Australia', '506': 'Myanmar', '508': 'Brunei',
  '510': 'Palau', '511': 'New Zealand', '512': 'New Zealand',
  '514': 'Cambodia', '515': 'Cambodia',
  '520': 'Fiji', '525': 'Indonesia', '526': 'Indonesia', '527': 'Indonesia',
  '529': 'Kiribati', '531': 'Laos',
  '533': 'Malaysia', '534': 'Malaysia',
  '536': 'Northern Mariana Islands',
  '538': 'Marshall Islands',
  '540': 'French Polynesia', '542': 'New Caledonia',
  '548': 'Philippines',
  '553': 'Papua New Guinea',
  '563': 'Singapore', '564': 'Singapore',
  '565': 'Singapore', '566': 'Singapore',
  '567': 'Thailand',
  '570': 'Tonga', '572': 'Tuvalu', '574': 'Vietnam',
  '576': 'Vanuatu', '577': 'Vanuatu',
  // ── Africa ───────────────────────────────────────────────────────
  '601': 'South Africa', '603': 'Angola', '605': 'Algeria',
  '609': 'Burundi', '610': 'Benin', '611': 'Botswana',
  '612': 'Central African Republic', '613': 'Cameroon',
  '615': 'Congo', '616': 'Comoros', '617': 'Cape Verde',
  '619': "Côte d'Ivoire", '620': 'Comoros',
  '621': 'Djibouti', '622': 'Egypt',
  '624': 'Ethiopia', '625': 'Eritrea',
  '626': 'Gabon', '627': 'Ghana',
  '629': 'Gambia', '630': 'Guinea-Bissau',
  '631': 'Equatorial Guinea', '632': 'Guinea',
  '633': 'Burkina Faso', '634': 'Kenya',
  '636': 'Liberia', '637': 'Liberia',
  '638': 'South Sudan', '642': 'Libya',
  '644': 'Lesotho', '645': 'Mauritius', '647': 'Madagascar',
  '649': 'Mali', '650': 'Mozambique',
  '654': 'Mauritania', '655': 'Malawi',
  '657': 'Niger', '659': 'Nigeria',
  '660': 'Mayotte', '661': 'Namibia',
  '663': 'Rwanda', '664': 'Réunion',
  '665': 'Sudan', '666': 'Senegal',
  '667': 'Sierra Leone', '668': 'Somalia',
  '669': 'Eswatini', '670': 'Chad',
  '671': 'Togo', '672': 'Tunisia', '674': 'Tanzania',
  '675': 'Uganda', '676': 'DR Congo',
  '677': 'Tanzania', '678': 'Zambia', '679': 'Zimbabwe',
}

// ── Air: derive airline group from callsign ────────────────────────
// Military/Government callsigns use well-known prefixes (RCH, SAM, etc.)
// Commercial callsigns: first 3 alpha chars = ICAO operator designator
// General aviation / anonymous: numeric or missing
export function getAirlineGroup(callsign: string | undefined, classification?: string): string {
  // Classification overrides callsign-based grouping for mil/gov
  if (classification === 'Military')   return '🎖 Military'
  if (classification === 'Government') return '🏛 Government'

  if (!callsign || !callsign.trim()) return '❓ Unknown'

  const raw = callsign.trim().toUpperCase()

  // Purely numeric → general aviation squawk, not an airline flight
  if (/^\d+$/.test(raw)) return '✈ General Aviation'

  const prefix = raw.slice(0, 3).replace(/[^A-Z]/g, '')
  if (!prefix) return '❓ Unknown'

  // Known military prefix patterns even without classification field
  const militaryPrefixes = ['RCH', 'SAM', 'PAT', 'NAF', 'MAC', 'RAM', 'AIO', 'CVS', 'DUKE']
  if (militaryPrefixes.includes(prefix)) return '🎖 Military'

  const name = ICAO_AIRLINE[prefix]
  return name ? `${name}` : `${prefix}…`
}

// ── Maritime: derive flag state from MMSI ─────────────────────────
// MMSI structure:
//   9-digit vessel MMSI: first 3 digits = MID (country)
//   Coast stations (00x), groups (0xx), SAR (97x), mob (98x), search (99x)
export function getMmsiCountry(mmsi: string): string {
  if (!mmsi) return 'Unknown'
  const s = mmsi.trim()

  // Special ranges
  if (s.startsWith('00'))                 return 'Coast Station'
  if (s.startsWith('0') && !s.startsWith('00')) return 'Group / Broadcast'
  if (s.startsWith('970') || s.startsWith('972')) return 'SAR Aircraft'
  if (s.startsWith('98'))                 return 'Craft (Vessel Group)'
  if (s.startsWith('99'))                 return 'AIS Aids to Navigation'

  // Standard 3-digit MID lookup
  const mid = s.slice(0, 3)
  return MID_COUNTRY[mid] ?? `MID ${mid}`
}

// ── Space: derive constellation / program from object name ─────────
// This is intentionally broader than commercial "constellation" naming.
// The goal is to avoid dumping most satellites into "Other" when they are
// actually identifiable as a government program, EO fleet, weather system,
// or still-unknown payload family.
export function getConstellation(name: string | undefined, objectType?: unknown): string {
  const normalizedObjectType = normalizeObjectType(objectType)
  if (!name) {
    if (normalizedObjectType === 'Rocket Body') return 'Rocket Bodies'
    if (normalizedObjectType === 'Debris') return 'Debris'
    if (normalizedObjectType === 'Payload') return 'Unmapped Payload'
    return 'Other'
  }
  const n = name.toUpperCase().trim()

  // Mega-constellations
  if (n.startsWith('STARLINK'))                              return 'Starlink'
  if (n.startsWith('KUIPER'))                                return 'LEO (Kuiper)'
  if (n.startsWith('ONEWEB') || n.startsWith('ONE WEB'))    return 'OneWeb'
  if (n.startsWith('QIANFAN') || n.startsWith('G60'))       return 'Qianfan'
  if (n.startsWith('GUOWANG') || n.startsWith('GW '))       return 'Guowang'
  if (n.startsWith('GALAXYSPACE'))                          return 'GalaxySpace'
  if (n.startsWith('E-SPACE') || n.startsWith('ESPACE'))    return 'E-space'
  if (n.startsWith('TELESAT LIGHTSPEED'))                   return 'Telesat Lightspeed'

  // Navigation constellations
  if (n.match(/^GPS\s+(BI|IIR|IIA|BIIA|BIIR|BIIRM|BIIF|BIIIA|IIF|IIR-M)/)) return 'GPS (USAF)'
  if (n.startsWith('GLONASS'))                              return 'GLONASS'
  if (n.startsWith('GALILEO'))                              return 'Galileo'
  if (n.startsWith('BEIDOU') || n.startsWith('BEIDOU-'))   return 'BeiDou'
  if (n.startsWith('NAVSTAR'))                              return 'GPS (USAF)'

  // Space stations
  if (n === 'ISS (ZARYA)' || n.startsWith('ISS ') || n === 'ISS') return 'ISS'
  if (n.startsWith('TIANGONG') || n.startsWith('CSS '))     return 'Tiangong / CSS'

  // Weather & Earth observation
  if (n.startsWith('GOES-') || n.startsWith('GOES '))       return 'GOES (NOAA)'
  if (n.startsWith('NOAA-') || n.startsWith('NOAA '))       return 'NOAA'
  if (n.startsWith('METOP'))                                return 'MetOp'
  if (n.startsWith('HIMAWARI'))                             return 'Himawari'
  if (n.startsWith('FY-') || n.startsWith('FENGYUN'))       return 'Fengyun'
  if (n.startsWith('METEOSAT'))                              return 'Meteosat (EUMETSAT)'
  if (n.startsWith('SENTINEL-') || n.startsWith('SENTINEL ')) return 'Sentinel (ESA)'
  if (n.startsWith('LANDSAT'))                               return 'Landsat'
  if (n.startsWith('TERRA') || n === 'AQUA' || n === 'AURA') return 'NASA EOS'
  if (n.startsWith('COPERNICUS'))                            return 'Sentinel (ESA)'
  if (n.startsWith('GAOFEN') || n.startsWith('GF-'))         return 'Gaofen'
  if (n.startsWith('YAOGAN') || n.startsWith('YG-'))         return 'Yaogan'
  if (n.startsWith('JILIN'))                                 return 'Jilin'
  if (n.startsWith('CAPELLA'))                               return 'Capella Space'
  if (n.startsWith('ICEYE'))                                 return 'ICEYE'
  if (n.startsWith('UMBRA'))                                 return 'Umbra'
  if (n.startsWith('WORLDVIEW') || n.startsWith('GEOEYE'))  return 'Maxar (Commercial ISR)'
  if (n.startsWith('PLEIADES'))                              return 'Pleiades'
  if (n.startsWith('PAZ'))                                   return 'PAZ'
  if (n.startsWith('PLANET') || n.startsWith('FLOCK') || n.startsWith('SKYSAT')) return 'Planet Labs'
  if (n.startsWith('SPIRE') || n.startsWith('LEMUR'))        return 'Spire Global'
  if (n.startsWith('BLACKSKY'))                              return 'BlackSky'

  // Communications
  if (n.startsWith('IRIDIUM'))                              return 'Iridium'
  if (n.startsWith('INTELSAT'))                             return 'Intelsat'
  if (n.startsWith('SES-') || n.startsWith('SES '))         return 'SES'
  if (n.startsWith('EUTELSAT'))                             return 'Eutelsat'
  if (n.startsWith('TELESAT') || n.startsWith('ANIK'))      return 'Telesat'
  if (n.startsWith('VIASAT') || n.startsWith('WI-FI '))     return 'Viasat'
  if (n.startsWith('INMARSAT'))                             return 'Inmarsat'
  if (n.startsWith('THURAYA'))                              return 'Thuraya'
  if (n.startsWith('ARABSAT') || n.startsWith('BADR-'))     return 'Arabsat / Badr'
  if (n.startsWith('TURKSAT'))                              return 'Turksat'
  if (n.startsWith('HISPASAT'))                             return 'Hispasat'
  if (n.startsWith('JCSAT') || n.startsWith('SUPERBIRD'))   return 'JSAT / Superbird'
  if (n.startsWith('ASTRA'))                                return 'Astra'
  if (n.startsWith('ORBCOMM'))                              return 'Orbcomm'
  if (n.startsWith('GLOBALSTAR'))                           return 'Globalstar'
  if (n.startsWith('O3B') || n.startsWith('O3B '))          return 'O3b (SES MEO)'
  if (n.startsWith('AST SPACE') || n.startsWith('BLUEBIRD') || n.startsWith('BLUEMAN')) return 'AST SpaceMobile'
  if (n.startsWith('LYNK'))                                 return 'Lynk Global'
  if (n.startsWith('SWARM'))                                return 'Swarm'
  if (n.startsWith('KEPLER'))                               return 'Kepler Communications'
  if (n.startsWith('KINÉIS') || n.startsWith('KINEIS'))     return 'Kineis'
  if (n.startsWith('ASTROCAST'))                            return 'Astrocast'
  if (n.startsWith('FOSSA'))                                return 'FOSSA Systems'

  // Military / government programs (by country origin)
  if (n.startsWith('USA ') || n.startsWith('USA-'))         return 'NRO / USAF (classified)'
  if (n.startsWith('KH-'))                                  return 'NRO (classified)'
  if (n.startsWith('NROL'))                                 return 'NRO / USAF (classified)'
  if (n.startsWith('NOSS'))                                 return 'NOSS / White Cloud'
  if (n.startsWith('COSMOS'))                               return 'Cosmos (Russia)'
  if (n.startsWith('YAMAL') || n.startsWith('EKSPRESS'))    return 'Russia (Comms)'
  if (n.startsWith('GONETS') || n.startsWith('RODNIK'))     return 'Russia (Military)'
  if (n.startsWith('MERIDIAN') || n.startsWith('MOLNIYA'))  return 'Russia (Military)'
  if (n.startsWith('LUCH') || n.startsWith('RADUGA'))       return 'Russia (Military)'
  if (n.startsWith('SJ-') || n.startsWith('SHIJIAN'))       return 'China (Experimental)'
  if (n.startsWith('SHIYAN'))                               return 'China (Experimental)'
  if (n.startsWith('TJS-'))                                 return 'China (Military)'
  if (n.startsWith('TIANHUI'))                              return 'Tianhui'
  if (n.startsWith('TIANLIAN'))                             return 'Tianlian'
  if (n.startsWith('ZIYUAN'))                               return 'Ziyuan'
  if (n.startsWith('CZ-') || n.startsWith('LM-'))           return 'China (Rocket Bodies)'
  if (n.startsWith('SARAH'))                                return 'SARah (Germany)'
  if (n.startsWith('HELIOS'))                               return 'Helios'
  if (n.startsWith('PERSONA'))                              return 'Persona'

  // Science / exploration
  if (n.startsWith('HST') || n.startsWith('HUBBLE'))        return 'Hubble'
  if (n.startsWith('JWST') || n.startsWith('JAMES WEBB'))   return 'JWST'
  if (n.startsWith('TESS'))                                 return 'TESS'
  if (n.startsWith('CHANDRA'))                              return 'Chandra'
  if (n.startsWith('XMM-'))                                 return 'XMM-Newton'
  if (n.startsWith('SWIFT'))                                return 'Swift'
  if (n.startsWith('CHEOPS'))                               return 'CHEOPS'

  // Rocket bodies and debris (fallback, usually caught by object_type first)
  if (n.includes('R/B') || n.includes('ROCKET'))            return 'Rocket Bodies'
  if (n.includes('DEB') || n.includes('DEBRIS'))            return 'Debris'
  if (normalizedObjectType === 'Rocket Body')               return 'Rocket Bodies'
  if (normalizedObjectType === 'Debris')                    return 'Debris'
  if (normalizedObjectType === 'Payload')                   return 'Unmapped Payload'
  return 'Other'
}

export type SpaceConstellationCategory =
  | 'Finder'
  | 'Internet'
  | 'Communications'
  | 'Positioning'
  | 'Earth Imaging'
  | 'Weather'
  | 'Science'
  | 'IoT'
  | 'Other'

export const SPACE_CONSTELLATION_CATEGORY_ORDER: SpaceConstellationCategory[] = [
  'Finder',
  'Internet',
  'Communications',
  'Positioning',
  'Earth Imaging',
  'Weather',
  'Science',
  'IoT',
  'Other',
]

const SPACE_CONSTELLATION_CATEGORY_MAP: Record<string, SpaceConstellationCategory> = {
  Starlink: 'Internet',
  'LEO (Kuiper)': 'Internet',
  OneWeb: 'Internet',
  Qianfan: 'Internet',
  Guowang: 'Internet',
  GalaxySpace: 'Internet',
  'E-space': 'Internet',
  'Telesat Lightspeed': 'Internet',
  Iridium: 'Communications',
  Intelsat: 'Communications',
  SES: 'Communications',
  Eutelsat: 'Communications',
  Telesat: 'Communications',
  Viasat: 'Communications',
  Globalstar: 'Communications',
  'O3b (SES MEO)': 'Communications',
  'GPS (USAF)': 'Positioning',
  GLONASS: 'Positioning',
  Galileo: 'Positioning',
  BeiDou: 'Positioning',
  'Sentinel (ESA)': 'Earth Imaging',
  Landsat: 'Earth Imaging',
  'NASA EOS': 'Earth Imaging',
  'Maxar (Commercial ISR)': 'Earth Imaging',
  'Planet Labs': 'Earth Imaging',
  BlackSky: 'Earth Imaging',
  'GOES (NOAA)': 'Weather',
  NOAA: 'Weather',
  'Meteosat (EUMETSAT)': 'Weather',
  'Spire Global': 'Weather',
  MetOp: 'Weather',
  Himawari: 'Weather',
  Fengyun: 'Weather',
  ISS: 'Science',
  'Tiangong / CSS': 'Science',
  Hubble: 'Science',
  JWST: 'Science',
  TESS: 'Science',
  Chandra: 'Science',
  'XMM-Newton': 'Science',
  Swift: 'Science',
  CHEOPS: 'Science',
  Orbcomm: 'IoT',
  Swarm: 'IoT',
  'Kepler Communications': 'IoT',
  Kineis: 'IoT',
  Astrocast: 'IoT',
  'FOSSA Systems': 'IoT',
  'AST SpaceMobile': 'Communications',
  'Lynk Global': 'Communications',
  Inmarsat: 'Communications',
  Thuraya: 'Communications',
  'Arabsat / Badr': 'Communications',
  Turksat: 'Communications',
  Hispasat: 'Communications',
  'JSAT / Superbird': 'Communications',
  Astra: 'Communications',
  Gaofen: 'Earth Imaging',
  Yaogan: 'Earth Imaging',
  Jilin: 'Earth Imaging',
  'Capella Space': 'Earth Imaging',
  ICEYE: 'Earth Imaging',
  Umbra: 'Earth Imaging',
  Pleiades: 'Earth Imaging',
  PAZ: 'Earth Imaging',
  'NRO / USAF (classified)': 'Other',
  'NRO (classified)': 'Other',
  'NOSS / White Cloud': 'Other',
  'Cosmos (Russia)': 'Other',
  'Russia (Comms)': 'Communications',
  'Russia (Military)': 'Other',
  'China (Experimental)': 'Other',
  'China (Military)': 'Other',
  Tianhui: 'Earth Imaging',
  Tianlian: 'Communications',
  Ziyuan: 'Earth Imaging',
  'SARah (Germany)': 'Earth Imaging',
  Helios: 'Earth Imaging',
  Persona: 'Earth Imaging',
  'Unmapped Payload': 'Other',
}

export function getConstellationCategory(constellation: string): SpaceConstellationCategory {
  return SPACE_CONSTELLATION_CATEGORY_MAP[constellation] ?? 'Other'
}

// ── Space: normalize object_type ─────────────────────────────────
// Catalog values: 'PAYLOAD', 'ROCKET BODY', 'DEBRIS', 'UNKNOWN', null
export function normalizeObjectType(objectType: unknown): string {
  if (!objectType) return 'Unknown'
  const t = String(objectType).toUpperCase().trim()
  if (t === 'PAYLOAD')                      return 'Payload'
  if (t === 'ROCKET BODY' || t === 'R/B')   return 'Rocket Body'
  if (t.includes('DEBRIS') || t === 'DEB')  return 'Debris'
  return String(objectType)
}

// ── Space: normalize orbit class ──────────────────────────────────
// Catalog values: 'LEO', 'MEO', 'GEO', 'HEO', 'DEEP', etc.
// Falls back to computing from orbital_period_min if catalog field missing.
//   LEO:  period < 128 min   (~altitude <2000 km)
//   MEO:  128–1380 min       (~2000–35000 km)
//   GEO:  1430±15 min        (~35786 km)
//   HEO:  highly elliptical  (large period variance)
export function normalizeOrbitClass(
  orbitClass: unknown,
  orbitalPeriodMin?: unknown,
): string {
  // Try the catalog field first
  if (orbitClass) {
    const c = String(orbitClass).toUpperCase().trim()
    if (c === 'LEO')                               return 'LEO'
    if (c === 'MEO')                               return 'MEO'
    if (c === 'GEO' || c === 'GSO')               return 'GEO'
    if (c === 'HEO' || c.includes('ELLIPTICAL'))  return 'HEO'
    if (c === 'DEEP' || c.includes('DEEP'))        return 'Deep Space'
    if (c === 'IGO')                               return 'MEO' // Inclined Geosynchronous
  }

  // Fall back to period-based classification
  const p = typeof orbitalPeriodMin === 'number'
    ? orbitalPeriodMin
    : orbitalPeriodMin != null ? parseFloat(String(orbitalPeriodMin)) : NaN

  if (!isNaN(p)) {
    if (p < 128)             return 'LEO'
    if (p < 1380)            return 'MEO'
    if (p >= 1415 && p <= 1455) return 'GEO'
    if (p > 1455)            return 'HEO'
  }

  return 'Unknown'
}

// ── Sorting helpers ───────────────────────────────────────────────

// Sort order for object types (most useful first)
const OBJECT_TYPE_ORDER: Record<string, number> = {
  'Payload': 0, 'Rocket Body': 1, 'Debris': 2, 'Unknown': 3,
}

// Sort order for orbit classes (ascending altitude)
const ORBIT_CLASS_ORDER: Record<string, number> = {
  'LEO': 0, 'MEO': 1, 'GEO': 2, 'HEO': 3, 'Deep Space': 4, 'Unknown': 5,
}

export function objectTypeSort(a: string, b: string): number {
  return (OBJECT_TYPE_ORDER[a] ?? 99) - (OBJECT_TYPE_ORDER[b] ?? 99)
}

export function orbitClassSort(a: string, b: string): number {
  return (ORBIT_CLASS_ORDER[a] ?? 99) - (ORBIT_CLASS_ORDER[b] ?? 99)
}

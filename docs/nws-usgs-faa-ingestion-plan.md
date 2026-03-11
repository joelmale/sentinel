# NWS / USGS / FAA NOTAM Ingestion Plan

## Objective

Extend Sentinel's normalized disruption stack with:

- `NWS` weather alerts
- `USGS` earthquake events
- `FAA NOTAM` operational aviation restrictions and navigation disruptions

The target model remains:

- `signal -> normalized event -> correlation -> operator workflow`

These sources should feed the existing:

- `disruption_events`
- `disruption_observations`
- disruption map overlays
- disruption dashboards

## ACLED Auth Update

ACLED has moved away from the legacy query-param `email` / `key` flow.
Sentinel should treat ACLED as an OAuth-backed source:

- token endpoint: `https://acleddata.com/oauth/token`
- data endpoint: `https://api.acleddata.com/acled/read`
- bearer auth on data requests
- access tokens expire every 24 hours
- refresh tokens remain valid for 14 days

Implementation guidance:

1. Request an access token with:
   - `grant_type=password`
   - `client_id=acled`
   - `username`
   - `password`
2. Cache the bearer token in memory.
3. Refresh it before expiry using the refresh token.
4. Fall back to a fresh password grant if refresh fails or a `401` is returned.
5. Remove old `ACLED_EMAIL` / `ACLED_ACCESS_KEY` env vars from deployment docs.

## Source Priorities

### NWS

Role:

- primary official hazard source for weather-driven disruption
- polygon-based operational impact layer

Official references:

- <https://www.weather.gov/documentation/services-web-alerts>
- <https://www.weather.gov/documentation>

Access model:

- no API key required for alerts
- send a descriptive `User-Agent` that includes the deployment domain / contact

Planned normalized event mapping:

- `event_type=weather_alert`
- `category` values:
  - `storm`
  - `marine`
  - `flood`
  - `fire_weather`
  - `winter`
  - `heat`
  - `other_weather`

Trust/confidence:

- `source_trust_score=0.95`
- `confidence=0.95`

Collection plan:

1. Add `collectors/nws/collector.py`
2. Poll `api.weather.gov/alerts/active`
3. Support optional filters:
   - area
   - zone
   - point
   - event type
4. Normalize alert polygons directly into `disruption_events.geometry`
5. Use NWS alert `id` as `external_event_id`
6. Store timing:
   - onset
   - effective
   - expires
   - ends
7. Preserve raw CAP/NWS fields in `metadata`
8. Mark alerts resolved when they disappear or expire

Display plan:

- weather-colored polygon overlays
- timeline markers for issuance / expiry
- disruption dashboard category buckets for weather
- event detail card with headline, severity, certainty, urgency, affected area

## USGS

Role:

- primary official seismic trigger source
- explanatory source for multi-system physical disruption

Official references:

- <https://earthquake.usgs.gov/earthquakes/feed/v1.0/>
- <https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php>
- <https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson_detail.php>

Access model:

- public GeoJSON feeds
- no API key required

Planned normalized event mapping:

- `event_type=earthquake`
- `category=seismic`

Trust/confidence:

- `source_trust_score=0.97`
- `confidence=0.97`

Collection plan:

1. Add `collectors/usgs/collector.py`
2. Poll configurable summary feed, default:
   - `all_day.geojson`
3. Support env thresholds:
   - min magnitude
   - detail enrichment threshold
4. Use `feature.id` as `external_event_id`
5. Store point geometry from coordinates
6. Map severity from:
   - magnitude
   - USGS alert level if present
7. For higher-severity events, call detail feed and enrich:
   - tsunami products
   - shakemap
   - felt reports
   - impact metadata
8. Persist source URL and product refs in `metadata`

Display plan:

- seismic point markers with magnitude-scaled halos
- timeline markers
- dashboard seismic category
- “possible physical trigger” correlation hints for nearby infra/air/maritime disruptions

## FAA NOTAM

Role:

- official aviation operational restriction source
- crucial validator for GNSS and navigation disruptions

Official references reviewed:

- <https://www.faa.gov/about/initiatives/notam/what_is_a_notam>
- <https://www.faa.gov/data>
- <https://www.faa.gov/air_traffic/technology/swim/products/get_connected>
- <https://www.faa.gov/air_traffic/technology/swim/swift/swift-meeting-presentation-20-3-23-23>

Implementation constraint:

- do not scrape public NOTAM pages
- use official FAA API / data portal / SWIM-backed path only

Current integration note:

- Sentinel should document FAA env vars now, but leave `FAA_NOTAM_ENABLED=false` by default until the exact FAA access method and credentials are confirmed for the deployment.

Planned normalized event mapping:

- `event_type=aviation_navigation_disruption`
- `event_type=airport_operational_constraint`
- `event_type=airspace_restriction`

Category values:

- `aviation`
- `gnss`
- `navaid`
- `airport`
- `airspace`

Trust/confidence:

- `source_trust_score=0.96`
- `confidence=0.92-0.98` depending on geometry completeness and parsing certainty

Collection plan:

1. Confirm official access path and credentials
2. Add `collectors/faa_notam/collector.py`
3. Filter to:
   - GPS/GNSS interference
   - navaid outages
   - airport closures / restrictions
   - runway impacts
   - TFR / airspace restrictions when available
4. Prefer GeoJSON if provided by FAA access tier
5. Fall back to airport / navaid centroids when geometry is missing
6. Use NOTAM identifier as `external_event_id`
7. Persist parsed aviation metadata:
   - affected airport
   - facility / navaid
   - effective window
   - text summary
   - source link / reference

Display plan:

- airport / aviation-specific dashboard category
- point or polygon overlays
- correlation panel showing:
  - related airports
  - related flights
  - GPSJam overlap

## Correlation Rules

### GNSS

- If `GPSJam` cell severity exceeds threshold and `FAA NOTAM` GNSS event overlaps in time/space:
  - increase confidence
  - mark as `multi-source confirmed`

- If `GPSJam` active event has strong `adsb_thinning_score`:
  - increase confidence
  - raise operational impact score

### Weather

- If `NWS weather_alert` overlaps airport / port / outage event:
  - set `cause_hint=likely weather-driven`

### Seismic

- If `USGS earthquake` precedes or overlaps infra/power/connectivity disruption:
  - set `cause_hint=possible seismic trigger`

## Implementation Order

### Phase A

1. `collectors/nws`
2. `collectors/usgs`
3. map rendering colors/icons for weather and seismic
4. disruption dashboard category expansion

### Phase B

1. disruption detail panel
2. timeline markers for weather and seismic
3. first correlation rules:
   - GPSJam + ADS-B thinning
   - NWS + infra
   - USGS + infra

### Phase C

1. FAA NOTAM collector after access confirmation
2. GNSS / navaid / airport operational correlation
3. richer aviation impact scoring

## Required Future Environment Variables

### ACLED

```env
ACLED_ENABLED=true
ACLED_POLL_INTERVAL=1800
ACLED_API_URL=https://acleddata.com/api/acled/read
ACLED_TOKEN_URL=https://acleddata.com/oauth/token
ACLED_CLIENT_ID=acled
ACLED_USERNAME=
ACLED_PASSWORD=
ACLED_TIMEOUT_SEC=45
ACLED_TOKEN_REFRESH_SKEW_SEC=300
ACLED_LOOKBACK_DAYS=7
ACLED_LIMIT=500
ACLED_COUNTRIES=
ACLED_EVENT_TYPES=
```

Notes:

- ACLED auth is now OAuth bearer-token based.
- Store the ACLED account username and password, not the retired query-key values.
- The collector should refresh tokens in-process; operators should not need to rotate env vars every 24 hours.

### NWS

```env
NWS_ENABLED=true
NWS_POLL_INTERVAL=300
NWS_ALERTS_URL=https://api.weather.gov/alerts/active
NWS_USER_AGENT=opensentinel.net contact@opensentinel.net
NWS_AREA_FILTER=
NWS_ZONE_FILTER=
NWS_POINT_FILTER=
NWS_EVENT_FILTER=
NWS_SEVERITY_FILTER=
```

### USGS

```env
USGS_ENABLED=true
USGS_POLL_INTERVAL=300
USGS_FEED_URL=https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson
USGS_MIN_MAGNITUDE=2.5
USGS_DETAIL_MIN_MAGNITUDE=4.5
```

### FAA NOTAM

```env
FAA_NOTAM_ENABLED=false
FAA_NOTAM_BASE_URL=
FAA_NOTAM_API_KEY=
FAA_NOTAM_CLIENT_ID=
FAA_NOTAM_CLIENT_SECRET=
FAA_NOTAM_AIRPORTS=
FAA_NOTAM_INCLUDE_GPS=true
FAA_NOTAM_INCLUDE_TFR=true
FAA_NOTAM_INCLUDE_NAVAID=true
FAA_NOTAM_POLL_INTERVAL=300
```

## Current Disruption Env Baseline

The current implemented disruption envs remain:

```env
GPSJAM_ENABLED=true
GPSJAM_POLL_INTERVAL=3600
GPSJAM_DATA_URL_TEMPLATE=https://gpsjam.org/data/{date}.json
GPSJAM_DATE_FORMAT=%Y-%m-%d
GPSJAM_DATE_OFFSET_DAYS=0
GPSJAM_TIMEOUT_SEC=30
GPSJAM_MIN_SCORE=0.05

INFRA_POLL_INTERVAL=300
INFRA_TIMEOUT_SEC=30
IODA_ENABLED=true
IODA_LOOKBACK_MINUTES=30
POWEROUTAGE_ENABLED=true
POWEROUTAGE_API_KEY=
POWEROUTAGE_MIN_PERCENT=1.0
CLOUDFLARE_RADAR_ENABLED=false
CLOUDFLARE_RADAR_API_TOKEN=
CLOUDFLARE_RADAR_DATE_RANGE=1d
CLOUDFLARE_RADAR_LIMIT=100
EIA_ENABLED=false
EIA_API_KEY=
EIA_RTO_URL=https://api.eia.gov/v2/electricity/rto/region-data/data/
EIA_LIMIT=500
EIA_STRESS_DELTA_PCT=10

```

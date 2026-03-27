# Configuration And Integrations

Primary environment templates:

- [.env.example](/Users/JoelN/Coding/sentinel/.env.example)
- [.env.advanced.example](/Users/JoelN/Coding/sentinel/.env.advanced.example)

Use `.env.example` for the minimal local startup surface.
Use `.env.advanced.example` for full integration tuning and non-default overrides.

## Core stack configuration

Core runtime:

- PostgreSQL/TimescaleDB
- Redis
- frontend/API base URLs
- Docker stack/network settings
- Keycloak
- Grafana

Defaults now exist for most local runtime configuration:

- docker-compose provides development defaults for image tags, network name, Redis sizing, database password, Keycloak admin password, and API secret/keycloak URL
- API settings already default `DATABASE_URL`, `REDIS_URL`, `ENVIRONMENT`, and baseline Keycloak values
- collectors now default `DATABASE_URL` and `REDIS_URL` for local non-Docker runs

The minimal required overrides for a useful local stack should be treated as:

- `POSTGRES_PASSWORD`
- `SECRET_KEY`
- profile-specific admin passwords if running Keycloak or Grafana
- source credentials only for integrations you actually intend to use

## Collector integrations

### ADS-B

Configured via `.env` values for:

- OpenSky OAuth client
- ADSBx API key
- ADSBx binCraft cookies and browser fingerprint

Notes:

- binCraft is Cloudflare-sensitive and requires browser-like headers/cookies
- OpenSky and ADSBx have independent rate-limit/failure behavior

### AIS

Configured via:

- AISStream API key
- AccessAIS import path
- Global Fishing Watch token
- MarineTraffic public-page enrichment headers/cookies

Notes:

- MarineTraffic is best-effort and should be documented as such
- AIS mode materially changes ingestion behavior

### Space

Configured via:

- Space-Track credentials
- optional N2YO API key
- optional SatNOGS curated IDs
- watchlist path

### GPSJam

Configured via:

- H3 dataset URL template
- score thresholds
- backfill and polling settings

### Infra

Configured via:

- IODA endpoint
- PowerOutage.us key
- Cloudflare Radar token
- EIA API key

### ACLED

Configured via:

- OAuth/token credentials
- country and event-type filters

## Frontend runtime configuration

Primary variables:

- `VITE_API_BASE_URL`
- `VITE_WS_URL`

These determine REST and websocket routing in the Vite/browser runtime.

## Operational guidance

Must document explicitly:

- which integrations are essential vs optional
- which integrations are brittle or best-effort
- which cookies/headers should never be committed
- which credentials gate coverage quality in each domain
- which values are safe to leave at defaults in local development

## Recommended table for this page

Integration matrix:

- integration
- required env vars
- optional env vars
- data domain
- failure mode
- whether missing credentials degrade gracefully

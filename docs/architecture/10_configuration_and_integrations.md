# Configuration And Integrations

Primary environment template:

- [.env.example](/Users/JoelN/Coding/sentinel/.env.example)

This file should be treated as the main reference for runtime-integrated services and credentials.

## Core stack configuration

Core runtime:

- PostgreSQL/TimescaleDB
- Redis
- frontend/API base URLs
- Docker stack/network settings
- Keycloak
- Grafana

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

## Recommended table for this page

Integration matrix:

- integration
- required env vars
- optional env vars
- data domain
- failure mode
- whether missing credentials degrade gracefully

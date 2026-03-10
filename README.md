# SENTINEL — Open Source Geospatial Intelligence Manager

A self-hosted, Docker-based platform for ingesting, storing, and visualizing
multi-domain OSINT tracking data (air, maritime, space, GPS interference,
infrastructure outages) with live streaming and time-series playback.

## Quick Start

```bash
# 1. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your API credentials (see .env.example for links)

# 2. Start all services
make up

# 3. Open in browser
open http://localhost
```

## Architecture

```
[Collectors] → [Redis Streams] → [FastAPI WS Gateway] → [Browser]
     ↓
[TimescaleDB + PostGIS]
     ↑
[FastAPI REST API] ← [React + deck.gl + MapLibre]
```

## Services

| Service | Description |
|---|---|
| `caddy` | Reverse proxy + TLS |
| `frontend` | React + deck.gl map UI |
| `api` | FastAPI REST + WebSocket |
| `timescaledb` | PostgreSQL + PostGIS + TimescaleDB |
| `redis` | Real-time event bus |
| `keycloak` | Authentication (OAuth2/OIDC) |
| `collector-adsb` | ADS-B aircraft tracking (OpenSky) |
| `collector-ais` | AIS maritime tracking (AISHub) |
| `collector-space` | Satellite TLE + passes (Celestrak) |
| `collector-gpsjam` | GPS interference tiles (GPSJam.org) |
| `collector-infra` | Internet + power outages (IODA) |
| `grafana` | Operations monitoring |

## API Registration Required

Before running collectors, register for these free APIs:

- **OpenSky Network**: https://opensky-network.org (ADS-B)
- **AISHub**: https://www.aishub.net/join-us (Maritime — reciprocal feed)
- **Space-Track**: https://www.space-track.org/auth/createAccount (Orbital TLEs)

## Development

```bash
make dev-frontend   # Vite hot-reload on localhost:5173
make shell-api      # Shell into API container
make psql           # Open psql session
make logs           # Tail all service logs
make logs-adsb      # Tail specific service
```

## Project Plan

See `SENTINEL_Project_Plan.docx` for the full 6-phase implementation plan,
architecture decisions, data source documentation, and timeline.

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + MapLibre GL JS + deck.gl + Zustand
- **Backend**: FastAPI (Python 3.12) + asyncpg + Redis
- **Database**: TimescaleDB (PostgreSQL 16 + PostGIS)
- **Auth**: Keycloak
- **Infra**: Docker Compose + Caddy

## Directory Structure

```
sentinel/
├── frontend/          # React app
├── api/               # FastAPI backend
├── collectors/
│   ├── base/          # Shared BaseCollector class
│   ├── adsb/          # ADS-B / OpenSky collector
│   ├── ais/           # AIS / AISHub collector
│   ├── space/         # Satellite TLE collector
│   ├── gpsjam/        # GPS jamming collector
│   └── infra/         # Infrastructure outage collector
├── docker/
│   ├── caddy/         # Caddyfile
│   ├── timescaledb/   # DB init SQL (schema + hypertables)
│   └── keycloak/      # Realm config
├── docs/              # Architecture docs + runbooks
├── docker-compose.yml
├── .env.example
└── Makefile
```

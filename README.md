# SENTINEL

SENTINEL is a self-hosted geospatial intelligence platform for ingesting, storing, and visualizing live and historical open-source tracking data across multiple domains:

- Air: ADS-B aircraft tracking
- Maritime: AIS vessel tracking
- Space: satellite positions and watchlists
- GPS: GPS interference and jamming activity
- Infrastructure: outage and disruption feeds
- Conflict/disruption: ACLED event ingestion

The stack is Docker-first: collectors write events into TimescaleDB and Redis, FastAPI serves REST and WebSocket APIs, and the frontend renders a live MapLibre + deck.gl workspace.

## What Runs

Default `make up` starts:

- `caddy`: reverse proxy for the full stack on `http://localhost`
- `frontend`: production-style frontend container
- `api`: FastAPI REST + WebSocket backend
- `timescaledb`: PostgreSQL 16 + TimescaleDB + PostGIS
- `redis`: event bus / stream fan-out
- `collector-adsb`
- `collector-ais`
- `collector-space`
- `collector-gpsjam`
- `collector-infra`
- `collector-acled`

Optional profiles:

- `auth`: starts Keycloak
- `monitoring`: starts Grafana
- `historical`: starts the one-shot `collector-ais-history` importer

## Quick Start

### Prerequisites

- Docker Desktop or a running Docker Engine
- GNU `make`
- Node.js + npm only if you want the Vite development frontend

### 1. Configure environment

```bash
cp .env.example .env
```

At minimum, set:

- `POSTGRES_PASSWORD`
- `SECRET_KEY`

Most collectors support blank credentials and will degrade gracefully, but you will get a much more useful system if you also configure the source-specific variables you intend to use.

### 2. Start the full stack

```bash
make up
```

Open:

- App: `http://localhost`
- API docs: `http://localhost/api/docs`
- Health check: `http://localhost/health`
- Readiness check: `http://localhost/health/ready`

### 3. View logs or stop the stack

```bash
make logs
make down
```

## Development Workflow

The normal development path is split into backend and frontend processes:

### Backend in Docker

```bash
make dev-backend
```

This starts:

- `timescaledb`
- `redis`
- `api`
- all default collectors used in development

The API is exposed directly at `http://localhost:8000`.

### Frontend with Vite

```bash
make dev-frontend
```

This runs the frontend at `http://localhost:5173`.

Vite proxies:

- `/api/*` -> `http://localhost:8000`
- `/ws/*` -> `ws://localhost:8000`

### One-terminal option

```bash
make dev
```

This starts the backend stack in Docker and then runs Vite in the foreground.

## Common Commands

```bash
make up              # full stack via docker compose
make down            # stop all services
make build           # rebuild all images without cache
make logs            # tail all logs
make logs-api        # tail only API logs
make shell-api       # shell into API container
make shell-db        # shell into TimescaleDB container
make psql            # open psql inside the DB container
make redis-cli       # open redis-cli inside the Redis container
make lint-api        # ruff + mypy
make lint-frontend   # eslint + TypeScript
make test-api        # pytest inside API container
make reset-db        # destroy and reinitialize the DB volume
```

Run `make help` for the full list.

## Data Sources And Credentials

The `.env.example` file is the source of truth for supported environment variables. The main external integrations currently wired into the stack are:

- OpenSky Network: ADS-B auth
- ADSBexchange: optional ADS-B enrichment
- AISStream: live AIS vessel feed
- Global Fishing Watch: delayed maritime enrichment / coverage
- Space-Track: authoritative orbital catalog access
- N2YO: optional curated satellite lookups
- GPSJam: public GPS interference feed
- IODA: internet outage feed
- PowerOutage: power outage feed
- Cloudflare Radar: optional disruption feed
- EIA: optional US grid stress feed
- ACLED: conflict event feed

Not every source is required for a working local stack. Missing credentials generally reduce coverage rather than preventing startup.

## Architecture

```text
[Collectors] -> [Redis Streams] -> [FastAPI WebSocket Gateway] -> [Browser]
      |                  |
      v                  v
 [TimescaleDB + PostGIS] [FastAPI REST API]
```

Key implementation points:

- TimescaleDB stores time-series track and disruption data
- PostGIS supports spatial queries and map-oriented filtering
- Redis is used for live event fan-out to browser sessions
- FastAPI exposes REST endpoints under `/api/*` and the live WebSocket at `/ws/live`
- The frontend uses React, MapLibre, deck.gl, and Zustand

## Service Notes

### Database

- Schema initialization lives in [docker/timescaledb/init.sql](docker/timescaledb/init.sql)
- The Postgres data directory is persisted in the named volume `timescale_data`
- Changing `POSTGRES_PASSWORD` in `.env` does not update an existing initialized database; you must recreate the volume

### Auth and monitoring

- Keycloak is present but optional and only starts with the `auth` profile
- Grafana is present but optional and only starts with the `monitoring` profile

### Frontend map stack

- Base map: MapLibre
- Overlay rendering: deck.gl
- The frontend includes local GeoJSON assets under [frontend/public/data](frontend/public/data)

## Troubleshooting

### Docker daemon errors

If you see:

```text
Cannot connect to the Docker daemon
```

start Docker Desktop or your local Docker Engine first, then retry the `make` command.

### Rebuild the local database after changing DB credentials

```bash
make down
docker volume rm sentinel_timescale_data
make dev-backend
```

This is destructive and removes local Postgres data.

### Frontend dev server issues

If Vite behaves strangely after dependency or branch changes:

```bash
cd frontend
rm -rf node_modules
npm install
```

Then restart `make dev-frontend`.

## Repository Layout

```text
sentinel/
├── api/                     FastAPI application, routers, DB and Redis wiring
├── collectors/              Domain-specific ingestion services plus shared base code
├── docker/                  Caddy, DB init SQL, Keycloak, Grafana provisioning
├── docs/                    Design notes and implementation plans
├── frontend/                React + TypeScript UI
├── docker-compose.yml       Full stack definition
├── docker-compose.dev.yml   Development override for direct API + Vite workflow
├── Makefile                 Main entry point for common tasks
└── .env.example             Environment variable reference
```

## Useful Docs

The `docs/` directory contains more focused planning and source-specific notes. Current examples include:

- [docs/disruption-sources-roadmap.md](docs/disruption-sources-roadmap.md)
- [docs/space-identity-dedupe-plan.md](docs/space-identity-dedupe-plan.md)
- [docs/dockhand-npm-deploy.md](docs/dockhand-npm-deploy.md)

## Current Stack

- Frontend: React 18, TypeScript, Vite, MapLibre GL JS, deck.gl, Zustand
- Backend: FastAPI, SQLAlchemy async sessions, asyncpg, Redis
- Database: PostgreSQL 16, TimescaleDB, PostGIS
- Packaging/runtime: Docker Compose

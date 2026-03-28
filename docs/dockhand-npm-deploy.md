# Deploying Sentinel Behind Nginx Proxy Manager On Dockhand

This runbook assumes:

- your Docker server is already managed with Dockhand
- Nginx Proxy Manager is already your public reverse proxy
- your domain is `opensentinel.net`

The recommended topology is:

- NPM handles public `80/443`
- Sentinel exposes `frontend` and `api` to the shared Docker network `${EXTERNAL_PROXY_NETWORK:-homelab-net}`
- NPM proxies `/` to `frontend:80`
- NPM proxies `/api` and `/ws` to `api:8000`

This avoids running two reverse proxies in series.

## Architecture

Sentinel expects:

- frontend at `/`
- API at `/api/*`
- websocket at `/ws/*`

Do not expose Sentinel directly on host `80/443` if NPM is already using those ports.

Instead:

- NPM remains internet-facing
- Sentinel frontend and API are not published on any host port
- Sentinel `frontend` and `api` join `${EXTERNAL_PROXY_NETWORK:-homelab-net}`
- NPM reverse proxies to those service names across the shared Docker network

## DNS

Create these DNS records:

- `opensentinel.net` -> A record -> your server public IP
- `www.opensentinel.net` -> CNAME -> `opensentinel.net` or a second A record

In NPM, you can choose whether to redirect `www` to the apex domain.

## Files To Use

Use:

- [`docker-compose.dockhand.yml`](/Users/JoelN/Coding/sentinel/docker-compose.dockhand.yml)
- [`.env.dockhand.example`](/Users/JoelN/Coding/sentinel/.env.dockhand.example)
- [`.env.dockhand.advanced.example`](/Users/JoelN/Coding/sentinel/.env.dockhand.advanced.example)

## Step 1: Create Stack Environment In Dockhand

Do not rely on your local `.env`.

For Dockhand, define the environment variables in the stack configuration UI or a server-side env file managed by Dockhand.

Set at minimum:

```env
POSTGRES_PASSWORD=replace_with_a_real_db_password

SECRET_KEY=replace_with_a_long_random_secret
ENVIRONMENT=production

COMPOSE_PROJECT_NAME=sentinel
INTERNAL_DOCKER_NETWORK=sentinel-net
EXTERNAL_PROXY_NETWORK=homelab-net
SENTINEL_IMAGE_TAG=main

VITE_API_BASE_URL=/api
VITE_WS_URL=/ws

AISSTREAM_API_KEY=
OPENSKY_CLIENT_ID=
OPENSKY_CLIENT_SECRET=
SPACETRACK_USER=
SPACETRACK_PASS=
```

Optional deployment overrides you can also set in Dockhand:

```env
COMPOSE_PROJECT_NAME=sentinel
INTERNAL_DOCKER_NETWORK=sentinel-net
EXTERNAL_PROXY_NETWORK=homelab-net
SENTINEL_IMAGE_TAG=main
TIMESCALE_IMAGE=timescale/timescaledb-ha:pg16-ts2.24
REDIS_IMAGE=redis:7-alpine
KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:24.0
GRAFANA_IMAGE=grafana/grafana-oss:latest
REDIS_MAXMEMORY=512mb
REDIS_MAXMEMORY_POLICY=allkeys-lru
SCRAPE_SECRETS_DIR=./docker/secrets
```

Notes:

- do not put backticks or shell quotes around values
- if a collector source is not ready yet, leave the credential blank
- set `SENTINEL_IMAGE_TAG` to either the bare short commit hash (for example `a868b24`) or the `sha-`-prefixed form (for example `sha-a868b24`) if you want Dockhand to pull the exact GHCR images built for that commit; leave it as `main` to follow the moving branch tag
- optional disruption collectors are behind the `disruptions` compose profile in the Dockhand stack
- set `COMPOSE_PROFILES=disruptions` only if you want `collector-gpsjam`, `collector-infra`, and `collector-acled`
- Redis and Timescale data persist in Docker volumes
- do not place `MARINETRAFFIC_COOKIE_HEADER`, `MARINETRAFFIC_SEC_CH_UA`, `ADSBX_BINCRAFT_COOKIES`, or similar browser-fingerprint headers in the Dockhand env file; Dockhand-style parsers are brittle around semicolon-heavy values
- use the `*_FILE` variables from [`.env.dockhand.advanced.example`](/Users/JoelN/Coding/sentinel/.env.dockhand.advanced.example) for those values instead
- `${SCRAPE_SECRETS_DIR:-./docker/secrets}` is mounted read-only into `api`, `collector-adsb`, and `collector-ais` at `/run/secrets/sentinel`
- no separate "file mode" toggle is required; if `NAME_FILE` is set it overrides `NAME`, while feature toggles like `MARINETRAFFIC_ENRICH_ENABLED` and `BINCRAFT_AUTO_REFRESH_COOKIES` still control whether those scrape paths run

Recommended approach:

- keep [`.env.dockhand.example`](/Users/JoelN/Coding/sentinel/.env.dockhand.example) in git as Dockhand-specific documentation only
- keep [`.env.dockhand.advanced.example`](/Users/JoelN/Coding/sentinel/.env.dockhand.advanced.example) in git for optional file-backed scrape paths and tuning
- put real secrets into Dockhand stack env vars
- do not commit your real `.env.dockhand`

## Step 2: Create The Stack In Dockhand

Use [`docker-compose.dockhand.yml`](/Users/JoelN/Coding/sentinel/docker-compose.dockhand.yml) as the single compose file for the stack.

This will:

- pull the API/frontend/collectors from GHCR
- start TimescaleDB and Redis
- attach Sentinel `frontend` and `api` to `${EXTERNAL_PROXY_NETWORK:-homelab-net}`

Verify:

Use Dockhand logs and container status, or equivalent host commands if needed.

Expected:

- the `frontend` and `api` containers are attached to both `${INTERNAL_DOCKER_NETWORK}` and `${EXTERNAL_PROXY_NETWORK}`
- the API and frontend are healthy in the compose logs

## Step 3: Configure Nginx Proxy Manager

In NPM, create a Proxy Host:

- Domain Names:
  - `opensentinel.net`
  - optionally `www.opensentinel.net`
- Scheme:
  - `http`
- Forward Hostname / IP:
  - `frontend`
- Forward Port:
  - `80`

Recommended NPM options:

- `Block Common Exploits`: enabled
- `Websockets Support`: enabled
- `Cache Assets`: disabled

SSL tab:

- request a Let's Encrypt certificate
- enable `Force SSL`
- enable `HTTP/2 Support`
- enable `HSTS` if you already know the site is stable on HTTPS

Then add custom locations on the same Proxy Host:

- Location:
  - `/api`
  - Scheme: `http`
  - Forward Hostname / IP: `api`
  - Forward Port: `8000`
  - Enable `Websockets Support`
- Location:
  - `/ws`
  - Scheme: `http`
  - Forward Hostname / IP: `api`
  - Forward Port: `8000`
  - Enable `Websockets Support`

## Step 4: Firewall / Router

Expose to the internet only:

- `80/tcp`
- `443/tcp`

Do not expose:

- `5432`
- `6379`

## Step 5: Initial Validation

After NPM is live, test:

1. `https://opensentinel.net`
2. the browser UI loads fully
3. websocket connects
4. live assets begin appearing
5. a hard refresh still works on a non-root route

Useful checks:

Use Dockhand logs for:

- `api`
- `collector-adsb`
- `collector-ais`
- `collector-space`

## Operational Notes

### Database Persistence

Re-running the stack does not reset the database by itself.

Your data persists in Docker volumes unless you explicitly remove them with something like:

- `docker compose down -v`
- deleting the Timescale volume

### Reverse Proxying

Do not publish Sentinel frontend or API on public `80/443` on the host.

This runbook keeps NPM as the only public reverse proxy.
NPM reaches `frontend` and `api` over `${EXTERNAL_PROXY_NETWORK}`.

### Websockets

Sentinel uses websocket live updates at `/ws`.

If live data works inside the stack but not through NPM:

- re-check `Websockets Support` in NPM
- make sure the root host points to `frontend:80`
- make sure both `/api` and `/ws` custom locations point to `api:8000`

### Keycloak

Keycloak is optional and profile-gated in this repo.

Do not enable it for the first deployment unless you specifically want SSO now.

## Recommended First Deployment Scope

Start with:

- frontend
- API
- TimescaleDB
- Redis
- `collector-adsb`
- `collector-ais`
- `collector-space`

Leave these off initially unless you need them:

- `keycloak`
- `grafana`
- `collector-gpsjam`
- `collector-infra`
- `collector-acled`

## Recommended Public Branding

Use:

- primary URL: `https://opensentinel.net`
- optional redirect: `https://www.opensentinel.net` -> `https://opensentinel.net`

Suggested site title:

- `OpenSentinel`

Suggested short subtitle:

- `Operational OSINT Tracking`

## Local CLI Equivalent

If you ever need to reproduce the Dockhand deployment from the shell, use:

```bash
docker compose -f docker-compose.dockhand.yml pull
docker compose -f docker-compose.dockhand.yml up -d
```

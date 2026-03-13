# Deploying Sentinel Behind Nginx Proxy Manager On Dockhand

This runbook assumes:

- your Docker server is already managed with Dockhand
- Nginx Proxy Manager is already your public reverse proxy
- your domain is `opensentinel.net`

The recommended topology is:

- NPM handles public `80/443`
- Sentinel keeps its internal Caddy router for `/`, `/api`, and `/ws`
- Sentinel Caddy joins the shared Docker network `${EXTERNAL_PROXY_NETWORK:-homelab-net}`
- NPM proxies `opensentinel.net` to the `caddy` service by container/network name

This avoids fighting the existing app routing model.

## Architecture

Sentinel already expects one front door that serves:

- frontend at `/`
- API at `/api/*`
- websocket at `/ws/*`

That front door is the repo's `caddy` service.

Do not expose Sentinel's Caddy directly on `80/443` if NPM is already using those ports.

Instead:

- NPM remains internet-facing
- Sentinel Caddy is not published on any host port
- Sentinel Caddy joins `${EXTERNAL_PROXY_NETWORK:-homelab-net}`
- NPM reverse proxies to `http://caddy:80` across the shared Docker network

## DNS

Create these DNS records:

- `opensentinel.net` -> A record -> your server public IP
- `www.opensentinel.net` -> CNAME -> `opensentinel.net` or a second A record

In NPM, you can choose whether to redirect `www` to the apex domain.

## Files To Use

Use:

- [`docker-compose.dockhand.yml`](/Users/JoelN/Coding/sentinel/docker-compose.dockhand.yml)
- [`.env.example`](/Users/JoelN/Coding/sentinel/.env.example)

## Step 1: Create Stack Environment In Dockhand

Do not rely on your local `.env`.

For Dockhand, define the environment variables in the stack configuration UI or a server-side env file managed by Dockhand.

Set at minimum:

```env
POSTGRES_USER=sentinel
POSTGRES_PASSWORD=replace_with_a_real_db_password
POSTGRES_DB=sentinel

SECRET_KEY=replace_with_a_long_random_secret
ENVIRONMENT=production

VITE_API_BASE_URL=/api
VITE_WS_URL=/ws

AIS_MODE=merge
AISSTREAM_API_KEY=
GFW_API_TOKEN=

SPACETRACK_USER=
SPACETRACK_PASS=

ADSBEXCHANGE_API_KEY=
OPENSKY_USERNAME=
OPENSKY_PASSWORD=
```

Optional deployment overrides you can also set in Dockhand:

```env
COMPOSE_PROJECT_NAME=sentinel
INTERNAL_DOCKER_NETWORK=sentinel-net
EXTERNAL_PROXY_NETWORK=homelab-net
CADDY_IMAGE=caddy:2-alpine
TIMESCALE_IMAGE=timescale/timescaledb-ha:pg16-ts2.24
REDIS_IMAGE=redis:7-alpine
KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:24.0
GRAFANA_IMAGE=grafana/grafana-oss:latest
REDIS_MAXMEMORY=512mb
REDIS_MAXMEMORY_POLICY=allkeys-lru
```

Notes:

- do not put backticks or shell quotes around values
- if a collector source is not ready yet, leave the credential blank
- Redis and Timescale data persist in Docker volumes

Recommended approach:

- keep `.env.example` in git as documentation only
- put real secrets into Dockhand stack env vars
- do not commit your real `.env`

## Step 2: Create The Stack In Dockhand

Use [`docker-compose.dockhand.yml`](/Users/JoelN/Coding/sentinel/docker-compose.dockhand.yml) as the single compose file for the stack.

This will:

- pull the API/frontend/collectors from GHCR
- start TimescaleDB and Redis
- start Sentinel Caddy attached to `${EXTERNAL_PROXY_NETWORK:-homelab-net}`

Verify:

Use Dockhand logs and container status, or equivalent host commands if needed.

Expected:

- the Caddy container is attached to both `${INTERNAL_DOCKER_NETWORK}` and `${EXTERNAL_PROXY_NETWORK}`
- the API and frontend are healthy in the compose logs

## Step 3: Configure Nginx Proxy Manager

In NPM, create a Proxy Host:

- Domain Names:
  - `opensentinel.net`
  - optionally `www.opensentinel.net`
- Scheme:
  - `http`
- Forward Hostname / IP:
  - `caddy`
- Forward Port:
  - `80`

If you change `CADDY_CONTAINER_NAME`, NPM should still target the service/DNS name `caddy`, not the container name.

Recommended NPM options:

- `Block Common Exploits`: enabled
- `Websockets Support`: enabled
- `Cache Assets`: disabled

SSL tab:

- request a Let's Encrypt certificate
- enable `Force SSL`
- enable `HTTP/2 Support`
- enable `HSTS` if you already know the site is stable on HTTPS

Because Sentinel's internal Caddy already routes `/api` and `/ws`, you do not need separate custom locations in NPM.

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

### Caddy And NPM

Do not run both on public `80/443` on the same host.

This runbook avoids that by not publishing Sentinel's Caddy at all.
NPM reaches it over `${EXTERNAL_PROXY_NETWORK}`.

### Websockets

Sentinel uses websocket live updates at `/ws`.

If live data works inside the stack but not through NPM:

- re-check `Websockets Support` in NPM
- make sure NPM points to the `caddy` service on `${EXTERNAL_PROXY_NETWORK}`, not directly to the frontend container

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
- future disruption collectors

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

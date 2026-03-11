.PHONY: help up down build logs shell-api shell-db psql redis-cli reset-db \
        lint-api lint-frontend test-api dev-backend dev-frontend dev

# ── Compose file references ───────────────────────────────────────
DC      = docker compose
DC_DEV  = docker compose -f docker-compose.yml -f docker-compose.dev.yml

# ── Default ──────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  SENTINEL — make targets"
	@echo "  ─────────────────────────────────────────────"
	@echo "  ── Production / Full stack ──────────────────"
	@echo "  up              Start all services (Caddy + API + Frontend + DB + collectors)"
	@echo "  down            Stop all services"
	@echo "  build           Rebuild all images"
	@echo "  ── Development workflow ─────────────────────"
	@echo "  dev-backend     Start backend services with API on localhost:8000"
	@echo "                  (rebuilds changed images; no Caddy, no frontend container)"
	@echo "  dev-frontend    Run Vite dev server on localhost:5173 (hot-reload)"
	@echo "  dev             dev-backend + dev-frontend in one shot"
	@echo "  logs-api        Tail API logs"
	@echo "  logs-db         Tail DB logs"
	@echo "  ── Utilities ────────────────────────────────"
	@echo "  logs            Tail all logs"
	@echo "  shell-api       Exec shell into API container"
	@echo "  shell-db        Exec shell into DB container"
	@echo "  psql            Open psql session"
	@echo "  redis-cli       Open redis-cli session"
	@echo "  reset-db        Drop and re-init the database (DESTRUCTIVE)"
	@echo "  lint-api        Run ruff + mypy on API + collectors"
	@echo "  lint-frontend   Run eslint + tsc on frontend"
	@echo "  test-api        Run pytest on API"
	@echo ""

# ── Compose shortcuts ────────────────────────────────────────────
up:
	$(DC) up -d

down:
	$(DC) down

build:
	$(DC) build --no-cache

restart-%:
	$(DC) restart $*

logs:
	$(DC) logs -f --tail=100

logs-%:
	$(DC) logs -f --tail=100 $*

# ── Shell access ─────────────────────────────────────────────────
shell-api:
	$(DC) exec api /bin/bash

shell-db:
	$(DC) exec timescaledb /bin/bash

psql:
	$(DC) exec timescaledb psql -U $${POSTGRES_USER:-sentinel} -d $${POSTGRES_DB:-sentinel}

redis-cli:
	$(DC) exec redis redis-cli

# ── Database ─────────────────────────────────────────────────────
reset-db:
	@echo "WARNING: This will destroy all data. Press Ctrl-C to cancel, Enter to continue."
	@read confirm
	$(DC) down timescaledb
	docker volume rm sentinel_timescale_data || true
	$(DC) up -d timescaledb

# ── Linting ──────────────────────────────────────────────────────
lint-api:
	cd api && ruff check . && mypy .
	cd collectors/base && ruff check .

lint-frontend:
	cd frontend && npm run lint && npm run type-check

# ── Testing ──────────────────────────────────────────────────────
test-api:
	$(DC) exec api pytest tests/ -v

# ── Development workflow ──────────────────────────────────────────
#
# The dev workflow splits the stack into two parts:
#
#   Terminal 1:  make dev-backend   (Docker — DB + API on :8000 + all collectors)
#   Terminal 2:  make dev-frontend  (Vite on :5173, proxies /api + /ws → :8000)
#   Browser:     http://localhost:5173
#
# The dev override file (docker-compose.dev.yml) does two things:
#   1. Exposes api:8000 as localhost:8000 so Vite can reach it directly
#   2. Disables the frontend container and Caddy (not needed in dev)
#
# Caddy is the production router — think of it as the front-of-house.
# In dev you talk directly to the kitchen (FastAPI on :8000).

dev-backend:
	$(DC_DEV) up -d --build timescaledb redis api collector-adsb collector-ais collector-space collector-gpsjam collector-infra collector-acled
	@echo ""
	@echo "  Backend ready — API available at http://localhost:8000"
	@echo "  Run 'make dev-frontend' in another terminal to start Vite."
	@echo ""

dev-frontend:
	cd frontend && npm install && npm run dev

# Convenience: start backends (detached) then Vite in the foreground.
# Use this if you prefer a single terminal — Ctrl-C stops Vite but
# leaves Docker running; use 'make down' to stop everything.
dev:
	$(DC_DEV) up -d --build timescaledb redis api collector-adsb collector-ais collector-space collector-gpsjam collector-infra collector-acled
	cd frontend && npm install && npm run dev

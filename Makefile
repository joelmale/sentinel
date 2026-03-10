.PHONY: help up down build logs shell-api shell-db psql redis-cli reset-db \
        lint-api lint-frontend test-api dev-frontend

# ── Default ──────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  SENTINEL — make targets"
	@echo "  ─────────────────────────────────────────────"
	@echo "  up              Start all services"
	@echo "  down            Stop all services"
	@echo "  build           Rebuild all images"
	@echo "  logs            Tail all logs"
	@echo "  logs-api        Tail API logs"
	@echo "  logs-db         Tail DB logs"
	@echo "  shell-api       Exec shell into API container"
	@echo "  shell-db        Exec shell into DB container"
	@echo "  psql            Open psql session"
	@echo "  redis-cli       Open redis-cli session"
	@echo "  reset-db        Drop and re-init the database (DESTRUCTIVE)"
	@echo "  lint-api        Run ruff + mypy on API + collectors"
	@echo "  lint-frontend   Run eslint + tsc on frontend"
	@echo "  test-api        Run pytest on API"
	@echo "  dev-frontend    Run Vite dev server (hot-reload)"
	@echo ""

# ── Compose shortcuts ────────────────────────────────────────────
up:
	docker compose up -d

down:
	docker compose down

build:
	docker compose build --no-cache

restart-%:
	docker compose restart $*

logs:
	docker compose logs -f --tail=100

logs-%:
	docker compose logs -f --tail=100 $*

# ── Shell access ─────────────────────────────────────────────────
shell-api:
	docker compose exec api /bin/bash

shell-db:
	docker compose exec timescaledb /bin/bash

psql:
	docker compose exec timescaledb psql -U $${POSTGRES_USER:-sentinel} -d $${POSTGRES_DB:-sentinel}

redis-cli:
	docker compose exec redis redis-cli

# ── Database ─────────────────────────────────────────────────────
reset-db:
	@echo "WARNING: This will destroy all data. Press Ctrl-C to cancel, Enter to continue."
	@read confirm
	docker compose down timescaledb
	docker volume rm sentinel_timescale_data || true
	docker compose up -d timescaledb

# ── Linting ──────────────────────────────────────────────────────
lint-api:
	cd api && ruff check . && mypy .
	cd collectors/base && ruff check .

lint-frontend:
	cd frontend && npm run lint && npm run type-check

# ── Testing ──────────────────────────────────────────────────────
test-api:
	docker compose exec api pytest tests/ -v

# ── Frontend dev ─────────────────────────────────────────────────
dev-frontend:
	cd frontend && npm install && npm run dev

"""
SENTINEL API — FastAPI application entry point.

Architecture note: This module wires together the router modules
and lifespan context (DB pool + Redis connection). Think of it as
the central bus station — routers are the individual bus lines.
"""

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

from alert_evaluator import alert_evaluator_loop
from db.connection import db_pool
from redis_client import redis_pool
from routers import alerts, annotations, health, satellites, tracks, ws
from settings import Settings

settings = Settings()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    """Manage startup / shutdown of shared resources."""
    # Startup: initialize connection pools
    await db_pool.startup()
    await redis_pool.startup()
    print("✓ Database and Redis connected")

    yield  # Application runs here

    # Shutdown: close pools cleanly
    await db_pool.shutdown()
    await redis_pool.shutdown()
    print("✓ Connections closed")


app = FastAPI(
    title="SENTINEL API",
    description="Open Source Geospatial Intelligence Manager",
    version="0.1.0",
    default_response_class=ORJSONResponse,  # orjson is ~3x faster than stdlib json
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

# CORS — restrict in production to your actual frontend origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────
app.include_router(health.router)
app.include_router(tracks.router, prefix="/api")
app.include_router(annotations.router, prefix="/api")
app.include_router(alerts.router, prefix="/api")
app.include_router(satellites.router, prefix="/api")
app.include_router(ws.router)  # /ws prefix set inside router


# ── Background tasks ──────────────────────────────────────────────
@app.on_event("startup")
async def start_alert_evaluator() -> None:
    """Start the alert evaluator background task."""
    asyncio.create_task(alert_evaluator_loop())

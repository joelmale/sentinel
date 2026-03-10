from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from db.connection import get_db
from redis_client import get_redis

router = APIRouter(tags=["Health"])


@router.get("/health", summary="Liveness check")
async def health():
    return {"status": "ok"}


@router.get("/health/ready", summary="Readiness check — verifies DB + Redis")
async def readiness(
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
):
    checks = {}
    try:
        await db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as e:
        checks["database"] = f"error: {e}"

    try:
        await redis.ping()
        checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"error: {e}"

    all_ok = all(v == "ok" for v in checks.values())
    return {"status": "ready" if all_ok else "degraded", "checks": checks}

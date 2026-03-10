"""
Async SQLAlchemy + asyncpg database pool.

The pool is initialized once at app startup and shared across all
requests via FastAPI dependency injection. Analogous to a connection
pool in traditional server architectures — the pool maintains N warm
connections so each request doesn't pay TCP handshake overhead.
"""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from settings import Settings

settings = Settings()


class DatabasePool:
    def __init__(self) -> None:
        self.engine = None
        self.session_factory = None

    async def startup(self) -> None:
        self.engine = create_async_engine(
            settings.DATABASE_URL,
            pool_size=10,
            max_overflow=20,
            pool_pre_ping=True,       # verify connections are alive
            echo=settings.is_dev,     # log SQL in development
        )
        self.session_factory = async_sessionmaker(
            self.engine, class_=AsyncSession, expire_on_commit=False
        )

    async def shutdown(self) -> None:
        if self.engine:
            await self.engine.dispose()

    async def get_session(self) -> AsyncGenerator[AsyncSession, None]:
        async with self.session_factory() as session:
            yield session


db_pool = DatabasePool()


# FastAPI dependency
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async for session in db_pool.get_session():
        yield session

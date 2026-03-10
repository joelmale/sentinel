from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "postgresql+asyncpg://sentinel:sentinel@localhost:5432/sentinel"
    REDIS_URL: str = "redis://localhost:6379"
    SECRET_KEY: str = "dev_secret_change_in_production"
    ENVIRONMENT: str = "development"

    KEYCLOAK_URL: str = "http://localhost:8080"
    KEYCLOAK_REALM: str = "sentinel"
    KEYCLOAK_CLIENT_ID: str = "sentinel-api"

    # Comma-separated list of allowed CORS origins
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    # Default data retention (days) — overrides TimescaleDB policy
    RETENTION_DAYS: int = 90

    @property
    def is_dev(self) -> bool:
        return self.ENVIRONMENT == "development"

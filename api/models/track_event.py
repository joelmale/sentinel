"""
TrackEvent — the canonical schema for all domain data.

This is the lingua franca of SENTINEL. Every collector normalizes
its proprietary feed format into this model before writing to DB.
Think of it as the common wire format: like how TCP/IP gives all
applications a unified packet structure regardless of what network
technology carries them.
"""

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator


class SourceDomain(str, Enum):
    AIR = "Air"
    MARITIME = "Maritime"
    SPACE = "Space"
    GPS = "GPS"
    INFRA = "Infra"


class Position(BaseModel):
    """WGS84 coordinate pair."""
    lon: float = Field(..., ge=-180, le=180)
    lat: float = Field(..., ge=-90, le=90)


class TrackEvent(BaseModel):
    """
    A single position/state report from any domain.
    Stored in the track_events hypertable.
    """
    event_id: UUID = Field(default_factory=uuid4)
    source_domain: SourceDomain
    source_feed: str = Field(..., max_length=64)
    track_id: str = Field(..., max_length=64)     # ICAO hex, MMSI, NORAD ID, etc.
    callsign: str | None = None
    position: Position | None = None              # None for infrastructure/polygon events
    altitude_m: float | None = None
    heading_deg: float | None = Field(None, ge=0, le=360)
    speed_mps: float | None = Field(None, ge=0)
    timestamp: datetime
    metadata: dict[str, Any] = Field(default_factory=dict)
    classification: str | None = None             # Commercial/Military/Unknown/SAR/etc.
    ingested_at: datetime | None = None

    @field_validator("heading_deg", mode="before")
    @classmethod
    def normalize_heading(cls, v: float | None) -> float | None:
        """Normalize heading to 0-360 range."""
        if v is None:
            return None
        return v % 360

    def to_geojson_feature(self) -> dict[str, Any]:
        """Serialize to GeoJSON Feature for deck.gl consumption."""
        geometry = None
        if self.position:
            geometry = {
                "type": "Point",
                "coordinates": [self.position.lon, self.position.lat],
            }
        return {
            "type": "Feature",
            "geometry": geometry,
            "properties": {
                "event_id": str(self.event_id),
                "source_domain": self.source_domain.value,
                "source_feed": self.source_feed,
                "track_id": self.track_id,
                "callsign": self.callsign,
                "altitude_m": self.altitude_m,
                "heading_deg": self.heading_deg,
                "speed_mps": self.speed_mps,
                "timestamp": self.timestamp.isoformat(),
                "classification": self.classification,
                **self.metadata,
            },
        }


class TrackHistoryRequest(BaseModel):
    """Query parameters for the /tracks/history endpoint."""
    domain: SourceDomain | None = None
    track_id: str | None = None
    t_start: datetime = Field(..., description="ISO8601 start time (UTC)")
    t_end: datetime = Field(..., description="ISO8601 end time (UTC)")
    # Bounding box: [min_lon, min_lat, max_lon, max_lat]
    bbox: tuple[float, float, float, float] | None = None
    limit: int = Field(default=10_000, le=100_000)
    offset: int = Field(default=0, ge=0)

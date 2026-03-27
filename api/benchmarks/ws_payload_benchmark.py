from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TypedDict

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))


class SampleEvent(TypedDict):
    source_domain: str
    track_id: str
    timestamp: str
    lon: float
    lat: float
    altitude_m: int
    heading_deg: int
    speed_mps: int
    classification: str
    source_feed: str


def build_sample_events(count: int = 250) -> list[SampleEvent]:
    start = datetime(2026, 3, 27, 12, 0, tzinfo=timezone.utc)
    events: list[SampleEvent] = []
    for index in range(count):
        events.append({
            "source_domain": "Air",
            "track_id": f"TEST{index:05d}",
            "timestamp": (start + timedelta(seconds=index)).isoformat(),
            "lon": -80.0 + (index * 0.01),
            "lat": 35.0 + (index * 0.01),
            "altitude_m": 10_000 + index,
            "heading_deg": (index * 3) % 360,
            "speed_mps": 220 + (index % 30),
            "classification": "Commercial",
            "source_feed": "opensky",
        })
    return events


def build_updated_events(events: list[SampleEvent]) -> list[SampleEvent]:
    updated: list[SampleEvent] = []
    for index, event in enumerate(events):
        updated.append({
            "source_domain": event["source_domain"],
            "track_id": event["track_id"],
            "timestamp": (datetime.fromisoformat(event["timestamp"]) + timedelta(seconds=5)).isoformat(),
            "lon": event["lon"] + 0.02,
            "lat": event["lat"] + 0.015,
            "altitude_m": event["altitude_m"],
            "heading_deg": (event["heading_deg"] + 4) % 360,
            "speed_mps": event["speed_mps"],
            "classification": event["classification"],
            "source_feed": event["source_feed"],
        })
        if index % 5 == 0:
            updated[-1]["speed_mps"] = event["speed_mps"] + 1
    return updated


def main() -> None:
    from routers import ws

    baseline_events = build_sample_events()
    updated_events = build_updated_events(baseline_events)

    full_payload_bytes = 0
    delta_payload_bytes = 0
    emitted_deltas = 0

    for previous, current in zip(baseline_events, updated_events, strict=True):
        full_payload_bytes += len(json.dumps(current, separators=(",", ":"), sort_keys=True))
        delta = ws._build_track_delta(previous, current)
        if delta is None or not ws._should_emit_delta(current, delta):
            delta_payload_bytes += len(json.dumps(current, separators=(",", ":"), sort_keys=True))
            continue
        emitted_deltas += 1
        delta_payload_bytes += len(json.dumps(delta, separators=(",", ":"), sort_keys=True))

    savings = full_payload_bytes - delta_payload_bytes
    savings_pct = (savings / full_payload_bytes * 100) if full_payload_bytes else 0

    print("WS payload benchmark")
    print(f"sample_events={len(updated_events)}")
    print(f"full_payload_bytes={full_payload_bytes}")
    print(f"delta_payload_bytes={delta_payload_bytes}")
    print(f"emitted_deltas={emitted_deltas}")
    print(f"bytes_saved={savings}")
    print(f"percent_saved={savings_pct:.2f}")


if __name__ == "__main__":
    main()

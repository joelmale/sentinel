from __future__ import annotations

import json

import pytest

from routers import ws


def test_build_track_delta_only_includes_changed_fields() -> None:
    previous = {
        "source_domain": "Air",
        "track_id": "ABC123",
        "timestamp": "2026-03-27T10:00:00Z",
        "lon": 10.0,
        "lat": 20.0,
        "speed_mps": 200,
        "classification": "Commercial",
    }
    current = {
        **previous,
        "timestamp": "2026-03-27T10:00:05Z",
        "lon": 10.2,
        "lat": 20.1,
    }

    delta = ws._build_track_delta(previous, current)

    assert delta == {
        "source_domain": "Air",
        "track_id": "ABC123",
        "timestamp": "2026-03-27T10:00:05Z",
        "lon": 10.2,
        "lat": 20.1,
    }


def test_should_emit_delta_prefers_full_payload_when_savings_are_small() -> None:
    current = {
        "source_domain": "Air",
        "track_id": "ABC123",
        "timestamp": "2026-03-27T10:00:05Z",
        "lon": 10.2,
        "note": "x",
    }
    delta = {
        "source_domain": "Air",
        "track_id": "ABC123",
        "timestamp": "2026-03-27T10:00:05Z",
        "lon": 10.2,
    }

    assert ws._should_emit_delta(current, delta) is False


@pytest.mark.asyncio
async def test_claim_pending_entries_uses_requested_idle_and_publishes_claimed_entries(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[int, int | None]] = []
    published_batches: list[list[tuple[str, dict[str, str]]]] = []

    class FakeRedis:
        def __init__(self) -> None:
            self.responses = [
                ["0-1", [("1-0", {"payload": json.dumps({"source_domain": "Air", "track_id": "A1", "timestamp": "2026-03-27T10:00:00Z"})})], []],
                ["0-0", [], []],
            ]

        async def xautoclaim(self, stream, group, consumer, min_idle_time, start_id, count):
            calls.append((min_idle_time, count))
            return self.responses.pop(0)

    async def fake_publish_stream_entries(redis, entries) -> None:
        published_batches.append(entries)

    monkeypatch.setattr(ws, "_publish_stream_entries", fake_publish_stream_entries)

    reclaimed = await ws._claim_pending_entries(
        FakeRedis(),
        min_idle_ms=ws.WS_FAILOVER_PENDING_IDLE_MS,
        max_rounds=ws.WS_FAILOVER_RECLAIM_ROUNDS,
    )

    assert reclaimed == 1
    assert calls[0][0] == ws.WS_FAILOVER_PENDING_IDLE_MS
    assert published_batches == [[("1-0", {"payload": '{"source_domain": "Air", "track_id": "A1", "timestamp": "2026-03-27T10:00:00Z"}'})]]


@pytest.mark.asyncio
async def test_get_ws_broadcast_snapshot_includes_runtime_and_backlog(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeRedis:
        async def get(self, key):
            assert key == ws.WS_LEADER_KEY
            return ws.INSTANCE_ID

        async def xlen(self, key):
            assert key == ws.STREAM_KEY
            return 42

        async def xinfo_groups(self, key):
            assert key == ws.STREAM_KEY
            return [{"name": ws.CONSUMER_GROUP, "pending": 7, "consumers": 3}]

    async def fake_get_redis():
        return FakeRedis()

    monkeypatch.setattr(ws, "get_redis", fake_get_redis)
    ws.ws_runtime_metrics["last_pubsub_lag_ms"] = 12.5

    snapshot = await ws.get_ws_broadcast_snapshot()

    assert snapshot["is_leader"] is True
    assert snapshot["stream_length"] == 42
    assert snapshot["group_pending"] == 7
    assert snapshot["group_consumers"] == 3
    assert snapshot["runtime"]["last_pubsub_lag_ms"] == 12.5

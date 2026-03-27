from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from redis.asyncio import Redis

from redis_client import STREAM_KEY

SEVERITY_RANK = {"low": 1, "medium": 2, "high": 3, "critical": 4}


@dataclass
class AnomalyCandidate:
    detector_key: str
    dedupe_key: str
    domain: str
    title: str
    severity: str
    confidence: float
    occurred_at: datetime
    track_id: str | None = None
    entity_id: str | None = None
    bbox: dict[str, float] | None = None
    metrics: dict[str, Any] | None = None
    evidence: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


async def ensure_runtime_schema(conn) -> None:
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS anomaly_events (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            detector_key TEXT NOT NULL,
            dedupe_key TEXT NOT NULL UNIQUE,
            source_domain source_domain NOT NULL,
            title TEXT NOT NULL,
            severity TEXT NOT NULL DEFAULT 'medium',
            confidence DOUBLE PRECISION,
            status TEXT NOT NULL DEFAULT 'open',
            track_id TEXT,
            entity_id UUID,
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at TIMESTAMPTZ,
            bbox JSONB DEFAULT '{}'::jsonb,
            metrics JSONB DEFAULT '{}'::jsonb,
            evidence JSONB DEFAULT '{}'::jsonb,
            metadata JSONB DEFAULT '{}'::jsonb
        )
        """
    )
    await conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_anomaly_events_domain_time
            ON anomaly_events (source_domain, status, last_seen DESC)
        """
    )
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS incident_cases (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            case_key TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            summary TEXT,
            severity TEXT NOT NULL DEFAULT 'medium',
            confidence DOUBLE PRECISION,
            status TEXT NOT NULL DEFAULT 'open',
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at TIMESTAMPTZ,
            domains TEXT[] NOT NULL DEFAULT '{}',
            bbox JSONB DEFAULT '{}'::jsonb,
            evidence JSONB DEFAULT '{}'::jsonb,
            metadata JSONB DEFAULT '{}'::jsonb
        )
        """
    )
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS incident_case_members (
            case_id UUID NOT NULL REFERENCES incident_cases(id) ON DELETE CASCADE,
            member_type TEXT NOT NULL,
            member_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (case_id, member_type, member_id)
        )
        """
    )


async def publish_runtime_event(redis: Redis | None, message: dict[str, Any]) -> None:
    if redis is None:
        return
    await redis.xadd(
        STREAM_KEY,
        {"payload": json.dumps(message, allow_nan=False)},
        maxlen=50_000,
        approximate=True,
    )


async def ensure_system_rule(conn, key: str, name: str, domain: str) -> str:
    existing = await conn.fetchval(
        "SELECT id::text FROM alert_rules WHERE created_by = 'system' AND name = $1 AND domain = $2 LIMIT 1",
        name,
        domain,
    )
    if existing:
        return str(existing)

    row = await conn.fetchval(
        """
        INSERT INTO alert_rules (name, created_by, is_active, domain, conditions, notify_channels)
        VALUES ($1, 'system', true, $2::source_domain, $3::jsonb, ARRAY['websocket']::text[])
        RETURNING id::text
        """,
        name,
        domain,
        json.dumps({"system_key": key}),
    )
    return str(row)


async def detect_anomalies(conn) -> list[AnomalyCandidate]:
    anomalies: list[AnomalyCandidate] = []
    now = datetime.now(timezone.utc)

    density_rows = await conn.fetch(
        """
        WITH windows AS (
            SELECT
                source_domain,
                COUNT(DISTINCT track_id) FILTER (WHERE timestamp >= NOW() - INTERVAL '15 minutes') AS current_count,
                COUNT(DISTINCT track_id) FILTER (
                    WHERE timestamp >= NOW() - INTERVAL '30 minutes'
                      AND timestamp < NOW() - INTERVAL '15 minutes'
                ) AS previous_count
            FROM track_events
            WHERE source_domain IN ('Air', 'Maritime')
              AND timestamp >= NOW() - INTERVAL '30 minutes'
            GROUP BY source_domain
        )
        SELECT source_domain, current_count, previous_count
        FROM windows
        WHERE previous_count >= 20
          AND current_count <= previous_count * 0.6
        """
    )
    for row in density_rows:
        previous_count = int(row["previous_count"] or 0)
        current_count = int(row["current_count"] or 0)
        drop_ratio = 1 - (current_count / max(previous_count, 1))
        severity = "critical" if drop_ratio >= 0.7 else "high"
        anomalies.append(
            AnomalyCandidate(
                detector_key="domain_density_drop",
                dedupe_key=f"{row['source_domain']}:domain_density_drop",
                domain=str(row["source_domain"]),
                title=f"{row['source_domain']} live density dropped sharply",
                severity=severity,
                confidence=round(min(0.98, 0.55 + drop_ratio * 0.5), 2),
                occurred_at=now,
                metrics={
                    "current_count": current_count,
                    "previous_count": previous_count,
                    "drop_ratio": round(drop_ratio, 3),
                },
                evidence={
                    "window": "15m_vs_previous_15m",
                    "detector": "domain_density_drop",
                },
            )
        )

    gps_rows = await conn.fetch(
        """
        SELECT
            id::text AS disruption_id,
            source_domain,
            title,
            severity,
            confidence,
            last_seen,
            ST_XMin(geometry::box3d) AS west,
            ST_YMin(geometry::box3d) AS south,
            ST_XMax(geometry::box3d) AS east,
            ST_YMax(geometry::box3d) AS north
        FROM disruption_events
        WHERE source_domain = 'GPS'
          AND status = 'active'
          AND last_seen >= NOW() - INTERVAL '45 minutes'
          AND COALESCE(severity, 0) >= 40
        ORDER BY last_seen DESC
        LIMIT 10
        """
    )
    for row in gps_rows:
        severity_num = float(row["severity"] or 0)
        anomalies.append(
            AnomalyCandidate(
                detector_key="gps_interference_active",
                dedupe_key=f"GPS:gps_interference_active:{row['disruption_id']}",
                domain="GPS",
                title=row["title"] or "Active GPS interference event",
                severity="critical" if severity_num >= 70 else "high",
                confidence=float(row["confidence"] or 0.8),
                occurred_at=row["last_seen"] or now,
                bbox=_bbox_from_row(row),
                metrics={"severity_value": severity_num},
                evidence={
                    "detector": "gps_interference_active",
                    "disruption_id": row["disruption_id"],
                },
            )
        )

    source_rows = await conn.fetch(
        """
        WITH latest_runs AS (
            SELECT DISTINCT ON (s.source_feed)
                s.source_feed,
                s.source_domain,
                sr.status,
                sr.last_success_at,
                EXTRACT(EPOCH FROM (NOW() - sr.last_success_at)) / 60.0 AS lag_minutes
            FROM sources s
            LEFT JOIN source_runs sr ON sr.source_feed = s.source_feed
            ORDER BY s.source_feed, sr.started_at DESC
        )
        SELECT source_feed, source_domain, status, last_success_at, lag_minutes
        FROM latest_runs
        WHERE last_success_at IS NULL
           OR last_success_at < NOW() - INTERVAL '20 minutes'
           OR status IS DISTINCT FROM 'running'
        ORDER BY lag_minutes DESC NULLS LAST
        LIMIT 15
        """
    )
    for row in source_rows:
        lag_minutes = float(row["lag_minutes"] or 999)
        anomalies.append(
            AnomalyCandidate(
                detector_key="source_feed_degraded",
                dedupe_key=f"{row['source_domain']}:source_feed_degraded:{row['source_feed']}",
                domain=str(row["source_domain"]),
                title=f"Collector degraded: {row['source_feed']}",
                severity="high" if lag_minutes >= 60 or row["status"] in {"failed", "error"} else "medium",
                confidence=0.92,
                occurred_at=now,
                metrics={
                    "lag_minutes": round(lag_minutes, 1),
                    "status": row["status"],
                },
                evidence={
                    "detector": "source_feed_degraded",
                    "source_feed": row["source_feed"],
                    "last_success_at": row["last_success_at"].isoformat() if row["last_success_at"] else None,
                },
            )
        )

    return anomalies


async def upsert_anomalies(conn, redis: Redis | None, anomalies: list[AnomalyCandidate]) -> list[dict[str, Any]]:
    open_keys = {item.dedupe_key for item in anomalies}
    rows = await conn.fetch(
        "SELECT id::text, dedupe_key FROM anomaly_events WHERE status = 'open'"
    )
    existing_open = {str(row["dedupe_key"]): str(row["id"]) for row in rows}

    if open_keys:
        await conn.execute(
            """
            UPDATE anomaly_events
            SET status = 'resolved', resolved_at = NOW()
            WHERE status = 'open'
              AND dedupe_key <> ALL($1::text[])
            """,
            list(open_keys),
        )
    else:
        await conn.execute(
            "UPDATE anomaly_events SET status = 'resolved', resolved_at = NOW() WHERE status = 'open'"
        )

    upserted: list[dict[str, Any]] = []
    for anomaly in anomalies:
        row = await conn.fetchrow(
            """
            INSERT INTO anomaly_events (
                detector_key, dedupe_key, source_domain, title, severity, confidence,
                track_id, entity_id, occurred_at, first_seen, last_seen, bbox, metrics, evidence, metadata
            )
            VALUES (
                $1, $2, $3::source_domain, $4, $5, $6,
                $7, $8::uuid, $9, NOW(), NOW(), $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb
            )
            ON CONFLICT (dedupe_key) DO UPDATE SET
                title = EXCLUDED.title,
                severity = EXCLUDED.severity,
                confidence = EXCLUDED.confidence,
                status = 'open',
                resolved_at = NULL,
                track_id = EXCLUDED.track_id,
                entity_id = EXCLUDED.entity_id,
                occurred_at = EXCLUDED.occurred_at,
                last_seen = NOW(),
                bbox = EXCLUDED.bbox,
                metrics = EXCLUDED.metrics,
                evidence = anomaly_events.evidence || EXCLUDED.evidence,
                metadata = anomaly_events.metadata || EXCLUDED.metadata
            RETURNING id::text, detector_key, dedupe_key, source_domain::text AS source_domain,
                      title, severity, confidence, status, track_id, entity_id::text, occurred_at,
                      first_seen, last_seen, bbox, metrics, evidence
            """,
            anomaly.detector_key,
            anomaly.dedupe_key,
            anomaly.domain,
            anomaly.title,
            anomaly.severity,
            anomaly.confidence,
            anomaly.track_id,
            anomaly.entity_id,
            anomaly.occurred_at,
            json.dumps(anomaly.bbox or {}),
            json.dumps(anomaly.metrics or {}),
            json.dumps(anomaly.evidence or {}),
            json.dumps(anomaly.metadata or {}),
        )
        if row is None:
            continue
        payload = _normalize_record(dict(row))
        upserted.append(payload)
        if anomaly.dedupe_key not in existing_open:
            await publish_runtime_event(redis, {"type": "anomaly", **payload})
    return upserted


async def correlate_incidents(conn, redis: Redis | None) -> list[dict[str, Any]]:
    anomalies = await conn.fetch(
        """
        SELECT id::text, detector_key, source_domain::text AS source_domain, title, severity, confidence,
               occurred_at, last_seen, bbox, evidence, metrics
        FROM anomaly_events
        WHERE status = 'open'
          AND last_seen >= NOW() - INTERVAL '6 hours'
        ORDER BY last_seen DESC
        """
    )

    groups: list[dict[str, Any]] = []
    by_detector_domain = {(str(row["source_domain"]), str(row["detector_key"])): dict(row) for row in anomalies}

    gps = by_detector_domain.get(("GPS", "gps_interference_active"))
    air = by_detector_domain.get(("Air", "domain_density_drop"))
    maritime = by_detector_domain.get(("Maritime", "domain_density_drop"))

    if gps and air:
        groups.append(
            {
                "case_key": "gps-air-navigation-disruption",
                "title": "Possible aviation navigation disruption",
                "summary": "GPS interference overlaps with an air traffic density drop.",
                "severity": _max_severity([str(gps["severity"]), str(air["severity"])]),
                "confidence": round(max(float(gps["confidence"] or 0), float(air["confidence"] or 0)), 2),
                "domains": ["GPS", "Air"],
                "members": [("anomaly", str(gps["id"])), ("anomaly", str(air["id"]))],
                "bbox": _merge_bbox_dicts([gps.get("bbox"), air.get("bbox")]),
                "evidence": {
                    "detectors": ["gps_interference_active", "domain_density_drop"],
                },
            }
        )
    if gps and maritime:
        groups.append(
            {
                "case_key": "gps-maritime-navigation-disruption",
                "title": "Possible maritime navigation disruption",
                "summary": "GPS interference overlaps with a maritime traffic density drop.",
                "severity": _max_severity([str(gps["severity"]), str(maritime["severity"])]),
                "confidence": round(max(float(gps["confidence"] or 0), float(maritime["confidence"] or 0)), 2),
                "domains": ["GPS", "Maritime"],
                "members": [("anomaly", str(gps["id"])), ("anomaly", str(maritime["id"]))],
                "bbox": _merge_bbox_dicts([gps.get("bbox"), maritime.get("bbox")]),
                "evidence": {
                    "detectors": ["gps_interference_active", "domain_density_drop"],
                },
            }
        )

    degraded_by_domain: dict[str, list[dict[str, Any]]] = {}
    for row in anomalies:
        if row["detector_key"] != "source_feed_degraded":
            continue
        degraded_by_domain.setdefault(str(row["source_domain"]), []).append(dict(row))

    for domain, members in degraded_by_domain.items():
        if not members:
            continue
        groups.append(
            {
                "case_key": f"{domain.lower()}-ingest-degradation",
                "title": f"{domain} ingest degradation",
                "summary": f"{len(members)} collector feeds appear stale or degraded.",
                "severity": _max_severity([str(member["severity"]) for member in members]),
                "confidence": round(max(float(member["confidence"] or 0) for member in members), 2),
                "domains": [domain],
                "members": [("anomaly", str(member["id"])) for member in members],
                "bbox": {},
                "evidence": {
                    "detectors": ["source_feed_degraded"],
                    "member_count": len(members),
                },
            }
        )

    active_keys = [group["case_key"] for group in groups]
    if active_keys:
        await conn.execute(
            """
            UPDATE incident_cases
            SET status = 'resolved', resolved_at = NOW()
            WHERE status = 'open'
              AND case_key <> ALL($1::text[])
            """,
            active_keys,
        )
    else:
        await conn.execute(
            "UPDATE incident_cases SET status = 'resolved', resolved_at = NOW() WHERE status = 'open'"
        )

    existing_rows = await conn.fetch("SELECT id::text, case_key FROM incident_cases WHERE status = 'open'")
    existing = {str(row["case_key"]): str(row["id"]) for row in existing_rows}

    upserted: list[dict[str, Any]] = []
    for group in groups:
        row = await conn.fetchrow(
            """
            INSERT INTO incident_cases (case_key, title, summary, severity, confidence, status, started_at, last_seen, domains, bbox, evidence)
            VALUES ($1, $2, $3, $4, $5, 'open', NOW(), NOW(), $6::text[], $7::jsonb, $8::jsonb)
            ON CONFLICT (case_key) DO UPDATE SET
                title = EXCLUDED.title,
                summary = EXCLUDED.summary,
                severity = EXCLUDED.severity,
                confidence = EXCLUDED.confidence,
                status = 'open',
                resolved_at = NULL,
                last_seen = NOW(),
                domains = EXCLUDED.domains,
                bbox = EXCLUDED.bbox,
                evidence = incident_cases.evidence || EXCLUDED.evidence
            RETURNING id::text, case_key, title, summary, severity, confidence, status,
                      started_at, last_seen, resolved_at, domains, bbox, evidence
            """,
            group["case_key"],
            group["title"],
            group["summary"],
            group["severity"],
            group["confidence"],
            group["domains"],
            json.dumps(group["bbox"] or {}),
            json.dumps(group["evidence"] or {}),
        )
        if row is None:
            continue
        case_id = str(row["id"])
        await conn.execute("DELETE FROM incident_case_members WHERE case_id = $1::uuid", case_id)
        for member_type, member_id in group["members"]:
            await conn.execute(
                """
                INSERT INTO incident_case_members (case_id, member_type, member_id)
                VALUES ($1::uuid, $2, $3)
                ON CONFLICT DO NOTHING
                """,
                case_id,
                member_type,
                member_id,
            )
        payload = _normalize_record(dict(row))
        payload["members"] = [{"member_type": member_type, "member_id": member_id} for member_type, member_id in group["members"]]
        upserted.append(payload)
        if group["case_key"] not in existing:
            await publish_runtime_event(redis, {"type": "incident", **payload})
    return upserted


async def create_alerts_for_anomalies(conn, redis: Redis | None, anomalies: list[dict[str, Any]]) -> None:
    for anomaly in anomalies:
        severity = str(anomaly.get("severity") or "medium")
        if severity not in {"high", "critical"}:
            continue
        domain = str(anomaly["source_domain"])
        detector_key = str(anomaly["detector_key"])
        rule_name = f"System: {detector_key}"
        rule_id = await ensure_system_rule(conn, detector_key, rule_name, domain)
        anomaly_id = str(anomaly["id"])
        existing = await conn.fetchval(
            """
            SELECT id::text
            FROM alert_events
            WHERE rule_id = $1::uuid
              AND COALESCE(track_id, '') = COALESCE($2, '')
              AND status = 'open'
              AND COALESCE(payload->>'anomaly_id', '') = $3
            ORDER BY triggered_at DESC
            LIMIT 1
            """,
            rule_id,
            anomaly.get("track_id"),
            anomaly_id,
        )
        if existing:
            continue
        row = await conn.fetchrow(
            """
            INSERT INTO alert_events (rule_id, track_id, status, triggered_at, payload)
            VALUES ($1::uuid, $2, 'open', NOW(), $3::jsonb)
            RETURNING id::text, triggered_at
            """,
            rule_id,
            anomaly.get("track_id"),
            json.dumps(
                {
                    "severity": severity,
                    "anomaly_id": anomaly_id,
                    "title": anomaly.get("title"),
                    "bbox": anomaly.get("bbox"),
                    "confidence": anomaly.get("confidence"),
                    "metrics": anomaly.get("metrics"),
                }
            ),
        )
        if row is None:
            continue
        await publish_runtime_event(
            redis,
            {
                "type": "alert",
                "alert_id": str(row["id"]),
                "rule_id": rule_id,
                "rule_name": rule_name,
                "track_id": anomaly.get("track_id"),
                "domain": domain,
                "triggered_at": row["triggered_at"].isoformat() if row["triggered_at"] else None,
                "severity": severity,
                "title": anomaly.get("title"),
                "bbox": anomaly.get("bbox"),
                "anomaly_id": anomaly_id,
            },
        )


def _bbox_from_row(row: Any) -> dict[str, float] | None:
    data = dict(row)
    if data.get("west") is None or data.get("south") is None or data.get("east") is None or data.get("north") is None:
        return None
    return {
        "west": float(data["west"]),
        "south": float(data["south"]),
        "east": float(data["east"]),
        "north": float(data["north"]),
    }


def _merge_bbox_dicts(raw_boxes: list[Any]) -> dict[str, float]:
    boxes = [box for box in raw_boxes if isinstance(box, dict) and box]
    if not boxes:
        return {}
    return {
        "west": min(float(box["west"]) for box in boxes if "west" in box),
        "south": min(float(box["south"]) for box in boxes if "south" in box),
        "east": max(float(box["east"]) for box in boxes if "east" in box),
        "north": max(float(box["north"]) for box in boxes if "north" in box),
    }


def _max_severity(values: list[str]) -> str:
    if not values:
        return "medium"
    return max(values, key=lambda item: SEVERITY_RANK.get(item, 0))


def _normalize_record(record: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in record.items():
        if isinstance(value, datetime):
            normalized[key] = value.isoformat()
        else:
            normalized[key] = value
    return normalized

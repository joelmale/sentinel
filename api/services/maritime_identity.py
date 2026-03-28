from __future__ import annotations

from typing import Any

from services.marinetraffic import normalize_text


def _metadata_text(metadata: dict[str, Any] | None, *keys: str) -> str | None:
    if not isinstance(metadata, dict):
        return None
    for key in keys:
        value = metadata.get(key)
        text = normalize_text(value)
        if text:
            return text
    return None


def _nested_metadata_text(metadata: dict[str, Any] | None, paths: tuple[tuple[str, ...], ...]) -> str | None:
    if not isinstance(metadata, dict):
        return None
    for path in paths:
        cursor: Any = metadata
        for segment in path[:-1]:
            if not isinstance(cursor, dict):
                cursor = None
                break
            cursor = cursor.get(segment)
        text = _metadata_text(cursor, path[-1]) if isinstance(cursor, dict) else None
        if text:
            return text
    return None


def _is_identifier_like(value: str | None, *identifiers: str | None) -> bool:
    text = normalize_text(value)
    if not text:
        return False
    if text.isdigit():
        return True
    normalized = text.upper()
    return any(normalized == (candidate or "").strip().upper() for candidate in identifiers if candidate)


def resolve_maritime_identity(
    track_id: object,
    callsign: object,
    metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    track_id_text = normalize_text(track_id)
    mmsi = normalize_text(_metadata_text(metadata, "mmsi") or track_id_text)
    imo = normalize_text(_metadata_text(metadata, "imo") or _nested_metadata_text(metadata, (
        ("marinetraffic_summary", "imo"),
        ("marinetraffic_general", "imo"),
        ("marinetraffic_latest_ais", "imo"),
    )))
    ship_id = normalize_text(_metadata_text(metadata, "ship_id", "shipid") or _nested_metadata_text(metadata, (
        ("marinetraffic_summary", "shipid"),
        ("marinetraffic_general", "shipid"),
        ("marinetraffic_latest_ais", "shipid"),
    )))
    vessel_name = normalize_text(
        _metadata_text(metadata, "vessel_name", "ship_name", "name")
        or _nested_metadata_text(metadata, (
            ("marinetraffic_summary", "vessel_name"),
            ("marinetraffic_summary", "shipname"),
            ("marinetraffic_summary", "name"),
            ("marinetraffic_general", "vessel_name"),
            ("marinetraffic_general", "shipname"),
            ("marinetraffic_general", "name"),
            ("marinetraffic_latest_ais", "vessel_name"),
            ("marinetraffic_latest_ais", "shipname"),
            ("marinetraffic_latest_ais", "name"),
        ))
    )
    radio_callsign = normalize_text(
        _metadata_text(metadata, "radio_callsign", "callsign")
        or _nested_metadata_text(metadata, (
            ("marinetraffic_summary", "callsign"),
            ("marinetraffic_general", "callsign"),
            ("marinetraffic_latest_ais", "callsign"),
        ))
        or callsign
    )

    display_name_source = "track_id"
    display_name = track_id_text
    if vessel_name:
        display_name = vessel_name
        display_name_source = "vessel_name"
    elif radio_callsign and not _is_identifier_like(radio_callsign, track_id_text, mmsi, imo):
        display_name = radio_callsign
        display_name_source = "radio_callsign"

    identity_keys = [
        key
        for key in (
            f"imo:{imo}" if imo else None,
            f"mmsi:{mmsi}" if mmsi else None,
        )
        if key
    ]

    return {
        "display_name": display_name,
        "display_name_source": display_name_source,
        "primary_identity_key": identity_keys[0] if identity_keys else None,
        "identity_keys": identity_keys,
        "mmsi": mmsi,
        "imo": imo,
        "ship_id": ship_id,
        "vessel_name": vessel_name,
        "radio_callsign": radio_callsign,
        "ship_type": normalize_text(_metadata_text(metadata, "ship_type", "vessel_type")),
        "flag": normalize_text(_metadata_text(metadata, "flag")),
        "destination": normalize_text(_metadata_text(metadata, "destination")),
        "operator": normalize_text(_metadata_text(metadata, "operator")),
        "owner": normalize_text(_metadata_text(metadata, "owner")),
        "country_code": normalize_text(_metadata_text(metadata, "country_code")),
        "marinetraffic_status": normalize_text(_metadata_text(metadata, "marinetraffic_status")),
        "marinetraffic_url": normalize_text(_metadata_text(metadata, "marinetraffic_url")),
        "marinetraffic_fetched_at": normalize_text(_metadata_text(metadata, "marinetraffic_fetched_at")),
    }

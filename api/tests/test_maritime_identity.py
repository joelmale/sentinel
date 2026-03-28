from __future__ import annotations

from routers import tracks
from services.maritime_identity import resolve_maritime_identity


def test_resolve_maritime_identity_prefers_vessel_name_and_cache_keys() -> None:
    identity = resolve_maritime_identity(
        "367707930",
        None,
        {
            "mmsi": "367707930",
            "imo": "1234567",
            "marinetraffic_summary": {
                "vessel_name": "USNS EXAMPLE",
                "callsign": "NQAB",
            },
            "flag": "United States",
        },
    )

    assert identity["display_name"] == "USNS EXAMPLE"
    assert identity["display_name_source"] == "vessel_name"
    assert identity["primary_identity_key"] == "imo:1234567"
    assert identity["identity_keys"] == ["imo:1234567", "mmsi:367707930"]
    assert identity["radio_callsign"] == "NQAB"
    assert identity["flag"] == "United States"


def test_serialize_live_row_includes_normalized_maritime_identity() -> None:
    feature = tracks._serialize_live_row({
        "entity_id": "d4c5953d-5831-4b6e-b6ef-5f2d73693130",
        "source_domain": "Maritime",
        "source_feed": "AISStream",
        "track_id": "367707930",
        "callsign": None,
        "altitude_m": None,
        "heading_deg": 182.0,
        "speed_mps": 6.4,
        "last_seen": None,
        "classification": "Commercial",
        "first_seen": None,
        "source_trust_score": 0.9,
        "identity_confidence": 0.95,
        "state_confidence": 0.8,
        "winning_event_id": None,
        "provenance": {},
        "metadata": {
            "mmsi": "367707930",
            "marinetraffic_summary": {
                "vessel_name": "USNS EXAMPLE",
                "imo": "1234567",
            },
            "destination": "NORFOLK",
        },
        "lon": -76.3,
        "lat": 36.9,
    })

    properties = feature["properties"]

    assert properties["display_name"] == "USNS EXAMPLE"
    assert properties["callsign"] == "USNS EXAMPLE"
    assert properties["mmsi"] == "367707930"
    assert properties["imo"] == "1234567"
    assert properties["destination"] == "NORFOLK"
    assert properties["maritime_identity"]["primary_identity_key"] == "imo:1234567"

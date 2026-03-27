from __future__ import annotations

from routers import tracks


def test_summarize_browser_rows_uses_full_filtered_result_set() -> None:
    summary_rows = [
        {
            "source_domain": "Air",
            "source_feed": "opensky",
            "track_id": "RCH123",
            "callsign": "RCH123",
            "classification": "Military",
            "object_type": None,
        },
        {
            "source_domain": "Air",
            "source_feed": "opensky",
            "track_id": "DAL456",
            "callsign": "DAL456",
            "classification": "Commercial",
            "object_type": None,
        },
        {
            "source_domain": "Maritime",
            "source_feed": "aisstream",
            "track_id": "366123456",
            "callsign": None,
            "classification": "Commercial",
            "object_type": None,
        },
        {
            "source_domain": "Space",
            "source_feed": "spacetrack",
            "track_id": "25544",
            "callsign": "ISS (ZARYA)",
            "classification": "Government",
            "object_type": "PAYLOAD",
        },
    ]

    payload = tracks._summarize_browser_rows(summary_rows)

    assert payload["total"] == 4
    assert payload["facets"]["classifications"] == ["Commercial", "Government", "Military"]
    assert payload["facets"]["source_feeds"] == ["aisstream", "opensky", "spacetrack"]
    assert payload["facets"]["space_categories"] == ["Science"]
    assert payload["summaries"]["domains"] == [
        {"label": "Air", "count": 2},
        {"label": "Maritime", "count": 1},
        {"label": "Space", "count": 1},
    ]
    assert {"label": "🎖 Military", "count": 1} in payload["summaries"]["groups"]
    assert {"label": "MID 366", "count": 1} in payload["summaries"]["groups"]
    assert {"label": "ISS", "count": 1} in payload["summaries"]["groups"]


def test_browser_group_label_matches_domain_specific_rules() -> None:
    assert tracks._browser_group_label("Air", "RCH123", "RCH123", "Military", None) == "🎖 Military"
    assert tracks._browser_group_label("Maritime", "970123456", None, "Commercial", None) == "SAR Aircraft"
    assert tracks._browser_group_label("Space", "25544", "ISS (ZARYA)", "Government", "PAYLOAD") == "ISS"

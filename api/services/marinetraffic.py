from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html import unescape
from typing import Any
from urllib.parse import quote

import httpx


def parse_cookie_header(raw: str) -> dict[str, str]:
    cookies: dict[str, str] = {}
    for part in raw.split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key and value:
            cookies[key] = value
    return cookies


def normalize_text(value: object) -> str | None:
    if value in (None, "", [], {}):
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


def normalize_lookup_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def slug_vessel_name(value: object) -> str:
    text = normalize_text(value)
    if not text:
        return "UNKNOWN"
    return quote(text.upper())


def deep_find_first(payload: object, aliases: tuple[str, ...]) -> object:
    wanted = {normalize_lookup_key(alias) for alias in aliases}

    def walk(node: object) -> object:
        if isinstance(node, dict):
            for key, value in node.items():
                if normalize_lookup_key(str(key)) in wanted and value not in (None, "", [], {}):
                    return value
                nested = walk(value)
                if nested not in (None, "", [], {}):
                    return nested
        elif isinstance(node, list):
            for item in node:
                nested = walk(item)
                if nested not in (None, "", [], {}):
                    return nested
        return None

    return walk(payload)


@dataclass(frozen=True)
class MarineTrafficConfig:
    enabled: bool
    timeout_sec: float
    refresh_hours: int
    user_agent: str
    accept_language: str
    referer: str
    sec_ch_ua: str
    sec_ch_ua_platform: str
    cookie_header: str
    cookies: dict[str, str]
    base_url: str = "https://www.marinetraffic.com"

    @classmethod
    def from_env(cls) -> "MarineTrafficConfig":
        cookie_header = os.environ.get("MARINETRAFFIC_COOKIE_HEADER", "").strip()
        return cls(
            enabled=os.environ.get("MARINETRAFFIC_ENRICH_ENABLED", "false").strip().lower() in {"1", "true", "yes"},
            timeout_sec=float(os.environ.get("MARINETRAFFIC_TIMEOUT_SEC", "20")),
            refresh_hours=int(os.environ.get("MARINETRAFFIC_REFRESH_HOURS", "24")),
            user_agent=os.environ.get(
                "MARINETRAFFIC_USER_AGENT",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0",
            ).strip(),
            accept_language=os.environ.get("MARINETRAFFIC_ACCEPT_LANGUAGE", "en-US,en;q=0.9").strip(),
            referer=os.environ.get("MARINETRAFFIC_REFERER", "https://www.google.com/").strip(),
            sec_ch_ua=os.environ.get(
                "MARINETRAFFIC_SEC_CH_UA",
                '"Not:A-Brand";v="99", "Microsoft Edge";v="145", "Chromium";v="145"',
            ).strip(),
            sec_ch_ua_platform=os.environ.get("MARINETRAFFIC_SEC_CH_UA_PLATFORM", "macOS").strip(),
            cookie_header=cookie_header,
            cookies=parse_cookie_header(cookie_header),
        )

    def headers(self) -> dict[str, str]:
        return {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "accept-language": self.accept_language,
            "cache-control": "no-cache",
            "pragma": "no-cache",
            "referer": self.referer,
            "sec-ch-ua": self.sec_ch_ua,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": f'"{self.sec_ch_ua_platform}"',
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "cross-site",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
            "user-agent": self.user_agent,
        }

    @property
    def refresh_delta(self) -> timedelta:
        return timedelta(hours=max(self.refresh_hours, 1))


def detail_url(config: MarineTrafficConfig, metadata: dict[str, object]) -> str:
    mmsi = normalize_text(metadata.get("mmsi")) or "0"
    imo = normalize_text(metadata.get("imo")) or "0"
    vessel = slug_vessel_name(metadata.get("vessel_name") or metadata.get("ship_name") or metadata.get("name"))
    ship_id = normalize_text(metadata.get("shipid")) or normalize_text(metadata.get("ship_id"))
    ship_id_part = f"shipid:{ship_id}/" if ship_id else ""
    return (
        f"{config.base_url}/en/ais/details/ships/"
        f"{ship_id_part}mmsi:{mmsi}/imo:{imo}/vessel:{vessel}"
    )


def labels_from_html(html: str) -> dict[str, str]:
    cleaned = re.sub(r"(?is)<script.*?>.*?</script>", " ", html)
    cleaned = re.sub(r"(?is)<style.*?>.*?</style>", " ", cleaned)
    cleaned = unescape(re.sub(r"(?is)<[^>]+>", "\n", cleaned))
    lines = [normalize_text(line) for line in cleaned.splitlines()]
    lines = [line for line in lines if line]
    pairs: dict[str, str] = {}
    for index, line in enumerate(lines[:-1]):
        key = normalize_lookup_key(line)
        if not key or key in pairs:
            continue
        next_line = lines[index + 1]
        if next_line and normalize_lookup_key(next_line) != key:
            pairs[key] = next_line
    return pairs


def script_objects(html: str) -> list[object]:
    payloads: list[object] = []
    for raw in re.findall(r"(?is)<script[^>]*>(.*?)</script>", html):
        text = raw.strip()
        if not text:
            continue
        candidates = [text]
        next_data_match = re.search(r"__NEXT_DATA__\s*=\s*({.*?})\s*;?\s*$", text, re.S)
        if next_data_match:
            candidates.append(next_data_match.group(1))
        for candidate in candidates:
            if not candidate.startswith(("{", "[")):
                continue
            try:
                payloads.append(json.loads(candidate))
            except Exception:
                continue
    return payloads


def image_from_html(html: str, scripts: list[object]) -> str | None:
    meta_patterns = [
        r'(?is)<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
        r'(?is)<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']',
    ]
    for pattern in meta_patterns:
        match = re.search(pattern, html)
        if match:
            return normalize_text(unescape(match.group(1)))
    for payload in scripts:
        value = deep_find_first(payload, ("image", "imageurl", "image_url", "photo", "photo_url"))
        text = normalize_text(value)
        if text and text.startswith("http"):
            return text
    return None


def extract_payload(html: str, url: str) -> dict[str, object]:
    labels = labels_from_html(html)
    scripts = script_objects(html)

    def from_sources(*aliases: str) -> str | None:
        for alias in aliases:
            value = labels.get(normalize_lookup_key(alias))
            if value:
                return value
        for payload in scripts:
            value = deep_find_first(payload, aliases)
            text = normalize_text(value)
            if text:
                return text
        return None

    summary = {
        "vessel_name": from_sources("vesselname", "name", "shipname"),
        "mmsi": from_sources("mmsi"),
        "imo": from_sources("imo", "imonumber"),
        "callsign": from_sources("callsign", "call sign"),
        "flag": from_sources("flag"),
        "ship_type": from_sources("shiptype", "ship type", "vesseltype", "vessel type"),
        "destination": from_sources("destination"),
        "navigational_status": from_sources("navigationalstatus", "navigational status", "navstatus", "status"),
    }
    general = {
        "owner": from_sources("registeredowner", "owner"),
        "operator": from_sources("commercialmanager", "manager", "operator"),
        "builder": from_sources("shipbuilder", "builder"),
        "year_built": from_sources("yearbuilt", "year built"),
        "length": from_sources("length"),
        "beam": from_sources("beam", "breadth", "width"),
        "gross_tonnage": from_sources("gross tonnage", "gross_tonnage", "gt"),
        "deadweight": from_sources("deadweight", "dwt"),
        "draught": from_sources("draught", "draft"),
    }
    latest_ais = {
        "position_received_at": from_sources("positionreceived", "lastreport", "position report"),
        "speed": from_sources("speed", "speed/course", "speed over ground"),
        "course": from_sources("course", "course over ground"),
        "heading": from_sources("heading"),
        "latitude": from_sources("latitude", "lat"),
        "longitude": from_sources("longitude", "lon", "lng"),
        "ais_source": from_sources("aissource", "ais source"),
    }
    summary = {key: value for key, value in summary.items() if value}
    general = {key: value for key, value in general.items() if value}
    latest_ais = {key: value for key, value in latest_ais.items() if value}
    image_url = image_from_html(html, scripts)
    if not summary and not general and not latest_ais and not image_url:
        return {}

    return {
        "marinetraffic_url": url,
        "marinetraffic_fetched_at": datetime.now(timezone.utc).isoformat(),
        "marinetraffic_image_url": image_url,
        "marinetraffic_summary": summary,
        "marinetraffic_general": general,
        "marinetraffic_latest_ais": latest_ais,
        "flag": summary.get("flag"),
        "ship_type": summary.get("ship_type"),
        "destination": summary.get("destination"),
        "owner": general.get("owner"),
        "operator": general.get("operator"),
        "country_code": summary.get("flag"),
        "platform_type": summary.get("ship_type"),
    }


async def fetch_marinetraffic_payload(
    metadata: dict[str, object],
    *,
    config: MarineTrafficConfig | None = None,
) -> dict[str, object] | None:
    cfg = config or MarineTrafficConfig.from_env()
    if not cfg.enabled:
        return None

    url = detail_url(cfg, metadata)
    async with httpx.AsyncClient(
        headers=cfg.headers(),
        cookies=cfg.cookies,
        timeout=cfg.timeout_sec,
    ) as client:
        response = await client.get(url, follow_redirects=True)
        if response.status_code == 403:
            return {"marinetraffic_url": str(response.url), "marinetraffic_status": "blocked"}
        response.raise_for_status()
        payload = extract_payload(response.text, str(response.url))
        if not payload:
            return {"marinetraffic_url": str(response.url), "marinetraffic_status": "unavailable"}
        payload["marinetraffic_status"] = "fresh"
        return payload

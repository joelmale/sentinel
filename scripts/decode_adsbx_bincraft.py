#!/usr/bin/env python3
"""Decode ADS-B Exchange style binary aircraft payloads.

The format is based on the frontend `wqi(...)` parser the user provided:
- file header starts at byte 0
- `stride` bytes per aircraft record
- aircraft records begin at byte offset `stride`

This script can read a local file or fetch a payload from a URL, then print
the first N decoded aircraft objects as JSON.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import urllib.request
from pathlib import Path
from typing import Any


def _u8(buf: bytes, offset: int) -> int:
    return buf[offset]


def _u16(buf: bytes, offset: int) -> int:
    return struct.unpack_from("<H", buf, offset)[0]


def _s16(buf: bytes, offset: int) -> int:
    return struct.unpack_from("<h", buf, offset)[0]


def _u32(buf: bytes, offset: int) -> int:
    return struct.unpack_from("<I", buf, offset)[0]


def _s32(buf: bytes, offset: int) -> int:
    return struct.unpack_from("<i", buf, offset)[0]


def _decode_callsign(buf: bytes, offset: int, end: int) -> str | None:
    chars: list[str] = []
    for idx in range(offset, end):
        value = buf[idx]
        if value == 0:
            break
        chars.append(chr(value))
    callsign = "".join(chars).strip()
    return callsign or None


def _decode_type_code(raw_type: int) -> str:
    mapping = {
        0: "adsb_icao",
        1: "adsb_icao_nt",
        2: "adsr_icao",
        3: "tisb_icao",
        4: "adsc",
        5: "mlat",
        6: "other",
        7: "mode_s",
        8: "adsb_other",
        9: "adsr_other",
        10: "tisb_trackfile",
        11: "tisb_other",
        12: "mode_ac",
    }
    return mapping.get(raw_type, "unknown")


def _maybe(value: Any, present: bool) -> Any | None:
    return value if present else None


def decode_aircraft_payload(payload: bytes) -> dict[str, Any]:
    if len(payload) < 48:
        raise ValueError("payload too short to contain header")

    stride = _u32(payload, 8)
    if stride <= 0:
        raise ValueError(f"invalid stride: {stride}")
    if len(payload) < stride:
        raise ValueError("payload shorter than stride")

    header_u32_0 = _u32(payload, 0)
    header_u32_1 = _u32(payload, 4)
    timestamp = header_u32_0 / 1000 + 4294967.296 * header_u32_1
    global_ac_count_withpos = _u32(payload, 12)
    globe_index = _u32(payload, 16)
    south = _s16(payload, 20)
    west = _s16(payload, 22)
    north = _s16(payload, 24)
    east = _s16(payload, 26)
    messages = _u32(payload, 28)
    message_rate = _u32(payload, 44) / 10
    use_message_rate = bool(_u32(payload, 48) & 1) if len(payload) >= 52 else False
    bincraft_version = _u32(payload, 40)

    aircraft: list[dict[str, Any]] = []
    for record_offset in range(stride, len(payload), stride):
        record = payload[record_offset:record_offset + stride]
        if len(record) < stride:
            break

        raw_hex = _s32(record, 0)
        non_icao = bool(raw_hex & (1 << 24))
        hex_code = f"{raw_hex & 0xFFFFFF:06x}"
        if non_icao:
            hex_code = f"~{hex_code}"

        if bincraft_version >= 20240218:
            seen = _s32(record, 4) / 10
            seen_pos = _s32(record, 108) / 10
        else:
            seen_pos = _u16(record, 4) / 10
            seen = _u16(record, 6) / 10

        ac: dict[str, Any] = {
            "hex": hex_code,
            "seen": seen,
            "seen_pos": seen_pos,
            "lon": _s32(record, 8) / 1e6,
            "lat": _s32(record, 12) / 1e6,
            "baro_rate": 8 * _s16(record, 16),
            "geom_rate": 8 * _s16(record, 18),
            "alt_baro": 25 * _s16(record, 20),
            "alt_geom": 25 * _s16(record, 22),
            "nav_altitude_mcp": 4 * _u16(record, 24),
            "nav_altitude_fms": 4 * _u16(record, 26),
            "nav_qnh": _s16(record, 28) / 10,
            "nav_heading": _s16(record, 30) / 90,
            "squawk": f"{_u16(record, 32):04x}",
            "gs": _s16(record, 34) / 10,
            "mach": _s16(record, 36) / 1000,
            "roll": _s16(record, 38) / 100,
            "track": _s16(record, 40) / 90,
            "track_rate": _s16(record, 42) / 100,
            "mag_heading": _s16(record, 44) / 90,
            "true_heading": _s16(record, 46) / 90,
            "wd": _s16(record, 48),
            "ws": _s16(record, 50),
            "oat": _s16(record, 52),
            "tat": _s16(record, 54),
            "tas": _u16(record, 56),
            "ias": _u16(record, 58),
            "rc": _u16(record, 60),
            "category": f"{_u8(record, 64):X}" if _u8(record, 64) else None,
            "nic": _u8(record, 65),
        }

        nav_modes = _u8(record, 66)
        flags67 = _u8(record, 67)
        flags68 = _u8(record, 68)
        flags69 = _u8(record, 69)
        flags70 = _u8(record, 70)
        flags71 = _u8(record, 71)
        flags72 = _u8(record, 72)
        flags73 = _u8(record, 73)
        flags74 = _u8(record, 74)
        flags75 = _u8(record, 75)
        flags76 = _u8(record, 76)
        flags77 = _u8(record, 77)

        ac["emergency"] = flags67 & 0x0F
        raw_type = (flags67 & 0xF0) >> 4
        ac["type"] = _decode_type_code(raw_type)
        ac["airground"] = flags68 & 0x0F
        ac["nav_altitude_src"] = (flags68 & 0xF0) >> 4
        ac["sil_type"] = flags69 & 0x0F
        ac["adsb_version"] = (flags69 & 0xF0) >> 4
        ac["adsr_version"] = flags70 & 0x0F
        ac["tisb_version"] = (flags70 & 0xF0) >> 4
        ac["nac_p"] = flags71 & 0x0F
        ac["nac_v"] = (flags71 & 0xF0) >> 4
        ac["sil"] = flags72 & 0x03
        ac["gva"] = (flags72 & 0x0C) >> 2
        ac["sda"] = (flags72 & 0x30) >> 4
        ac["nic_a"] = bool(flags72 & 0x40)
        ac["nic_c"] = bool(flags72 & 0x80)
        ac["flight"] = _decode_callsign(record, 78, 86)
        ac["dbFlags"] = _u16(record, 86)
        ac["t"] = _decode_callsign(record, 88, 92)
        ac["r"] = _decode_callsign(record, 92, 104)
        ac["receiverCount"] = _u8(record, 104)
        if bincraft_version >= 20250403:
            ac["rssi"] = _u8(record, 105) * (50 / 255) - 50
        else:
            level = _u8(record, 105) * _u8(record, 105) / 65025 + 1125e-8
            ac["rssi"] = 10 * __import__("math").log10(level)
        ac["extraFlags"] = _u8(record, 106)
        ac["nogps"] = bool(ac["extraFlags"] & 1)

        if flags77 & 0x04:
            modes: list[str] = []
            if nav_modes & 1:
                modes.append("autopilot")
            if nav_modes & 2:
                modes.append("vnav")
            if nav_modes & 4:
                modes.append("alt_hold")
            if nav_modes & 8:
                modes.append("approach")
            if nav_modes & 16:
                modes.append("lnav")
            if nav_modes & 32:
                modes.append("tcas")
            ac["nav_modes"] = modes
        else:
            ac["nav_modes"] = None

        if ac["airground"] == 1 and (flags73 & 16):
            ac["alt_baro"] = "ground"

        ac["flight"] = _maybe(ac["flight"], bool(flags73 & 0x08))
        ac["alt_baro"] = _maybe(ac["alt_baro"], bool(flags73 & 0x10))
        ac["alt_geom"] = _maybe(ac["alt_geom"], bool(flags73 & 0x20))
        ac["lat"] = _maybe(ac["lat"], bool(flags73 & 0x40))
        ac["lon"] = _maybe(ac["lon"], bool(flags73 & 0x40))
        ac["seen_pos"] = _maybe(ac["seen_pos"], bool(flags73 & 0x40))
        ac["gs"] = _maybe(ac["gs"], bool(flags73 & 0x80))
        ac["ias"] = _maybe(ac["ias"], bool(flags74 & 0x01))
        ac["tas"] = _maybe(ac["tas"], bool(flags74 & 0x02))
        ac["mach"] = _maybe(ac["mach"], bool(flags74 & 0x04))
        ac["track"] = _maybe(ac["track"], bool(flags74 & 0x08))
        ac["calc_track"] = None if (flags74 & 0x08) else ac["track"]
        ac["track_rate"] = _maybe(ac["track_rate"], bool(flags74 & 0x10))
        ac["roll"] = _maybe(ac["roll"], bool(flags74 & 0x20))
        ac["mag_heading"] = _maybe(ac["mag_heading"], bool(flags74 & 0x40))
        ac["true_heading"] = _maybe(ac["true_heading"], bool(flags74 & 0x80))
        ac["baro_rate"] = _maybe(ac["baro_rate"], bool(flags75 & 0x01))
        ac["geom_rate"] = _maybe(ac["geom_rate"], bool(flags75 & 0x02))
        ac["nic_a"] = _maybe(ac["nic_a"], bool(flags75 & 0x04))
        ac["nic_c"] = _maybe(ac["nic_c"], bool(flags75 & 0x08))
        ac["nic_baro"] = _maybe(bool(flags73 & 0x01), bool(flags75 & 0x10))
        ac["nac_p"] = _maybe(ac["nac_p"], bool(flags75 & 0x20))
        ac["nac_v"] = _maybe(ac["nac_v"], bool(flags75 & 0x40))
        ac["sil"] = _maybe(ac["sil"], bool(flags75 & 0x80))
        ac["gva"] = _maybe(ac["gva"], bool(flags76 & 0x01))
        ac["sda"] = _maybe(ac["sda"], bool(flags76 & 0x02))
        ac["squawk"] = _maybe(ac["squawk"], bool(flags76 & 0x04))
        ac["emergency"] = _maybe(ac["emergency"], bool(flags76 & 0x08))
        ac["spi"] = _maybe(bool(flags73 & 0x04), bool(flags76 & 0x10))
        ac["nav_qnh"] = _maybe(ac["nav_qnh"], bool(flags76 & 0x20))
        ac["nav_altitude_mcp"] = _maybe(ac["nav_altitude_mcp"], bool(flags76 & 0x40))
        ac["nav_altitude_fms"] = _maybe(ac["nav_altitude_fms"], bool(flags76 & 0x80))
        ac["nav_altitude_src"] = _maybe(ac["nav_altitude_src"], bool(flags77 & 0x01))
        ac["nav_heading"] = _maybe(ac["nav_heading"], bool(flags77 & 0x02))
        ac["alert1"] = _maybe(bool(flags73 & 0x02), bool(flags77 & 0x08))
        ac["ws"] = _maybe(ac["ws"], bool(flags77 & 0x10))
        ac["wd"] = _maybe(ac["wd"], bool(flags77 & 0x10))
        ac["oat"] = _maybe(ac["oat"], bool(flags77 & 0x20))
        ac["tat"] = _maybe(ac["tat"], bool(flags77 & 0x20))

        if use_message_rate:
            ac["messageRate"] = _u16(record, 62) / 10
        else:
            ac["messages"] = _u16(record, 62)

        if bincraft_version >= 20240218 and stride >= 116:
            ac["rId"] = f"{_u32(record, 112):08x}"
        elif stride >= 112:
            ac["rId"] = f"{_u32(record, 108):08x}"

        aircraft.append(ac)

    return {
        "header": {
            "timestamp": timestamp,
            "stride": stride,
            "global_ac_count_withpos": global_ac_count_withpos,
            "globe_index": globe_index,
            "bounds": {
                "south": south,
                "west": west,
                "north": north,
                "east": east,
            },
            "messages": messages,
            "message_rate": message_rate,
            "use_message_rate": use_message_rate,
            "bincraft_version": bincraft_version,
        },
        "aircraft": aircraft,
    }


def fetch_url(url: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "sentinel-bincraft-decoder/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--file", type=Path, help="Local binary payload file")
    group.add_argument("--url", help="URL to fetch binary payload from")
    parser.add_argument("--limit", type=int, default=5, help="How many aircraft objects to print")
    parser.add_argument("--timeout", type=float, default=15.0, help="Fetch timeout in seconds")
    args = parser.parse_args()

    if args.file:
        payload = args.file.read_bytes()
    else:
        payload = fetch_url(args.url, args.timeout)

    decoded = decode_aircraft_payload(payload)
    print(json.dumps({
        "header": decoded["header"],
        "aircraft": decoded["aircraft"][:args.limit],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

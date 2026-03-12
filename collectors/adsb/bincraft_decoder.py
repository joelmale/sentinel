"""
ADS-B Exchange binCraft binary payload decoder.

Pure decoding functions — no I/O, no HTTP, no CLI.  Imported by collector.py.

The binCraft format is a fixed-stride binary layout used by ADS-B Exchange's
globe.adsbexchange.com endpoint (?binCraft).  Think of each aircraft record as
a packed C struct: every field lives at a fixed byte offset within a record of
exactly `stride` bytes, where `stride` is itself encoded in the file header.

Binary layout overview:

  File header (first `stride` bytes):
    offset  0 : u32  — low 32 bits of server epoch (ms)
    offset  4 : u32  — high 32 bits (together: ms since some reference epoch)
    offset  8 : u32  — stride (bytes per record, including this header)
    offset 12 : u32  — global_ac_count_withpos
    offset 16 : u32  — globe_index
    offset 20 : s16  — south bound (degrees)
    offset 22 : s16  — west  bound
    offset 24 : s16  — north bound
    offset 26 : s16  — east  bound
    offset 28 : u32  — messages
    offset 40 : u32  — bincraft_version (yyyymmdd integer, e.g. 20240218)
    offset 44 : u32  — message_rate × 10
    offset 48 : u32  — flags (bit 0 = use_message_rate)

  Aircraft records (stride bytes each, starting at offset=stride):
    offset  0 : s32  — ICAO hex packed as 24-bit int; bit 24 = non-ICAO flag
    offset  4 : s32/u16 — seen × 10  (format depends on bincraft_version)
    offset  8 : s32  — longitude × 1e6
    offset 12 : s32  — latitude  × 1e6
    offset 16 : s16  — baro_rate × 8  (ft/min)
    offset 18 : s16  — geom_rate × 8
    offset 20 : s16  — alt_baro  × 25 (ft)
    offset 22 : s16  — alt_geom  × 25
    offset 24 : u16  — nav_altitude_mcp × 4
    offset 26 : u16  — nav_altitude_fms × 4
    offset 28 : s16  — nav_qnh  × 10 (hPa)
    offset 30 : s16  — nav_heading ÷ 90 (degrees)
    offset 32 : u16  — squawk (packed BCD)
    offset 34 : s16  — ground speed × 10 (kt)
    offset 36 : s16  — mach × 1000
    offset 38 : s16  — roll × 100 (deg)
    offset 40 : s16  — track ÷ 90 (degrees)
    offset 42 : s16  — track_rate × 100
    offset 44 : s16  — mag_heading ÷ 90
    offset 46 : s16  — true_heading ÷ 90
    offset 48 : s16  — wind direction
    offset 50 : s16  — wind speed
    offset 52 : s16  — OAT (°C)
    offset 54 : s16  — TAT (°C)
    offset 56 : u16  — TAS (kt)
    offset 58 : u16  — IAS (kt)
    offset 60 : u16  — rc (radius of containment, m)
    offset 62 : u16  — messages or messageRate × 10 (depends on use_message_rate)
    offset 64 : u8   — category (hex char)
    offset 65 : u8   — NIC
    offset 66 : u8   — nav_modes bitmask
    offset 67 : u8   — emergency (low nibble) | raw_type (high nibble)
    offset 68 : u8   — airground (low) | nav_altitude_src (high)
    offset 69 : u8   — sil_type (low) | adsb_version (high)
    offset 70 : u8   — adsr_version (low) | tisb_version (high)
    offset 71 : u8   — nac_p (low) | nac_v (high)
    offset 72 : u8   — sil(2) | gva(2) | sda(2) | nic_a | nic_c
    offset 73–77 : u8 ×5 — field presence bitmasks
    offset 78–85 : char×8 — flight (callsign, null-terminated)
    offset 86 : u16  — dbFlags  (bit 1 = military)
    offset 88–91 : char×4 — aircraft type code (t)
    offset 92–103: char×12 — registration (r)
    offset 104 : u8  — receiverCount
    offset 105 : u8  — RSSI (encoding depends on bincraft_version)
    offset 106 : u8  — extraFlags (bit 0 = nogps)
    offset 108 : s32 — seen_pos × 10 (version < 20240218 only, u16)
    offset 112 : u32 — rId  (version >= 20240218)
"""

from __future__ import annotations

import struct
from typing import Any


# ─── Low-level struct helpers ──────────────────────────────────────────────────

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


# ─── Field decoders ────────────────────────────────────────────────────────────

def _decode_callsign(buf: bytes, offset: int, end: int) -> str | None:
    """Read a null-terminated ASCII string from buf[offset:end], strip spaces."""
    chars: list[str] = []
    for idx in range(offset, end):
        value = buf[idx]
        if value == 0:
            break
        chars.append(chr(value))
    callsign = "".join(chars).strip()
    return callsign or None


def _decode_type_code(raw_type: int) -> str:
    """Map the 4-bit surveillance type nibble to a human-readable string."""
    mapping = {
        0:  "adsb_icao",
        1:  "adsb_icao_nt",
        2:  "adsr_icao",
        3:  "tisb_icao",
        4:  "adsc",
        5:  "mlat",
        6:  "other",
        7:  "mode_s",
        8:  "adsb_other",
        9:  "adsr_other",
        10: "tisb_trackfile",
        11: "tisb_other",
        12: "mode_ac",
    }
    return mapping.get(raw_type, "unknown")


def _maybe(value: Any, present: bool) -> Any | None:
    """Return value only if the field-present flag is set; otherwise None."""
    return value if present else None


# ─── Main decoder ─────────────────────────────────────────────────────────────

def decode_aircraft_payload(payload: bytes) -> dict[str, Any]:
    """
    Decode a raw (already decompressed) binCraft binary payload.

    Parameters
    ----------
    payload : bytes
        Raw bytes from the ADS-B Exchange globe endpoint (?binCraft).
        Must be decompressed before calling this — the API returns
        Zstandard-compressed data when &zstd is appended to the URL.

    Returns
    -------
    dict with keys:
        "header"   : dict of file-level metadata
        "aircraft" : list of per-aircraft dicts (may be empty)

    Each aircraft dict contains every decoded field.  Fields guarded by a
    presence bit are set to None when the bit is clear (the _maybe() pattern
    mirrors the original JS wqi() parser: "field is absent, not zero").
    """
    if len(payload) < 48:
        raise ValueError("payload too short to contain header")

    stride = _u32(payload, 8)
    if stride <= 0:
        raise ValueError(f"invalid stride: {stride}")
    if len(payload) < stride:
        raise ValueError("payload shorter than stride")

    # Header fields
    header_u32_0 = _u32(payload, 0)
    header_u32_1 = _u32(payload, 4)
    timestamp = header_u32_0 / 1000 + 4294967.296 * header_u32_1
    global_ac_count_withpos = _u32(payload, 12)
    globe_index              = _u32(payload, 16)
    south                    = _s16(payload, 20)
    west                     = _s16(payload, 22)
    north                    = _s16(payload, 24)
    east                     = _s16(payload, 26)
    messages                 = _u32(payload, 28)
    bincraft_version         = _u32(payload, 40)
    message_rate             = _u32(payload, 44) / 10
    use_message_rate         = bool(_u32(payload, 48) & 1) if len(payload) >= 52 else False

    import math  # local import keeps module-level namespace clean

    aircraft: list[dict[str, Any]] = []

    for record_offset in range(stride, len(payload), stride):
        record = payload[record_offset : record_offset + stride]
        if len(record) < stride:
            break

        # ICAO hex: bit 24 signals a non-ICAO (pseudo) address
        raw_hex  = _s32(record, 0)
        non_icao = bool(raw_hex & (1 << 24))
        hex_code = f"{raw_hex & 0xFFFFFF:06x}"
        if non_icao:
            hex_code = f"~{hex_code}"

        # seen / seen_pos encoding changed in v20240218
        if bincraft_version >= 20240218:
            seen     = _s32(record, 4) / 10
            seen_pos = _s32(record, 108) / 10
        else:
            seen_pos = _u16(record, 4) / 10
            seen     = _u16(record, 6) / 10

        ac: dict[str, Any] = {
            "hex":              hex_code,
            "seen":             seen,
            "seen_pos":         seen_pos,
            "lon":              _s32(record, 8)  / 1e6,
            "lat":              _s32(record, 12) / 1e6,
            "baro_rate":        8 * _s16(record, 16),
            "geom_rate":        8 * _s16(record, 18),
            "alt_baro":         25 * _s16(record, 20),
            "alt_geom":         25 * _s16(record, 22),
            "nav_altitude_mcp": 4  * _u16(record, 24),
            "nav_altitude_fms": 4  * _u16(record, 26),
            "nav_qnh":          _s16(record, 28) / 10,
            "nav_heading":      _s16(record, 30) / 90,
            "squawk":           f"{_u16(record, 32):04x}",
            "gs":               _s16(record, 34) / 10,
            "mach":             _s16(record, 36) / 1000,
            "roll":             _s16(record, 38) / 100,
            "track":            _s16(record, 40) / 90,
            "track_rate":       _s16(record, 42) / 100,
            "mag_heading":      _s16(record, 44) / 90,
            "true_heading":     _s16(record, 46) / 90,
            "wd":               _s16(record, 48),
            "ws":               _s16(record, 50),
            "oat":              _s16(record, 52),
            "tat":              _s16(record, 54),
            "tas":              _u16(record, 56),
            "ias":              _u16(record, 58),
            "rc":               _u16(record, 60),
            "category":         f"{_u8(record, 64):X}" if _u8(record, 64) else None,
            "nic":              _u8(record, 65),
        }

        # Flag bytes 66–77 — each byte is a bitmask
        nav_modes = _u8(record, 66)
        flags67   = _u8(record, 67)
        flags68   = _u8(record, 68)
        flags69   = _u8(record, 69)
        flags70   = _u8(record, 70)
        flags71   = _u8(record, 71)
        flags72   = _u8(record, 72)
        flags73   = _u8(record, 73)
        flags74   = _u8(record, 74)
        flags75   = _u8(record, 75)
        flags76   = _u8(record, 76)
        flags77   = _u8(record, 77)

        # Packed nibbles in flags 67–72
        ac["emergency"]        = flags67 & 0x0F
        raw_type               = (flags67 & 0xF0) >> 4
        ac["type"]             = _decode_type_code(raw_type)
        ac["airground"]        = flags68 & 0x0F
        ac["nav_altitude_src"] = (flags68 & 0xF0) >> 4
        ac["sil_type"]         = flags69 & 0x0F
        ac["adsb_version"]     = (flags69 & 0xF0) >> 4
        ac["adsr_version"]     = flags70 & 0x0F
        ac["tisb_version"]     = (flags70 & 0xF0) >> 4
        ac["nac_p"]            = flags71 & 0x0F
        ac["nac_v"]            = (flags71 & 0xF0) >> 4
        ac["sil"]              = flags72 & 0x03
        ac["gva"]              = (flags72 & 0x0C) >> 2
        ac["sda"]              = (flags72 & 0x30) >> 4
        ac["nic_a"]            = bool(flags72 & 0x40)
        ac["nic_c"]            = bool(flags72 & 0x80)

        # String fields
        ac["flight"]   = _decode_callsign(record, 78, 86)
        ac["dbFlags"]  = _u16(record, 86)
        ac["t"]        = _decode_callsign(record, 88, 92)
        ac["r"]        = _decode_callsign(record, 92, 104)
        ac["receiverCount"] = _u8(record, 104)

        # RSSI encoding changed in v20250403
        if bincraft_version >= 20250403:
            ac["rssi"] = _u8(record, 105) * (50 / 255) - 50
        else:
            level = _u8(record, 105) * _u8(record, 105) / 65025 + 1125e-8
            ac["rssi"] = 10 * math.log10(level)

        ac["extraFlags"] = _u8(record, 106)
        ac["nogps"]      = bool(ac["extraFlags"] & 1)

        # nav_modes expansion (present only when flags77 bit 2 is set)
        if flags77 & 0x04:
            modes: list[str] = []
            if nav_modes & 1:  modes.append("autopilot")
            if nav_modes & 2:  modes.append("vnav")
            if nav_modes & 4:  modes.append("alt_hold")
            if nav_modes & 8:  modes.append("approach")
            if nav_modes & 16: modes.append("lnav")
            if nav_modes & 32: modes.append("tcas")
            ac["nav_modes"] = modes
        else:
            ac["nav_modes"] = None

        # Ground state overrides baro altitude
        if ac["airground"] == 1 and (flags73 & 16):
            ac["alt_baro"] = "ground"

        # Apply field-presence bitmasks — fields absent in the transmission
        # are set to None rather than their default computed values.
        # flags73 controls: flight, alt_baro, alt_geom, position, gs
        ac["flight"]    = _maybe(ac["flight"],    bool(flags73 & 0x08))
        ac["alt_baro"]  = _maybe(ac["alt_baro"],  bool(flags73 & 0x10))
        ac["alt_geom"]  = _maybe(ac["alt_geom"],  bool(flags73 & 0x20))
        ac["lat"]       = _maybe(ac["lat"],        bool(flags73 & 0x40))
        ac["lon"]       = _maybe(ac["lon"],        bool(flags73 & 0x40))
        ac["seen_pos"]  = _maybe(ac["seen_pos"],   bool(flags73 & 0x40))
        ac["gs"]        = _maybe(ac["gs"],         bool(flags73 & 0x80))
        # flags74: ias, tas, mach, track, track_rate, roll, mag_heading, true_heading
        ac["ias"]          = _maybe(ac["ias"],          bool(flags74 & 0x01))
        ac["tas"]          = _maybe(ac["tas"],          bool(flags74 & 0x02))
        ac["mach"]         = _maybe(ac["mach"],         bool(flags74 & 0x04))
        ac["track"]        = _maybe(ac["track"],        bool(flags74 & 0x08))
        ac["calc_track"]   = None if (flags74 & 0x08) else ac["track"]
        ac["track_rate"]   = _maybe(ac["track_rate"],   bool(flags74 & 0x10))
        ac["roll"]         = _maybe(ac["roll"],          bool(flags74 & 0x20))
        ac["mag_heading"]  = _maybe(ac["mag_heading"],  bool(flags74 & 0x40))
        ac["true_heading"] = _maybe(ac["true_heading"], bool(flags74 & 0x80))
        # flags75: baro_rate, geom_rate, nic_a, nic_c, nic_baro, nac_p, nac_v, sil
        ac["baro_rate"] = _maybe(ac["baro_rate"], bool(flags75 & 0x01))
        ac["geom_rate"] = _maybe(ac["geom_rate"], bool(flags75 & 0x02))
        ac["nic_a"]     = _maybe(ac["nic_a"],     bool(flags75 & 0x04))
        ac["nic_c"]     = _maybe(ac["nic_c"],     bool(flags75 & 0x08))
        ac["nic_baro"]  = _maybe(bool(flags73 & 0x01), bool(flags75 & 0x10))
        ac["nac_p"]     = _maybe(ac["nac_p"],     bool(flags75 & 0x20))
        ac["nac_v"]     = _maybe(ac["nac_v"],     bool(flags75 & 0x40))
        ac["sil"]       = _maybe(ac["sil"],       bool(flags75 & 0x80))
        # flags76: gva, sda, squawk, emergency, spi, nav_qnh, nav_altitude_mcp/fms
        ac["gva"]              = _maybe(ac["gva"],              bool(flags76 & 0x01))
        ac["sda"]              = _maybe(ac["sda"],              bool(flags76 & 0x02))
        ac["squawk"]           = _maybe(ac["squawk"],           bool(flags76 & 0x04))
        ac["emergency"]        = _maybe(ac["emergency"],        bool(flags76 & 0x08))
        ac["spi"]              = _maybe(bool(flags73 & 0x04),   bool(flags76 & 0x10))
        ac["nav_qnh"]          = _maybe(ac["nav_qnh"],          bool(flags76 & 0x20))
        ac["nav_altitude_mcp"] = _maybe(ac["nav_altitude_mcp"], bool(flags76 & 0x40))
        ac["nav_altitude_fms"] = _maybe(ac["nav_altitude_fms"], bool(flags76 & 0x80))
        # flags77: nav_altitude_src, nav_heading, nav_modes, alert1, ws/wd, oat/tat
        ac["nav_altitude_src"] = _maybe(ac["nav_altitude_src"], bool(flags77 & 0x01))
        ac["nav_heading"]      = _maybe(ac["nav_heading"],      bool(flags77 & 0x02))
        ac["alert1"]           = _maybe(bool(flags73 & 0x02),   bool(flags77 & 0x08))
        ac["ws"]               = _maybe(ac["ws"],               bool(flags77 & 0x10))
        ac["wd"]               = _maybe(ac["wd"],               bool(flags77 & 0x10))
        ac["oat"]              = _maybe(ac["oat"],              bool(flags77 & 0x20))
        ac["tat"]              = _maybe(ac["tat"],              bool(flags77 & 0x20))

        # messages vs messageRate (controlled by use_message_rate flag in header)
        if use_message_rate:
            ac["messageRate"] = _u16(record, 62) / 10
        else:
            ac["messages"] = _u16(record, 62)

        # Receiver ID (rId) — offset differs between versions
        if bincraft_version >= 20240218 and stride >= 116:
            ac["rId"] = f"{_u32(record, 112):08x}"
        elif stride >= 112:
            ac["rId"] = f"{_u32(record, 108):08x}"

        aircraft.append(ac)

    return {
        "header": {
            "timestamp":                timestamp,
            "stride":                   stride,
            "global_ac_count_withpos":  global_ac_count_withpos,
            "globe_index":              globe_index,
            "bounds": {
                "south": south,
                "west":  west,
                "north": north,
                "east":  east,
            },
            "messages":         messages,
            "message_rate":     message_rate,
            "use_message_rate": use_message_rate,
            "bincraft_version": bincraft_version,
        },
        "aircraft": aircraft,
    }

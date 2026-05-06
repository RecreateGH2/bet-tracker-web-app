"""
Parse horse.rtf to build a lookup table: horse_name (Traditional Chinese) → horse_code.

The RTF file uses Big5 encoding for Chinese characters, stored as hex escape sequences.
Format: \f1 \cf0 <hex escapes> \f2 \cell <CODE> \cell \row
"""

import re
import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

_HORSE_RTF_PATH = Path(__file__).parent / "data" / "horse.rtf"

# name → code (e.g. "幸運有您" → "E356")
_lookup: dict[str, str] = {}


def init() -> None:
    """Parse horse.rtf and populate lookup dict. Call once at startup."""
    global _lookup
    try:
        content = _HORSE_RTF_PATH.read_text(encoding="latin-1")
    except FileNotFoundError:
        log.error(f"horse.rtf not found at {_HORSE_RTF_PATH}")
        return

    pattern = (
        r"\\f1[^\\]*\\cf0\s+"
        r"((?:\\'[0-9a-f]{2}\s*)+)"
        r"\\f2.*?\\cell\s*\\pard.*?\\cf0\s+"
        r"([A-Z][0-9]+)\s*\\cell"
    )
    rows = re.findall(pattern, content, re.DOTALL)

    lookup: dict[str, str] = {}
    for name_hex, code in rows:
        hex_bytes = re.findall(r"'([0-9a-f]{2})", name_hex)
        try:
            raw = bytes(int(h, 16) for h in hex_bytes)
            name = raw.decode("big5").strip()
            if name:
                lookup[name] = code.strip()
        except Exception:
            pass

    _lookup = lookup
    log.info(f"horse_data: loaded {len(_lookup)} horse name→code entries from RTF")


def lookup_horse_code(name: str) -> Optional[str]:
    """Return horse code for a given Chinese horse name, or None if not found."""
    name = name.strip()
    if code := _lookup.get(name):
        return code
    # Try stripping whitespace variants
    name_clean = name.replace("\u3000", "").replace(" ", "")
    for k, v in _lookup.items():
        if k.replace("\u3000", "").replace(" ", "") == name_clean:
            return v
    return None


def all_entries() -> dict[str, str]:
    """Return a copy of the full lookup dict."""
    return dict(_lookup)

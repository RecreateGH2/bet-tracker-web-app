"""Filesystem storage for race-day tip JPEGs + their extracted picks.

Layout:
  data/tips/{meeting_date}/{filename}.{jpg|png}   ← uploaded images
  data/tips/{meeting_date}/extracted.json         ← cached Claude vision output
"""

import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

log = logging.getLogger(__name__)

_TIPS_ROOT = Path("data/tips")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _meeting_dir(meeting_date: str) -> Path:
    if not _DATE_RE.match(meeting_date):
        raise ValueError(f"meeting_date must be YYYY-MM-DD, got {meeting_date!r}")
    return _TIPS_ROOT / meeting_date


def list_meetings() -> List[str]:
    if not _TIPS_ROOT.exists():
        return []
    return sorted(
        [p.name for p in _TIPS_ROOT.iterdir() if p.is_dir() and _DATE_RE.match(p.name)],
        reverse=True,
    )


def save_image(meeting_date: str, filename: str, content: bytes) -> Path:
    d = _meeting_dir(meeting_date)
    d.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", filename) or "image"
    p = d / safe
    # If a same-name file already exists, suffix with timestamp to keep both
    if p.exists():
        stem, ext = p.stem, p.suffix
        p = d / f"{stem}_{datetime.now().strftime('%H%M%S')}{ext}"
    p.write_bytes(content)
    return p


def list_images(meeting_date: str) -> List[dict]:
    try:
        d = _meeting_dir(meeting_date)
    except ValueError:
        return []
    if not d.exists():
        return []
    items = []
    extracted = load_extracted(meeting_date)
    for p in sorted(d.iterdir()):
        if p.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            continue
        info = {
            "filename": p.name,
            "size": p.stat().st_size,
            "uploaded_at": datetime.fromtimestamp(p.stat().st_mtime).isoformat(),
            "extracted": p.name in extracted,
        }
        ex = extracted.get(p.name) or {}
        info["source_name"] = ex.get("source_name")
        info["race_count"] = len(ex.get("races") or {})
        items.append(info)
    return items


def delete_image(meeting_date: str, filename: str) -> bool:
    p = _meeting_dir(meeting_date) / filename
    if not p.exists() or not p.is_file():
        return False
    p.unlink()
    extracted = load_extracted(meeting_date)
    if filename in extracted:
        del extracted[filename]
        save_extracted(meeting_date, extracted)
    return True


def get_image_path(meeting_date: str, filename: str) -> Optional[Path]:
    p = _meeting_dir(meeting_date) / filename
    return p if p.exists() and p.is_file() else None


def load_extracted(meeting_date: str) -> Dict[str, dict]:
    try:
        d = _meeting_dir(meeting_date)
    except ValueError:
        return {}
    cache = d / "extracted.json"
    if not cache.exists():
        return {}
    try:
        return json.loads(cache.read_text())
    except Exception as e:
        log.warning(f"Could not load extracted.json for {meeting_date}: {e}")
        return {}


def save_extracted(meeting_date: str, all_data: Dict[str, dict]) -> None:
    d = _meeting_dir(meeting_date)
    d.mkdir(parents=True, exist_ok=True)
    cache = d / "extracted.json"
    cache.write_text(json.dumps(all_data, indent=2, ensure_ascii=False))


def update_extracted_for_image(meeting_date: str, filename: str, data: dict) -> None:
    all_data = load_extracted(meeting_date)
    all_data[filename] = data
    save_extracted(meeting_date, all_data)

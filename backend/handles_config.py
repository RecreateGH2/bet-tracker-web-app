"""User-editable list of Threads handles to auto-pull race-day tips from.

Persisted to data/tips_handles.json so the list survives backend restarts
and can be edited via the /api/tips/handles endpoints.
"""

import json
import logging
from pathlib import Path
from typing import List

log = logging.getLogger(__name__)

_DATA_FILE = Path("data/tips_handles.json")

# Starter set derived from the 9 tipster sources we already extracted in
# the 馬王24052026 sample. Tweak via the UI; deletions persist.
_DEFAULTS: List[str] = [
    "yimu_1212",
    "ye7021678",
    "f1050730522",
    "dogupmonster",
    "keyman2025n",
    "hkxiaoxin",
    "ma66556688",
    "myjockeyclub",
    "horseracingrookie",
]

_handles: List[str] = []


def init() -> None:
    global _handles
    if _DATA_FILE.exists():
        try:
            data = json.loads(_DATA_FILE.read_text())
            if isinstance(data, list):
                _handles = [str(h).strip().lstrip("@") for h in data if str(h).strip()]
                log.info(f"Loaded {len(_handles)} tip handles from {_DATA_FILE}")
                return
        except Exception as e:
            log.warning(f"Could not parse {_DATA_FILE}: {e} — using defaults")
    _handles = list(_DEFAULTS)
    _save()


def _save() -> None:
    try:
        _DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        _DATA_FILE.write_text(json.dumps(_handles, indent=2, ensure_ascii=False))
    except Exception as e:
        log.warning(f"Could not save {_DATA_FILE}: {e}")


def get_all() -> List[str]:
    return list(_handles)


def add(handle: str) -> bool:
    h = handle.strip().lstrip("@")
    if not h or h in _handles:
        return False
    _handles.append(h)
    _save()
    return True


def remove(handle: str) -> bool:
    h = handle.strip().lstrip("@")
    if h not in _handles:
        return False
    _handles.remove(h)
    _save()
    return True


def replace_all(handles: List[str]) -> None:
    global _handles
    cleaned = []
    seen = set()
    for h in handles:
        s = str(h).strip().lstrip("@")
        if s and s not in seen:
            cleaned.append(s)
            seen.add(s)
    _handles = cleaned
    _save()

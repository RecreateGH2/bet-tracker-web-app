"""
Runtime-mutable source URL configuration.
Loaded from / persisted to backend/data/sources.json.
Falls back to hard-coded defaults on first run.
"""
from __future__ import annotations
import json
import logging
from pathlib import Path
from typing import Any, Dict

log = logging.getLogger(__name__)

_DATA_FILE = Path(__file__).parent / "data" / "sources.json"

# ── Defaults ────────────────────────────────────────────────────────────────
DEFAULTS: Dict[str, Dict[str, Any]] = {
    "live_bets": {
        "label": "Live Bets (大票房)",
        "table": "Live Bet Summary / Charts",
        "url": "https://racing.stheadline.com/tc/odds_livebet/%E5%A4%A7%E7%A5%A8%E6%88%BF",
    },
    "race_card": {
        "label": "Race Card (排位表)",
        "table": "馬匹資料",
        "url": "https://www.ma288.com/has/zh_CN/raceCard/showRaceCard.do",
    },
    "horse_profile": {
        "label": "Horse Profile (馬匹資料 — 烙號搜尋)",
        "table": "馬匹資料",
        "url": "https://www.ma288.com/has/zh_TW/horseinfo/searchHorse.do",
    },
    "horse_profile_fallback": {
        "label": "Horse Profile Fallback (馬名搜尋)",
        "table": "馬匹資料",
        "url": "https://www.ma288.com/has/zh_CN/horseinfo/horseSearch.do",
    },
    "win_odds": {
        "label": "Win Odds (獨贏及位置)",
        "table": "Trainer × Race Grid",
        "url": "https://racing.stheadline.com/tc/odds_wp/%E7%8D%A8%E8%B4%8F%E5%8F%8A%E4%BD%8D%E7%BD%AE",
    },
    "race_result": {
        "label": "Race Results (HKJC) — uses {date} / {course} / {raceno}",
        "table": "Trainer × Race Grid",
        "url": "https://racing.hkjc.com/racing/information/Chinese/Racing/LocalResults.aspx?RaceDate={date}&Racecourse={course}&RaceNo={raceno}",
    },
}

# ── In-memory store (mutable copy) ──────────────────────────────────────────
_sources: Dict[str, Dict[str, Any]] = {}


def _load() -> None:
    global _sources
    _sources = {k: dict(v) for k, v in DEFAULTS.items()}
    if _DATA_FILE.exists():
        try:
            saved = json.loads(_DATA_FILE.read_text())
            for key, entry in saved.items():
                if key in _sources and "url" in entry:
                    _sources[key]["url"] = entry["url"]
            log.info("source_config: loaded from %s", _DATA_FILE)
        except Exception as e:
            log.warning("source_config: could not load %s: %s", _DATA_FILE, e)


def _save() -> None:
    try:
        _DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        _DATA_FILE.write_text(
            json.dumps({k: {"url": v["url"]} for k, v in _sources.items()}, indent=2)
        )
    except Exception as e:
        log.warning("source_config: could not save %s: %s", _DATA_FILE, e)


def init() -> None:
    _load()


def get_all() -> Dict[str, Dict[str, Any]]:
    """Return a copy of all sources (key → {label, table, url})."""
    return {k: dict(v) for k, v in _sources.items()}


def get_url(key: str) -> str:
    """Return the URL for a given source key."""
    return _sources[key]["url"]


def set_url(key: str, url: str) -> None:
    """Update a source URL and persist to disk."""
    if key not in _sources:
        raise KeyError(f"Unknown source key: {key!r}")
    _sources[key]["url"] = url.strip()
    _save()

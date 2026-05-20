"""
Multi-race scheduler.

We track a set of races (persisted to data/tracked_races.json) and run a
single asyncio loop that decides, for each race, whether it's due for a
scrape based on its phase:

  • unknown                                → poll every 60s until start_time learned
  • pending  (>20 min until start)         → poll every 5 min (keep-alive)
  • pre      (20 → 2 min until start)      → poll every 30s
  • active   (2 min before → 5 min after)  → poll every 5s
  • ended    (>5 min after start)          → STOP scraping; archive final aggregates

"Continue tracking" manual override: sets manual_extend_until = now + 10 min.
While in effect the race stays in `active` regardless of clock — and if the
race was archived, the archive entry is removed so it can be re-archived
when the extension ends.
"""

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Tuple

from sqlalchemy import select

from .config import settings
from .database import AsyncSessionLocal
from .models import Race, Snapshot, BetEntry
from .scraper import scrape_race
from .websocket_manager import manager

log = logging.getLogger(__name__)

# ── Tunables ────────────────────────────────────────────────────────────────
_INTERVAL_UNKNOWN = 60
_INTERVAL_PENDING = 300
_INTERVAL_PRE = 30
_INTERVAL_ACTIVE = 5
_MAX_CONCURRENT_SCRAPES = 2

_PHASE_PRE_SECONDS = 20 * 60
_PHASE_ACTIVE_PRE_SECONDS = 2 * 60
_PHASE_END_SECONDS = 5 * 60
_MANUAL_EXTEND_SECONDS = 10 * 60

_TRACKED_FILE = Path("data/tracked_races.json")
_ARCHIVE_FILE = Path("data/race_archive.json")


@dataclass
class RaceState:
    race_no: int
    start_time: Optional[datetime] = None
    last_scrape_at: Optional[datetime] = None
    status: str = "unknown"        # unknown / pending / pre / active / ended
    ended_at: Optional[datetime] = None
    manual_extend_until: Optional[datetime] = None
    last_entry_count: int = 0


_tracked: Dict[int, RaceState] = {}
_archive: Dict[int, dict] = {}
_loop_task: Optional[asyncio.Task] = None
_running = False


# ── Persistence ─────────────────────────────────────────────────────────────
def _to_iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None

def _from_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


def _save_tracked() -> None:
    try:
        _TRACKED_FILE.parent.mkdir(parents=True, exist_ok=True)
        _TRACKED_FILE.write_text(json.dumps({
            rn: {
                "start_time": _to_iso(s.start_time),
                "status": s.status,
                "ended_at": _to_iso(s.ended_at),
                "manual_extend_until": _to_iso(s.manual_extend_until),
                "last_entry_count": s.last_entry_count,
            }
            for rn, s in _tracked.items()
        }, indent=2))
    except Exception as e:
        log.warning(f"_save_tracked failed: {e}")


def _load_tracked() -> None:
    if not _TRACKED_FILE.exists():
        return
    try:
        data = json.loads(_TRACKED_FILE.read_text())
        for rn_str, entry in data.items():
            rn = int(rn_str)
            _tracked[rn] = RaceState(
                race_no=rn,
                start_time=_from_iso(entry.get("start_time")),
                status=entry.get("status", "unknown"),
                ended_at=_from_iso(entry.get("ended_at")),
                manual_extend_until=_from_iso(entry.get("manual_extend_until")),
                last_entry_count=int(entry.get("last_entry_count") or 0),
            )
        log.info(f"Loaded {len(_tracked)} tracked races")
    except Exception as e:
        log.warning(f"_load_tracked failed: {e}")


def _save_archive() -> None:
    try:
        _ARCHIVE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _ARCHIVE_FILE.write_text(json.dumps(_archive, indent=2, default=str))
    except Exception as e:
        log.warning(f"_save_archive failed: {e}")


def _load_archive() -> None:
    if not _ARCHIVE_FILE.exists():
        return
    try:
        data = json.loads(_ARCHIVE_FILE.read_text())
        _archive.update({int(k): v for k, v in data.items()})
        log.info(f"Loaded {len(_archive)} archived races")
    except Exception as e:
        log.warning(f"_load_archive failed: {e}")


# ── Public state API ────────────────────────────────────────────────────────
def add_tracked(race_no: int) -> None:
    if race_no in _tracked:
        return
    _tracked[race_no] = RaceState(race_no=race_no)
    _save_tracked()
    log.info(f"Tracking race {race_no}")


def remove_tracked(race_no: int) -> None:
    if race_no in _tracked:
        del _tracked[race_no]
        _save_tracked()


def reset_race_state(race_no: int) -> None:
    """Wipe a tracked race's state (start_time, status, etc.) — used when
    the meeting day rolls over so yesterday's `ended` races re-scrape today.
    Also clears the in-memory horse_cache for this race so stale data from
    the previous meeting doesn't bleed into today."""
    s = _tracked.get(race_no)
    if s is None:
        return
    s.start_time = None
    s.last_scrape_at = None
    s.status = "unknown"
    s.ended_at = None
    s.manual_extend_until = None
    s.last_entry_count = 0
    _archive.pop(race_no, None)
    from . import horse_cache
    horse_cache.clear_race(race_no)
    _save_archive()
    _save_tracked()
    log.info(f"Race {race_no}: state reset (new meeting day)")


def _state_to_dict(s: RaceState) -> dict:
    return {
        "race_no": s.race_no,
        "start_time": _to_iso(s.start_time),
        "last_scrape_at": _to_iso(s.last_scrape_at),
        "status": s.status,
        "ended_at": _to_iso(s.ended_at),
        "manual_extend_until": _to_iso(s.manual_extend_until),
        "last_entry_count": s.last_entry_count,
    }


def get_tracked_states() -> List[dict]:
    return [_state_to_dict(s) for s in sorted(_tracked.values(), key=lambda x: x.race_no)]


def get_archive() -> Dict[int, dict]:
    return dict(_archive)


def extend_tracking(race_no: int, minutes: int = 10) -> bool:
    """User-triggered "continue tracking" — keep race active for N more minutes."""
    s = _tracked.get(race_no)
    if s is None:
        return False
    s.manual_extend_until = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    if s.status == "ended":
        s.status = "active"
        s.ended_at = None
        _archive.pop(race_no, None)
        _save_archive()
    _save_tracked()
    log.info(f"Race {race_no}: extended tracking until {s.manual_extend_until}")
    return True


# ── Backward-compat shims used by other routers ─────────────────────────────
def get_active_race() -> Optional[int]:
    """Legacy: returns the lowest tracked race_no, used as a single-race hint."""
    if not _tracked:
        return None
    return min(_tracked.keys())


def set_active_race(race_no: Optional[int]) -> None:
    """Legacy: adding to tracked set."""
    if race_no is not None:
        add_tracked(race_no)


def get_last_payload() -> Optional[dict]:
    return None  # no longer cached globally — per-race state lives in _tracked


# ── Phase / interval logic ──────────────────────────────────────────────────
def _phase_and_interval(state: RaceState, now: datetime) -> Tuple[str, Optional[int]]:
    """Returns (status, interval_seconds). interval=None means "do not scrape"."""
    if state.manual_extend_until and now < state.manual_extend_until:
        return ("active", _INTERVAL_ACTIVE)
    if state.start_time is None:
        return ("unknown", _INTERVAL_UNKNOWN)
    st = state.start_time
    if st.tzinfo is None:
        st = st.replace(tzinfo=timezone.utc)
    delta = (st - now).total_seconds()
    if delta > _PHASE_PRE_SECONDS:
        return ("pending", _INTERVAL_PENDING)
    if delta > _PHASE_ACTIVE_PRE_SECONDS:
        return ("pre", _INTERVAL_PRE)
    if delta > -_PHASE_END_SECONDS:
        return ("active", _INTERVAL_ACTIVE)
    return ("ended", None)


# ── Per-race scrape (mostly the old scrape_and_broadcast scoped to one race) ─
async def _scrape_one_race(race_no: int) -> None:
    state = _tracked.get(race_no)
    if state is None:
        return
    state.last_scrape_at = datetime.now(timezone.utc)
    try:
        result = await scrape_race(race_no)
    except Exception as e:
        log.error(f"Race {race_no}: scrape error: {e}")
        return

    if result.start_time is not None and result.start_time != state.start_time:
        old = state.start_time
        state.start_time = result.start_time
        log.info(f"Race {race_no}: start_time {old} → {state.start_time}")

    entries = result.entries
    now = datetime.now(timezone.utc)
    raw_hash = hashlib.sha256(
        json.dumps(
            [(e.horse_number, e.bet_type, e.amount, e.is_parlay) for e in entries],
            sort_keys=True,
        ).encode()
    ).hexdigest()

    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Race).where(Race.race_no == race_no))
        race_row = res.scalar_one_or_none()
        if race_row is None:
            race_row = Race(race_no=race_no, created_at=now)
            db.add(race_row)
            await db.flush()
        race_row.last_scraped_at = now
        snapshot = Snapshot(
            race_id=race_row.id,
            race_no=race_no,
            scraped_at=now,
            raw_html_hash=raw_hash,
            entry_count=len(entries),
        )
        db.add(snapshot)
        await db.flush()
        for e in entries:
            horse_num = f"{e.horse_number}-{e.horse_number_2}" if e.horse_number_2 else e.horse_number
            db.add(BetEntry(
                snapshot_id=snapshot.id,
                race_no=race_no,
                horse_number=horse_num,
                horse_name=e.horse_name,
                bet_type=e.bet_type,
                amount=e.amount,
                is_parlay=e.is_parlay,
                scraped_at=e.snapshot_time or now,
            ))
        await db.commit()

        res = await db.execute(select(BetEntry).where(BetEntry.race_no == race_no))
        all_entries = res.scalars().all()

    aggregates = _compute_aggregates(all_entries)
    state.last_entry_count = len(entries)

    payload = {
        "type": "snapshot",
        "race_no": race_no,
        "scraped_at": now.isoformat(),
        "snapshot_id": snapshot.id,
        "entry_count": len(entries),
        "race_start_time": _to_iso(state.start_time),
        "race_status": state.status,
        "entries": [
            {
                "horse_number": f"{e.horse_number}-{e.horse_number_2}" if e.horse_number_2 else e.horse_number,
                "horse_name": e.horse_name,
                "bet_type": e.bet_type,
                "amount": e.amount,
                "is_parlay": e.is_parlay,
                "scraped_at": (e.snapshot_time or now).isoformat(),
            }
            for e in entries
        ],
        "aggregates": aggregates,
    }
    await manager.broadcast(payload)


async def _archive_race(race_no: int) -> None:
    """Snapshot the final aggregates of a race into _archive."""
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(BetEntry).where(BetEntry.race_no == race_no))
        all_entries = res.scalars().all()
    aggregates = _compute_aggregates(all_entries)
    state = _tracked.get(race_no)
    _archive[race_no] = {
        "race_no": race_no,
        "start_time": _to_iso(state.start_time if state else None),
        "ended_at": _to_iso(state.ended_at if state and state.ended_at else datetime.now(timezone.utc)),
        "last_entry_count": state.last_entry_count if state else 0,
        "total_db_entries": len(all_entries),
        "aggregates": aggregates,
    }
    _save_archive()
    log.info(f"Race {race_no}: archived ({len(aggregates)} horses, {len(all_entries)} entries)")
    await manager.broadcast({"type": "race_ended", "race_no": race_no})


# ── Main loop ───────────────────────────────────────────────────────────────
async def _scrape_loop() -> None:
    log.info("Scrape loop started")
    sem = asyncio.Semaphore(_MAX_CONCURRENT_SCRAPES)

    async def go(rn: int) -> None:
        async with sem:
            await _scrape_one_race(rn)

    while _running:
        try:
            now = datetime.now(timezone.utc)
            to_scrape: List[int] = []
            for rn, state in list(_tracked.items()):
                new_status, interval = _phase_and_interval(state, now)
                if new_status != state.status:
                    old = state.status
                    state.status = new_status
                    log.info(f"Race {rn}: {old} → {new_status}")
                    if new_status == "ended":
                        if state.ended_at is None:
                            state.ended_at = now
                        # archive in the background (DB read)
                        asyncio.create_task(_archive_race(rn))
                    _save_tracked()
                if interval is None:
                    continue
                last = state.last_scrape_at
                if last is None or (now - last).total_seconds() >= interval:
                    to_scrape.append(rn)
            if to_scrape:
                await asyncio.gather(*[go(rn) for rn in to_scrape], return_exceptions=True)
                _save_tracked()
            await asyncio.sleep(1)
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.error(f"Scrape loop error: {e}")
            await asyncio.sleep(5)
    log.info("Scrape loop stopped")


# ── Aggregates (unchanged) ──────────────────────────────────────────────────
def _compute_aggregates(all_entries) -> List[Dict]:
    horses: Dict[str, Dict] = {}
    for e in all_entries:
        key = e.horse_number
        if key not in horses:
            horses[key] = {
                "horse_number": key,
                "horse_name": e.horse_name,
                "total_win_amount": 0,
                "total_place_amount": 0,
                "win_bet_count": 0,
                "place_bet_count": 0,
            }
        h = horses[key]
        if e.bet_type == "win":
            h["total_win_amount"] += e.amount
            h["win_bet_count"] += 1
        elif e.bet_type == "place":
            h["total_place_amount"] += e.amount
            h["place_bet_count"] += 1
        if e.horse_name and not h["horse_name"]:
            h["horse_name"] = e.horse_name

    total_win = sum(h["total_win_amount"] for h in horses.values()) or 1
    result = []
    for h in sorted(horses.values(), key=lambda x: int(x["horse_number"]) if x["horse_number"].isdigit() else 99):
        h["win_share_pct"] = round(h["total_win_amount"] / total_win * 100, 2)
        h["prev_win_share_pct"] = h["win_share_pct"]
        h["pct_change"] = 0.0
        result.append(h)
    return result


# ── Lifecycle ───────────────────────────────────────────────────────────────
def start_scheduler() -> None:
    global _running, _loop_task
    _load_tracked()
    _load_archive()
    _running = True
    _loop_task = asyncio.create_task(_scrape_loop())
    log.info(f"Scheduler started ({len(_tracked)} tracked races resumed)")


def stop_scheduler() -> None:
    global _running, _loop_task
    _running = False
    if _loop_task:
        _loop_task.cancel()
    log.info("Scheduler stopped")


# ── Used by /api/sources/live_bets/reload ───────────────────────────────────
async def scrape_now_all() -> None:
    """Force-scrape every tracked race once, ignoring the polling clock."""
    sem = asyncio.Semaphore(_MAX_CONCURRENT_SCRAPES)
    async def go(rn: int) -> None:
        async with sem:
            await _scrape_one_race(rn)
    await asyncio.gather(*[go(rn) for rn in list(_tracked.keys())], return_exceptions=True)

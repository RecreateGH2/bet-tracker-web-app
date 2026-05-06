"""
Background scheduler: scrapes the active race every N seconds,
persists to DB, and broadcasts to all WebSocket clients.
"""

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Optional, List, Dict

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select

from .config import settings
from .database import AsyncSessionLocal
from .models import Race, Snapshot, BetEntry
from .scraper import scrape_race
from .websocket_manager import manager

log = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()

# Mutable state: which race we're currently tracking
_state = {"active_race_no": None, "last_payload": None, "race_start_time": None}

HIGH_FREQ_SECONDS = 5       # poll interval near race start
HIGH_FREQ_WINDOW = 90       # seconds before/after start_time to use high freq


def get_active_race() -> Optional[int]:
    return _state["active_race_no"]


def get_last_payload() -> Optional[dict]:
    return _state["last_payload"]


def set_active_race(race_no: Optional[int]):
    _state["active_race_no"] = race_no
    log.info(f"Active race set to: {race_no}")


def _compute_next_interval() -> int:
    start_time = _state["race_start_time"]
    if start_time is None:
        return settings.scrape_interval_seconds
    now = datetime.now(timezone.utc)
    # Ensure start_time is tz-aware
    if start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=timezone.utc)
    seconds_delta = abs((start_time - now).total_seconds())
    if seconds_delta <= HIGH_FREQ_WINDOW:
        return HIGH_FREQ_SECONDS
    return settings.scrape_interval_seconds


async def scrape_and_broadcast():
    race_no = _state["active_race_no"]
    if race_no is None:
        return

    result = await scrape_race(race_no)
    entries = result.entries
    if result.start_time is not None:
        _state["race_start_time"] = result.start_time

    now = datetime.now(timezone.utc)

    # Compute hash to detect duplicate data
    raw_hash = hashlib.sha256(
        json.dumps([
            (e.horse_number, e.bet_type, e.amount, e.is_parlay)
            for e in entries
        ], sort_keys=True).encode()
    ).hexdigest()

    async with AsyncSessionLocal() as db:
        # Upsert the Race row
        result = await db.execute(select(Race).where(Race.race_no == race_no))
        race = result.scalar_one_or_none()
        if race is None:
            race = Race(race_no=race_no, created_at=now)
            db.add(race)
            await db.flush()

        race.last_scraped_at = now

        # Create snapshot
        snapshot = Snapshot(
            race_id=race.id,
            race_no=race_no,
            scraped_at=now,
            raw_html_hash=raw_hash,
            entry_count=len(entries),
        )
        db.add(snapshot)
        await db.flush()

        # Persist entries
        for e in entries:
            # For quinella bets, store the pair as "1-2" so the second horse isn't lost
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

        # Build aggregates from all entries for this race today
        result = await db.execute(
            select(BetEntry).where(BetEntry.race_no == race_no)
        )
        all_entries = result.scalars().all()

    aggregates = _compute_aggregates(all_entries)

    start_time = _state["race_start_time"]

    # Build WebSocket payload
    payload = {
        "type": "snapshot",
        "race_no": race_no,
        "scraped_at": now.isoformat(),
        "snapshot_id": snapshot.id,
        "entry_count": len(entries),
        "race_start_time": start_time.isoformat() if start_time else None,
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

    _state["last_payload"] = payload
    await manager.broadcast(payload)

    # Dynamically adjust polling interval based on proximity to race start
    next_interval = _compute_next_interval()
    scheduler.reschedule_job("scrape_job", trigger="interval", seconds=next_interval)
    log.debug(f"Broadcast race {race_no}: {len(entries)} entries, {len(aggregates)} horses — next poll in {next_interval}s")


def _compute_aggregates(all_entries) -> List[Dict]:
    """Compute per-horse aggregated totals from all stored entries."""
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
        h["prev_win_share_pct"] = h["win_share_pct"]  # historical diff handled client-side
        h["pct_change"] = 0.0
        result.append(h)

    return result


def start_scheduler():
    scheduler.add_job(
        scrape_and_broadcast,
        "interval",
        seconds=settings.scrape_interval_seconds,
        id="scrape_job",
        replace_existing=True,
    )
    scheduler.start()
    log.info(f"Scheduler started (interval: {settings.scrape_interval_seconds}s)")


def stop_scheduler():
    scheduler.shutdown(wait=False)
    log.info("Scheduler stopped")

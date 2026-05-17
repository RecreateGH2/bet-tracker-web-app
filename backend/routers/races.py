import asyncio
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import Race, Snapshot, BetEntry
from ..schemas import ActiveRaceIn, ActiveRaceOut, SnapshotOut
from ..scheduler import (
    get_active_race, set_active_race,
    add_tracked, remove_tracked, get_tracked_states,
    extend_tracking, get_archive,
)
from ..websocket_manager import manager
from .. import horse_cache
from ..horse_scraper import scrape_all_horses

router = APIRouter(prefix="/api/races")


async def _background_scrape_horses(race_no: int) -> None:
    """Run horse scraping in background; update cache when done."""
    horse_cache.start_loading(race_no)
    try:
        data = await scrape_all_horses(race_no)
        horse_cache.set_horse_info(race_no, data)
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Background horse scrape failed for race {race_no}: {e}")
        horse_cache.finish_loading(race_no)


@router.get("/active", response_model=ActiveRaceOut)
async def get_active():
    return {"race_no": get_active_race()}


@router.post("/active", response_model=ActiveRaceOut)
async def set_active(body: ActiveRaceIn):
    if body.race_no < 1 or body.race_no > 12:
        raise HTTPException(status_code=400, detail="race_no must be between 1 and 12")
    set_active_race(body.race_no)
    await manager.broadcast({
        "type": "race_changed",
        "race_no": body.race_no,
        "message": f"Now tracking race {body.race_no}",
    })
    # Auto-trigger horse info scraping if not already cached
    if horse_cache.get_horse_info(body.race_no) is None and not horse_cache.is_loading(body.race_no):
        asyncio.create_task(_background_scrape_horses(body.race_no))
    return {"race_no": body.race_no}


@router.get("/{race_no}/snapshots/latest")
async def get_latest_snapshot(race_no: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Snapshot)
        .where(Snapshot.race_no == race_no)
        .order_by(desc(Snapshot.scraped_at))
        .limit(1)
    )
    snapshot = result.scalar_one_or_none()
    if snapshot is None:
        return None

    entries_result = await db.execute(
        select(BetEntry).where(BetEntry.snapshot_id == snapshot.id)
    )
    entries = entries_result.scalars().all()
    snapshot.entries = list(entries)
    return snapshot


@router.get("/{race_no}/snapshots")
async def get_snapshots(
    race_no: int,
    limit: int = 50,
    since: Optional[datetime] = None,
    db: AsyncSession = Depends(get_db),
):
    q = select(Snapshot).where(Snapshot.race_no == race_no)
    if since:
        q = q.where(Snapshot.scraped_at > since)
    q = q.order_by(desc(Snapshot.scraped_at)).limit(limit)
    result = await db.execute(q)
    return result.scalars().all()


@router.get("/{race_no}/aggregates")
async def get_aggregates(race_no: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(BetEntry).where(BetEntry.race_no == race_no)
    )
    all_entries = result.scalars().all()
    if not all_entries:
        return []

    from ..scheduler import _compute_aggregates
    return _compute_aggregates(all_entries)


@router.get("/{race_no}/horse-info")
async def get_horse_info(race_no: int, response: Response):
    """
    Return horse info table data for a race.
    Automatically triggers background scraping on first call.
    Response: {"status": "ready"|"loading", "horses": [...]}
    """
    cached = horse_cache.get_horse_info(race_no)
    # Horse info changes rarely — cache aggressively at the browser + shared cache.
    response.headers["Cache-Control"] = "public, max-age=60, s-maxage=120"
    if cached is not None:
        return {"status": "ready", "horses": cached}
    if not horse_cache.is_loading(race_no):
        asyncio.create_task(_background_scrape_horses(race_no))
    return {"status": "loading", "horses": []}


@router.delete("/{race_no}/horse-info")
async def refresh_horse_info(race_no: int):
    """Force a fresh scrape of horse info for a race."""
    horse_cache.clear_race(race_no)
    asyncio.create_task(_background_scrape_horses(race_no))
    return {"status": "loading"}


# ── Multi-race tracking ────────────────────────────────────────────────────

@router.get("/tracked")
async def list_tracked():
    """Returns per-race state for everything currently being tracked."""
    return {"races": get_tracked_states()}


@router.post("/tracked/{race_no}")
async def start_tracking(race_no: int):
    if race_no < 1 or race_no > 20:
        raise HTTPException(status_code=400, detail="race_no must be 1-20")
    add_tracked(race_no)
    return {"status": "tracked", "race_no": race_no}


@router.delete("/tracked/{race_no}")
async def stop_tracking(race_no: int):
    remove_tracked(race_no)
    return {"status": "removed", "race_no": race_no}


@router.post("/tracked/{race_no}/extend")
async def extend_tracking_endpoint(race_no: int, minutes: int = 10):
    """`Continue tracking` button — keep race active for N more minutes."""
    ok = extend_tracking(race_no, minutes=minutes)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Race {race_no} is not tracked")
    return {"status": "extended", "race_no": race_no, "minutes": minutes}


# ── Archive (finished races) ───────────────────────────────────────────────

@router.get("/archive")
async def list_archive():
    """Returns final aggregates for every race that has ended."""
    arc = get_archive()
    return {"races": [arc[k] for k in sorted(arc.keys())]}


@router.get("/archive/{race_no}")
async def get_archive_entry(race_no: int):
    entry = get_archive().get(race_no)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Race {race_no} not in archive")
    return entry

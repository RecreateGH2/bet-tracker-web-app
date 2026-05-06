"""Trainer × Race grid endpoint."""

import asyncio
import logging
from fastapi import APIRouter

from .. import meeting_cache
from ..meeting_scraper import scrape_trainer_grid

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/meeting")


async def _background_scrape() -> None:
    meeting_cache.start_loading()
    try:
        data = await scrape_trainer_grid()
        if data is not None:
            meeting_cache.set(data)
        else:
            meeting_cache.finish_loading()
    except Exception as e:
        log.error(f"trainer-grid background scrape failed: {e}")
        meeting_cache.finish_loading()


@router.get("/trainer-grid")
async def get_trainer_grid():
    """
    Returns the meeting-wide trainer × race grid.
    Response: {"status": "ready"|"loading", "summary": {...}|None}
    """
    cached = meeting_cache.get()
    if cached is not None:
        return {"status": "ready", "summary": cached}
    if not meeting_cache.is_loading():
        asyncio.create_task(_background_scrape())
    return {"status": "loading", "summary": None}


@router.delete("/trainer-grid")
async def refresh_trainer_grid():
    """Force a fresh scrape."""
    meeting_cache.clear()
    asyncio.create_task(_background_scrape())
    return {"status": "loading"}

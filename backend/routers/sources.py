"""
/api/sources — view and edit source URLs, trigger reloads.
"""
import asyncio
import logging
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import source_config
from ..horse_cache import clear_race, is_loading, start_loading, finish_loading

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/sources", tags=["sources"])


class UrlUpdate(BaseModel):
    url: str


@router.get("")
def list_sources():
    """Return all source entries: {key: {label, table, url}}."""
    return source_config.get_all()


@router.patch("/{key}")
def update_source(key: str, body: UrlUpdate):
    """Update the URL for a single source key."""
    try:
        source_config.set_url(key, body.url)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown source key: {key!r}")
    return {"key": key, "url": body.url}


@router.post("/{key}/reload")
async def reload_source(key: str, race_no: Optional[int] = None):
    """
    Trigger a reload for the given source:
      - live_bets: fires an immediate scrape cycle
      - race_card / horse_profile / horse_profile_fallback:
          clears horse cache for race_no and re-scrapes
    """
    if key == "live_bets":
        from ..scheduler import scrape_now_all
        asyncio.create_task(scrape_now_all())
        return {"status": "scrape triggered"}

    if key in ("race_card", "horse_profile", "horse_profile_fallback"):
        if race_no is None:
            raise HTTPException(status_code=400, detail="race_no required for horse reloads")
        if is_loading(race_no):
            return {"status": "already loading"}
        clear_race(race_no)
        from ..horse_scraper import scrape_all_horses
        from ..horse_cache import set_horse_info

        async def _bg():
            start_loading(race_no)
            try:
                horses = await scrape_all_horses(race_no)
                set_horse_info(race_no, horses)
            except Exception as e:
                log.error("reload %s race %s error: %s", key, race_no, e)
                finish_loading(race_no)

        asyncio.create_task(_bg())
        return {"status": "reload started"}

    # Meeting-wide sources — invalidate the trainer-grid cache and re-scrape.
    if key in ("win_odds", "race_result"):
        from .. import meeting_cache
        from ..meeting_scraper import scrape_trainer_grid

        meeting_cache.clear()

        async def _bg_meeting():
            meeting_cache.start_loading()
            try:
                data = await scrape_trainer_grid()
                if data is not None:
                    meeting_cache.set(data)
                else:
                    meeting_cache.finish_loading()
            except Exception as e:
                log.error("reload %s error: %s", key, e)
                meeting_cache.finish_loading()

        asyncio.create_task(_bg_meeting())
        return {"status": "reload started"}

    raise HTTPException(status_code=404, detail=f"Unknown source key: {key!r}")

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import init_db
from .scraper import start_browser, stop_browser
from .scheduler import (
    start_scheduler, stop_scheduler,
    add_tracked, remove_tracked, reset_race_state, get_tracked_states,
)
from .routers import races, ws, sources, meeting
from . import horse_data, source_config, meeting_cache

log = logging.getLogger(__name__)


async def _bootstrap_meeting() -> None:
    """
    Background task fired at startup. Discovers today's meeting and
    pre-warms two caches so the UI feels instant:
      • adds every race to the live-bet tracker
      • scrapes horse-info for every race (sequentially)
    """
    await asyncio.sleep(3)   # let the scheduler + browser settle
    try:
        from .meeting_scraper import scrape_trainer_grid
        from .horse_scraper import prefetch_all_races

        log.info("Bootstrap: discovering today's meeting")
        data = await scrape_trainer_grid()
        if not data:
            log.warning("Bootstrap: meeting not available (no race day?)")
            return
        meeting_cache.set(data)
        race_nos = [r["race_no"] for r in data.get("races", [])]
        if not race_nos:
            return
        # Wipe state for races from a previous meeting day so today's
        # smart-polling loop re-learns their start_time fresh.
        today_set = set(race_nos)
        meeting_date = data.get("race_date", "")
        for s in get_tracked_states():
            if s["race_no"] not in today_set:
                remove_tracked(s["race_no"])
            elif s["start_time"] and meeting_date and not s["start_time"].startswith(meeting_date):
                reset_race_state(s["race_no"])

        log.info(f"Bootstrap: meeting has {len(race_nos)} races — auto-tracking all")
        for rn in race_nos:
            add_tracked(rn)
        log.info("Bootstrap: pre-fetching horse-info for every race")
        await prefetch_all_races(race_nos)
        log.info("Bootstrap: complete")
    except Exception as e:
        log.error(f"Bootstrap failed: {e}")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    source_config.init()
    horse_data.init()
    await init_db()
    await start_browser()
    start_scheduler()
    bootstrap_task = asyncio.create_task(_bootstrap_meeting())
    yield
    bootstrap_task.cancel()
    stop_scheduler()
    await stop_browser()


app = FastAPI(title="Bet Tracker API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(races.router)
app.include_router(ws.router)
app.include_router(sources.router)
app.include_router(meeting.router)


@app.get("/health")
async def health():
    return {"status": "ok"}

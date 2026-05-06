import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import init_db
from .scraper import start_browser, stop_browser
from .scheduler import start_scheduler, stop_scheduler
from .routers import races, ws, sources, meeting
from . import horse_data, source_config

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
    yield
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

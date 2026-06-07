"""Endpoints for the 馬王貼士 (race-day tips) feature."""

import asyncio
import logging
import re
import time
from pathlib import Path
from typing import Dict, Tuple

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import tips_storage, handles_config
from ..tips_analyzer import aggregate_per_race, generate_summary
from ..tips_auto import run_auto_fetch
from ..tips_extractor import extract_from_image, has_api_key

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/tips", tags=["tips"])

# 馬王貼士 analysis is expensive (vision + N summary calls). Cache the
# computed result per meeting_date for 15 min; uploads + deletes invalidate
# the cache so the next request recomputes.
_ANALYSIS_TTL_SECONDS = 15 * 60
_analysis_cache: Dict[str, Tuple[float, dict]] = {}


def _analysis_cache_key(meeting_date: str, rainy: bool = False) -> str:
    return f"{meeting_date}:rain" if rainy else meeting_date


def _invalidate_analysis(meeting_date: str) -> None:
    """Invalidate every cached variant for the given meeting date (dry + rainy)."""
    for key in list(_analysis_cache.keys()):
        if key == meeting_date or key.startswith(f"{meeting_date}:"):
            _analysis_cache.pop(key, None)


def parse_text_tips(text: str) -> Dict[str, dict]:
    """Parse a free-form text feed into {race_no: {top4, key_pick}}.

    Accepts a wide variety of formats commonly seen in Thread tipster posts:
        R1: 2-10-8-3
        R1：2-10-8-3
        R1/ 1-9-4-6
        第1場：1-2-3-4
        r1 1,2,3,4 *1
    """
    races: Dict[str, dict] = {}
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        # Capture race number after R / r / 第 ... 場
        m = re.match(r"^(?:R|r|第)\s*(\d+)\s*(?:場)?\s*[:：/.、\-\s]+(.*)$", line)
        if not m:
            continue
        rn = m.group(1)
        rest = m.group(2)
        # Strip a trailing "[…]" or "(備註)"
        rest = re.sub(r"[\[【].*?[\]】]", " ", rest)
        # Pull out the key pick if marked with * or ★
        key = None
        key_m = re.search(r"[\*★]\s*(\d+)", rest)
        if key_m:
            try:
                key = int(key_m.group(1))
            except ValueError:
                key = None
            rest = rest[:key_m.start()] + rest[key_m.end():]
        # Pick up to 4 numbers
        nums = re.findall(r"\d+", rest)
        top4 = []
        for n in nums:
            try:
                v = int(n)
            except ValueError:
                continue
            if 1 <= v <= 99:
                top4.append(v)
            if len(top4) == 4:
                break
        if top4:
            races[rn] = {"top4": top4, "key_pick": key}
    return races


@router.get("/meetings")
def list_meetings():
    return {
        "meetings": tips_storage.list_meetings(),
        "extractor_ready": has_api_key(),
    }


# ── Auto-fetch from Threads handles ──────────────────────────────────────

@router.get("/handles")
def get_handles():
    return {"handles": handles_config.get_all()}


class HandleIn:
    handle: str


@router.post("/handles")
async def add_handle(body: dict):
    h = (body or {}).get("handle", "")
    if not h:
        raise HTTPException(status_code=400, detail="handle required")
    added = handles_config.add(h)
    return {"added": added, "handles": handles_config.get_all()}


@router.delete("/handles/{handle}")
def remove_handle(handle: str):
    removed = handles_config.remove(handle)
    return {"removed": removed, "handles": handles_config.get_all()}


@router.post("/auto-fetch")
async def trigger_auto_fetch(
    meeting_date: str | None = None,
    venue: str | None = None,
):
    """Kick off an auto-fetch run in the background. Returns immediately.
    `venue` is 沙田 / 跑馬地 — used to reject foreign-race posts."""
    asyncio.create_task(run_auto_fetch(meeting_date, venue))
    return {
        "status": "started",
        "meeting_date": meeting_date,
        "venue": venue,
        "handles": handles_config.get_all(),
    }


@router.get("/{meeting_date}/images")
def list_images(meeting_date: str):
    return {"images": tips_storage.list_images(meeting_date)}


@router.post("/{meeting_date}/upload")
async def upload_image(meeting_date: str, file: UploadFile = File(...)):
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 10MB)")
    if not file.filename:
        raise HTTPException(status_code=400, detail="filename missing")
    try:
        path = tips_storage.save_image(meeting_date, file.filename, content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    asyncio.create_task(_extract_and_cache(meeting_date, path.name, path))
    return {"filename": path.name, "size": len(content), "extraction_queued": has_api_key()}


async def _extract_and_cache(meeting_date: str, filename: str, path: Path) -> None:
    data = await extract_from_image(path)
    if data is not None:
        tips_storage.update_extracted_for_image(meeting_date, filename, data)
        race_count = len((data.get("races") or {}))
        log.info(f"tips: extracted {filename}: {race_count} races (source={data.get('source_name')})")
        _invalidate_analysis(meeting_date)


@router.delete("/{meeting_date}/{filename}")
def delete_image(meeting_date: str, filename: str):
    """Remove an entry. Handles both image-backed sources (deletes the file
    and the extracted record) and text-only sources (no file, just record)."""
    deleted_img = tips_storage.delete_image(meeting_date, filename)
    extracted = tips_storage.load_extracted(meeting_date)
    had_extract = filename in extracted
    if had_extract:
        del extracted[filename]
        tips_storage.save_extracted(meeting_date, extracted)
    if not deleted_img and not had_extract:
        raise HTTPException(status_code=404, detail="not found")
    _invalidate_analysis(meeting_date)
    return {"deleted": filename}


@router.post("/{meeting_date}/text-source")
async def add_text_source(meeting_date: str, body: dict):
    """Create a new text-only tipster source from a pasted feed. Body:
       { "source_name": "...", "text": "R1: 2-10-8-3\\nR2: 1-7-6-4 ..." }
    or pre-parsed:
       { "source_name": "...", "races": { "1": {"top4":[...], "key_pick": null} } }
    """
    source_name = (body.get("source_name") or "").strip()
    if not source_name:
        raise HTTPException(status_code=400, detail="source_name required")

    races = body.get("races") or {}
    if not races and body.get("text"):
        races = parse_text_tips(body["text"])

    # Clean / coerce
    cleaned: Dict[str, dict] = {}
    for rn, info in (races or {}).items():
        if not isinstance(info, dict):
            continue
        try:
            int(rn)
        except (TypeError, ValueError):
            continue
        top4 = []
        for h in (info.get("top4") or [])[:4]:
            try:
                top4.append(int(h))
            except (TypeError, ValueError):
                continue
        key_raw = info.get("key_pick")
        try:
            key = int(key_raw) if key_raw is not None and key_raw != "" else None
        except (TypeError, ValueError):
            key = None
        if top4:
            cleaned[str(rn)] = {"top4": top4, "key_pick": key}

    if not cleaned:
        raise HTTPException(status_code=400, detail="could not parse any races from input")

    slug = re.sub(r"[^A-Za-z0-9]+", "_", source_name)[:40] or "src"
    filename = f"text_{slug}_{int(time.time())}.txt"
    payload = {
        "source_name": source_name,
        "races": cleaned,
        "text_only": True,
        "edited": True,
    }
    tips_storage.update_extracted_for_image(meeting_date, filename, payload)
    _invalidate_analysis(meeting_date)
    return {"filename": filename, "data": payload}


@router.get("/{meeting_date}/image/{filename}")
def serve_image(meeting_date: str, filename: str):
    p = tips_storage.get_image_path(meeting_date, filename)
    if p is None:
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(str(p))


@router.get("/{meeting_date}/extracted")
def get_extracted(meeting_date: str):
    return {"extracted": tips_storage.load_extracted(meeting_date)}


@router.patch("/{meeting_date}/extracted/{filename}")
async def update_extracted(meeting_date: str, filename: str, body: dict):
    """Manual override of the extracted picks for one image. Body shape:
       { "source_name": "...", "races": { "1": {"top4":[1,2,3,4], "key_pick":1}, ... } }
    Invalidates the analysis cache so the next poll re-aggregates."""
    if tips_storage.get_image_path(meeting_date, filename) is None:
        raise HTTPException(status_code=404, detail="image not found")
    # Defensive cleanup: keep only allowed shape
    cleaned_races: dict[str, dict] = {}
    for rn, info in (body.get("races") or {}).items():
        if not isinstance(info, dict):
            continue
        try:
            int(rn)
        except (TypeError, ValueError):
            continue
        top4_raw = info.get("top4") or []
        top4 = []
        for h in top4_raw[:4]:
            try:
                top4.append(int(h))
            except (TypeError, ValueError):
                continue
        key_raw = info.get("key_pick")
        try:
            key = int(key_raw) if key_raw is not None and key_raw != "" else None
        except (TypeError, ValueError):
            key = None
        cleaned_races[str(rn)] = {"top4": top4, "key_pick": key}
    payload = {
        "source_name": (body.get("source_name") or "").strip() or None,
        "races": cleaned_races,
        "edited": True,    # mark this entry as human-edited
    }
    tips_storage.update_extracted_for_image(meeting_date, filename, payload)
    _invalidate_analysis(meeting_date)
    return {"updated": filename, "data": payload}


@router.post("/{meeting_date}/re-extract/{filename}")
async def re_extract(meeting_date: str, filename: str):
    p = tips_storage.get_image_path(meeting_date, filename)
    if p is None:
        raise HTTPException(status_code=404, detail="not found")
    asyncio.create_task(_extract_and_cache(meeting_date, filename, p))
    return {"status": "extracting", "extractor_ready": has_api_key()}


@router.post("/{meeting_date}/re-extract-all")
async def re_extract_all(meeting_date: str):
    images = tips_storage.list_images(meeting_date)
    for img in images:
        p = tips_storage.get_image_path(meeting_date, img["filename"])
        if p is not None:
            asyncio.create_task(_extract_and_cache(meeting_date, img["filename"], p))
    return {"status": "extracting", "count": len(images)}


@router.get("/{meeting_date}/analysis")
async def get_analysis(meeting_date: str, force: bool = False, rainy: bool = False):
    """
    Returns the aggregated analysis for a meeting. Cached for 15 min per
    (meeting_date, rainy) — pass ?force=true to bypass.
    Cache is auto-invalidated when an image is uploaded, deleted, or
    re-extracted.

    rainy=true asks the LLM analyst to weight each horse's wet-track /
    soft-going track record more heavily in its summary.
    """
    now = time.time()
    cache_key = _analysis_cache_key(meeting_date, rainy)
    cached = _analysis_cache.get(cache_key)
    if not force and cached and (now - cached[0]) < _ANALYSIS_TTL_SECONDS:
        return {**cached[1], "cached": True, "age_seconds": int(now - cached[0]), "rainy": rainy}

    extracted = tips_storage.load_extracted(meeting_date)
    if not extracted:
        result = {"races": {}, "summaries": {}, "source_count": 0}
        _analysis_cache[cache_key] = (now, result)
        return {**result, "cached": False, "age_seconds": 0, "rainy": rainy}

    aggregated = await aggregate_per_race(extracted, meeting_date)
    summaries: Dict[int, str] = {}
    if aggregated:
        gen = await asyncio.gather(
            *[generate_summary(rn, data, meeting_date, rainy=rainy)
              for rn, data in aggregated.items()],
            return_exceptions=True,
        )
        for (rn, _), summary in zip(aggregated.items(), gen):
            summaries[rn] = summary if isinstance(summary, str) else ""

    result = {
        "races": {str(k): v for k, v in aggregated.items()},
        "summaries": {str(k): v for k, v in summaries.items()},
        "source_count": len(extracted),
    }
    _analysis_cache[cache_key] = (now, result)
    return {**result, "cached": False, "age_seconds": 0, "rainy": rainy}

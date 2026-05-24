"""Endpoints for the 馬王貼士 (race-day tips) feature."""

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import tips_storage
from ..tips_analyzer import aggregate_per_race, generate_summary
from ..tips_extractor import extract_from_image, has_api_key

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/tips", tags=["tips"])


@router.get("/meetings")
def list_meetings():
    return {
        "meetings": tips_storage.list_meetings(),
        "extractor_ready": has_api_key(),
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


@router.delete("/{meeting_date}/{filename}")
def delete_image(meeting_date: str, filename: str):
    if not tips_storage.delete_image(meeting_date, filename):
        raise HTTPException(status_code=404, detail="not found")
    return {"deleted": filename}


@router.get("/{meeting_date}/image/{filename}")
def serve_image(meeting_date: str, filename: str):
    p = tips_storage.get_image_path(meeting_date, filename)
    if p is None:
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(str(p))


@router.get("/{meeting_date}/extracted")
def get_extracted(meeting_date: str):
    return {"extracted": tips_storage.load_extracted(meeting_date)}


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
async def get_analysis(meeting_date: str):
    extracted = tips_storage.load_extracted(meeting_date)
    if not extracted:
        return {"races": {}, "summaries": {}, "source_count": 0}
    aggregated = await aggregate_per_race(extracted)
    summaries = {}
    if aggregated:
        results = await asyncio.gather(
            *[generate_summary(rn, data) for rn, data in aggregated.items()],
            return_exceptions=True,
        )
        for (rn, _), summary in zip(aggregated.items(), results):
            summaries[rn] = summary if isinstance(summary, str) else ""
    return {
        "races": {str(k): v for k, v in aggregated.items()},
        "summaries": {str(k): v for k, v in summaries.items()},
        "source_count": len(extracted),
    }

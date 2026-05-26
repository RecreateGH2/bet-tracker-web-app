"""Auto-pull tip screenshots from a configured list of Threads handles.

Runs once per race-day morning (or on demand via /api/tips/auto-fetch).
Politely spaced — sleeps SPACING_SECONDS between handles to avoid tripping
Threads' rate-limit / anti-bot heuristics.
"""

import asyncio
import logging
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict, List, Optional

from . import handles_config, tips_storage
from .threads_scraper import download_image, fetch_handle_posts
from .tips_extractor import extract_from_image, has_api_key

log = logging.getLogger(__name__)

_HKT = timezone(timedelta(hours=8))

# Polite spacing between handle visits (user explicitly asked for "rather
# large spacing"). 75s × 9 handles ≈ 11 min total per run, well below
# Threads' typical bot-detection thresholds.
SPACING_SECONDS = 75

# Only keep posts created within this window (most tipsters post tips a
# day or two before the meeting).
MAX_POST_AGE_HOURS = 72


def _today_hkt() -> str:
    return datetime.now(_HKT).strftime("%Y-%m-%d")


def _date_patterns(meeting_date: str) -> List[re.Pattern]:
    """Build regex patterns that match the meeting date in common forms used
    in Thread posts: 24/05/2026, 2026/05/24, 5月24日, 24-5, 0524, 5.24, etc."""
    try:
        y, m, d = meeting_date.split("-")
    except Exception:
        return []
    y_i, m_i, d_i = int(y), int(m), int(d)
    patterns = [
        rf"{y}\s*[/\-年.]\s*{m_i:02d}\s*[/\-月.]\s*{d_i:02d}",          # 2026/05/24, 2026年5月24日
        rf"{y}\s*[/\-年.]\s*{m_i}\s*[/\-月.]\s*{d_i}",                  # 2026/5/24
        rf"{d_i:02d}\s*[/\-]\s*{m_i:02d}\s*[/\-]\s*{y}",                # 24/05/2026
        rf"{d_i}\s*[/\-]\s*{m_i}\s*[/\-]\s*{y}",                        # 24/5/2026
        rf"{m_i}\s*月\s*{d_i}\s*日",                                     # 5月24日
        rf"{m_i:02d}{d_i:02d}",                                         # 0524
        rf"{m_i}\.{d_i}\b",                                              # 5.24
    ]
    return [re.compile(p) for p in patterns]


# Foreign racing keywords — posts mentioning these (more than the HK venue)
# are about Ireland / Japan / UK / France / etc. races and must be rejected.
_FOREIGN_KEYWORDS = (
    "愛爾蘭", "日本", "英國", "美國", "法國", "澳洲", "南非",
    "迪拜", "杜拜", "新加坡", "韓國", "杜拜", "沙地", "卡塔爾", "S2", "S3", "S4",
)


def _post_matches_meeting(
    text: str,
    date_patterns: List[re.Pattern],
    venue: Optional[str] = None,
) -> bool:
    """Accept a post only if it (1) mentions today's meeting date AND
    (2) explicitly mentions the HK venue we're tracking AND (3) isn't
    dominated by foreign-race keywords."""
    if not text:
        return False
    if not any(p.search(text) for p in date_patterns):
        return False

    # Strong venue requirement — if we know today's venue we require it.
    if venue:
        if venue not in text:
            return False
    else:
        # Any HK venue is acceptable if caller didn't specify.
        if "沙田" not in text and "跑馬地" not in text:
            return False

    # Reject when foreign-race keywords appear more prominently than HK
    # ones. A passing mention is fine ("…多倫嘅愛爾蘭賽事…") but a post
    # primarily about S2/S3/愛爾蘭 should be skipped.
    foreign = sum(text.count(k) for k in _FOREIGN_KEYWORDS)
    if foreign > 0:
        local = (
            text.count("沙田") + text.count("跑馬地")
            + text.count("香港") + text.count("HK")
        )
        if local == 0 or foreign >= local:
            return False
    return True


def _post_recent(ts: Optional[datetime], hours: int = MAX_POST_AGE_HOURS) -> bool:
    if ts is None:
        return True   # unknown — keep, the date pattern is the real filter
    now = datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (now - ts).total_seconds() <= hours * 3600


async def run_auto_fetch(
    meeting_date: Optional[str] = None,
    venue: Optional[str] = None,
) -> Dict[str, dict]:
    """For each configured handle, scrape recent posts, keep those matching
    the meeting (date + venue), download attached images, and trigger Poe
    extraction. Returns a per-handle summary dict.

    venue should be the Traditional-Chinese venue name (e.g. "沙田" or
    "跑馬地"). When provided, posts that don't mention this venue are
    rejected — this is important because tipsters often post about Ireland
    / Japan / etc. races and we don't want those mistakenly imported."""
    meeting_date = meeting_date or _today_hkt()
    date_patterns = _date_patterns(meeting_date)
    handles = handles_config.get_all()
    if not handles:
        log.info("auto-fetch: no handles configured, skipping")
        return {}

    log.info(
        f"auto-fetch: scanning {len(handles)} handles for meeting "
        f"{meeting_date} @ {venue or 'any HK venue'} (spacing {SPACING_SECONDS}s)"
    )

    summary: Dict[str, dict] = {}
    for idx, handle in enumerate(handles):
        try:
            handle_summary = await _process_handle(handle, meeting_date, date_patterns, venue)
        except Exception as e:
            log.error(f"auto-fetch: {handle} failed: {e}")
            handle_summary = {"error": str(e), "posts_seen": 0, "images_saved": 0}
        summary[handle] = handle_summary
        # Politely wait before the next handle (skip after the last one)
        if idx < len(handles) - 1:
            await asyncio.sleep(SPACING_SECONDS)

    log.info(f"auto-fetch: completed. {summary}")
    return summary


async def _process_handle(
    handle: str,
    meeting_date: str,
    date_patterns: List[re.Pattern],
    venue: Optional[str] = None,
) -> dict:
    log.info(f"auto-fetch: visiting @{handle}")
    posts = await fetch_handle_posts(handle)
    if not posts:
        return {"posts_seen": 0, "matched": 0, "images_saved": 0, "note": "no posts returned"}

    existing = {img["filename"] for img in tips_storage.list_images(meeting_date)}
    matched_count = 0
    saved_count = 0
    extraction_count = 0
    notes: List[str] = []

    for post in posts:
        if not _post_recent(post.get("timestamp")):
            continue
        if not _post_matches_meeting(post.get("text", ""), date_patterns, venue):
            continue
        matched_count += 1
        images = post.get("images") or []
        if not images:
            notes.append(f"{post['post_id']}: matched but no image")
            continue

        for i, img_url in enumerate(images[:3]):   # cap at 3 images per post
            suffix_hint = ""
            filename = f"{handle}_{post['post_id']}_{i}.jpg"
            if filename in existing:
                continue
            try:
                content, suffix = await download_image(img_url)
                suffix_hint = suffix
                # Rename to reflect actual suffix if different
                if suffix and not filename.endswith(suffix):
                    filename = filename.rsplit(".", 1)[0] + suffix
                if filename in existing:
                    continue
                path = tips_storage.save_image(meeting_date, filename, content)
                saved_count += 1
                # Trigger extraction in the background; mark source_name
                # with the handle so the UI shows @handle even if the LLM
                # can't read a name from the image.
                if has_api_key():
                    asyncio.create_task(_extract_with_handle(meeting_date, path.name, path, handle))
                    extraction_count += 1
            except Exception as e:
                notes.append(f"{post['post_id']} img{i}: {e}")

    return {
        "posts_seen": len(posts),
        "matched": matched_count,
        "images_saved": saved_count,
        "extractions_queued": extraction_count,
        "notes": notes[:6],
    }


async def _extract_with_handle(meeting_date: str, filename: str, path: Path, handle: str) -> None:
    """Run the Poe extractor, then overwrite source_name with the Threads
    handle so the per-source breakdown groups posts under a stable name."""
    data = await extract_from_image(path)
    if data is None:
        data = {"source_name": f"@{handle}", "races": {}}
    else:
        data["source_name"] = f"@{handle}"
    tips_storage.update_extracted_for_image(meeting_date, filename, data)
    # Invalidate analysis cache so the next poll picks up the new source
    try:
        from .routers import tips as tips_router
        tips_router._invalidate_analysis(meeting_date)
    except Exception:
        pass
    log.info(
        f"auto-fetch: extracted {filename} (@{handle}): "
        f"{len(data.get('races') or {})} races"
    )

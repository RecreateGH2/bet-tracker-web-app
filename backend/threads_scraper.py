"""Scrape recent posts from a Threads handle's public profile.

Threads is a Meta-owned product with a React SPA frontend and aggressive
bot-detection. We reuse scraper.new_page() (which carries the
playwright-stealth patches and a realistic UA) so the visit looks like a
normal browser. Selectors are intentionally generic — we read every
`article`-like container, pull its text + image URLs, and let the caller
decide which ones to keep.
"""

import logging
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Optional, Tuple
from urllib.parse import urlparse

from . import scraper as _base_scraper

log = logging.getLogger(__name__)

_HKT = timezone(timedelta(hours=8))
_PROFILE_URL = "https://www.threads.com/@{handle}"

# How long to wait for the SPA to hydrate after domcontentloaded. The
# stealth wrapper plus the auto-scroll below usually finishes within 4-6s.
_HYDRATE_MS = 4000
_AFTER_SCROLL_MS = 2000

# JS that walks the page, finds posts, and returns lightweight summaries.
# Tries multiple selector strategies because Threads tweaks its layout.
_POSTS_JS = r"""() => {
    const posts = [];
    // Strategy 1: each post is wrapped in a div with role="article" or a
    // data-pressable-container attribute. Strategy 2: time elements
    // anchored to a post often live inside an <a href="/.../post/...">.
    const containerSel = [
        'div[data-pressable-container="true"]',
        'div[role="article"]',
    ].join(',');
    const candidates = Array.from(document.querySelectorAll(containerSel));
    const seen = new Set();
    for (const el of candidates) {
        // Find the canonical post permalink — most reliable post ID source
        const link = el.querySelector('a[href*="/post/"]');
        const href = link ? link.getAttribute('href') : null;
        if (!href) continue;
        if (seen.has(href)) continue;
        seen.add(href);

        const timeEl = el.querySelector('time');
        const ts = timeEl ? (timeEl.getAttribute('datetime') || timeEl.getAttribute('title')) : null;

        // Text — innerText of the container, capped
        const text = (el.innerText || '').slice(0, 4000);

        // Images: skip avatar / verified-badge sprites by filtering small assets
        const imgs = Array.from(el.querySelectorAll('img'))
            .map(i => i.currentSrc || i.src)
            .filter(s => s && !/data:image|emoji|sprite|profile_pic|avatar/.test(s));

        posts.push({ href, timestamp: ts, text, images: imgs });
    }
    return posts;
}"""


def _post_id_from_href(href: str) -> str:
    """Extract a stable id from a Threads post URL."""
    # e.g. /@yimu_1212/post/Cxyz123  →  Cxyz123
    m = re.search(r"/post/([A-Za-z0-9_-]+)", href or "")
    return m.group(1) if m else re.sub(r"[^A-Za-z0-9]", "_", href or "post")[-16:]


def _parse_ts(s: str | None) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


async def fetch_handle_posts(handle: str) -> List[dict]:
    """Visit https://www.threads.com/@{handle} and return recent posts.

    Each post is {post_id, href, timestamp(datetime|None), text, images[str]}.
    Falls back to an empty list on any failure (caller decides what to do).
    """
    handle = handle.strip().lstrip("@")
    if not handle:
        return []

    page = await _base_scraper.new_page()
    out: List[dict] = []
    try:
        url = _PROFILE_URL.format(handle=handle)
        await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        await page.wait_for_timeout(_HYDRATE_MS)
        # Trigger a small scroll so lazy posts hydrate
        try:
            await page.evaluate("() => window.scrollBy(0, 1200)")
        except Exception:
            pass
        await page.wait_for_timeout(_AFTER_SCROLL_MS)

        raw = await page.evaluate(_POSTS_JS)
        for item in raw or []:
            href = item.get("href") or ""
            out.append({
                "post_id": _post_id_from_href(href),
                "href": href,
                "timestamp": _parse_ts(item.get("timestamp")),
                "text": item.get("text") or "",
                "images": item.get("images") or [],
            })
    except Exception as e:
        log.error(f"threads_scraper: {handle}: {e}")
    finally:
        await page.close()
    return out


async def download_image(image_url: str) -> Tuple[bytes, str]:
    """Download an image via Playwright's request context so it shares the
    same cookies/UA as the page load. Returns (bytes, suffix)."""
    page = await _base_scraper.new_page()
    try:
        resp = await page.context.request.get(image_url, timeout=30_000)
        if not resp.ok:
            raise RuntimeError(f"HTTP {resp.status}")
        body = await resp.body()
        # Guess suffix from URL path or content-type
        suffix = ".jpg"
        url_path = urlparse(image_url).path
        for ext in (".png", ".jpeg", ".jpg", ".webp"):
            if url_path.lower().endswith(ext):
                suffix = ".jpg" if ext == ".jpeg" else ext
                break
        ct = (resp.headers or {}).get("content-type", "")
        if "png" in ct: suffix = ".png"
        elif "webp" in ct: suffix = ".webp"
        return body, suffix
    finally:
        await page.close()

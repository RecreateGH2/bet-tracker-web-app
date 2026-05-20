"""
Playwright-based scraper for racing.stheadline.com 大票房 (Big Bet Pool).

The site is a Nuxt.js/Vue.js app that loads data dynamically via JavaScript.
We use Playwright to render the page and extract data from the Vue/Vuex store
directly via page.evaluate(), falling back to DOM parsing if that fails.

Data structure from the site:
  liveBetList entries: { snapshotTime, type, horseNo1, horseNo2, value (in K), parlay }
  type values: "win", "place", "quin", "place-quin"
"""

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Optional, Tuple, List
from urllib.parse import urlparse, urlencode, parse_qsl, urlunparse

# The stheadline site is Hong Kong racing — all clock values on the page are
# in HKT regardless of where the scraper is running.
_HKT = timezone(timedelta(hours=8))

from playwright.async_api import async_playwright, Page, TimeoutError as PWTimeout
from playwright_stealth import Stealth

from .config import settings
from . import source_config as _src_cfg

log = logging.getLogger(__name__)

# Read at call-time via helper so edits in source_config take effect immediately
def _page_url() -> str:
    try:
        return _src_cfg.get_url("live_bets")
    except Exception:
        return settings.target_base_url

# Semaphore: only one Playwright scrape at a time
_scrape_lock = asyncio.Semaphore(1)


def _build_url(base: str, race_no: int) -> str:
    """Merge raceno + content_only2 into base, overriding any existing values."""
    parts = urlparse(base)
    params = dict(parse_qsl(parts.query, keep_blank_values=True))
    params["raceno"] = str(race_no)
    params["content_only2"] = "true"
    return urlunparse(parts._replace(query=urlencode(params)))


@dataclass
class BetEntryData:
    horse_number: str
    horse_name: Optional[str]
    bet_type: str          # "win" | "place" | "quin" | "place-quin"
    amount: int            # HK$ (value * 1000)
    is_parlay: bool
    snapshot_time: Optional[datetime] = None
    # For quinella bets, second horse
    horse_number_2: Optional[str] = None


@dataclass
class ScrapeResult:
    entries: List[BetEntryData]
    start_time: Optional[datetime]  # 開跑時間


# Shared browser + context (created once, reused across scrapes).
# Wrapped with playwright-stealth so Cloudflare's managed challenge on
# ma288.com lets us through.
_browser = None
_playwright = None
_pw_cm = None
_context = None


async def start_browser():
    global _browser, _playwright, _pw_cm, _context
    if _browser is None:
        # Stealth wraps the playwright instance with anti-detection patches
        _pw_cm = Stealth().use_async(async_playwright())
        _playwright = await _pw_cm.__aenter__()
        _browser = await _playwright.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        _context = await _browser.new_context(
            viewport={"width": 1280, "height": 800},
            locale="zh-HK",
        )
        log.info("Playwright browser started (stealth)")


async def new_page():
    """Open a page in the shared context (with realistic UA)."""
    if _context is None:
        await start_browser()
    return await _context.new_page()


async def stop_browser():
    global _browser, _playwright, _pw_cm, _context
    try:
        if _context:
            await _context.close()
    except Exception:
        pass
    _context = None
    try:
        if _browser:
            await _browser.close()
    except Exception:
        pass
    _browser = None
    try:
        if _pw_cm:
            await _pw_cm.__aexit__(None, None, None)
    except Exception:
        pass
    _pw_cm = None
    _playwright = None
    log.info("Playwright browser stopped")


async def restart_browser():
    """Tear down the shared browser/context and start fresh. Used by the
    periodic restart loop to prevent the long-running Playwright session
    from accumulating dead state (which has wedged scrapes in the past)."""
    log.info("Restarting Playwright browser (recovery)")
    await stop_browser()
    await start_browser()


async def scrape_race(race_no: int) -> ScrapeResult:
    """Scrape live bet entries for a given race number."""
    if not _scrape_lock.locked():
        async with _scrape_lock:
            return await _do_scrape(race_no)
    else:
        log.debug(f"Race {race_no}: scrape skipped, previous scrape still running")
        return ScrapeResult(entries=[], start_time=None)


async def _do_scrape(race_no: int) -> ScrapeResult:
    if _browser is None:
        await start_browser()

    page = await new_page()
    try:
        url = _build_url(_page_url(), race_no)
        log.debug(f"Navigating to {url}")

        # Use domcontentloaded — networkidle never fires on live betting sites
        await page.goto(url, wait_until="domcontentloaded", timeout=30_000)

        # Wait for the Vue app to mount and fetch data (the live bet table)
        try:
            await page.wait_for_selector(
                "div.grid.grid-cols-3.body-4", timeout=20_000
            )
        except PWTimeout:
            log.warning(f"Race {race_no}: timed out waiting for bet table, trying DOM parse anyway")

        # Strategy 1: Extract data directly from Vuex store via JS evaluation
        entries = await _extract_from_vuex(page, race_no)

        # Strategy 2: Fall back to DOM parsing if Vuex approach fails
        if not entries:
            log.info(f"Race {race_no}: Vuex extraction empty, falling back to DOM parse")
            entries = await _extract_from_dom(page, race_no)

        start_time = await _extract_start_time(page, race_no)

        log.info(f"Race {race_no}: scraped {len(entries)} entries, start_time={start_time}")
        return ScrapeResult(entries=entries, start_time=start_time)

    except Exception as e:
        log.error(f"Race {race_no}: scrape error: {e}")
        return ScrapeResult(entries=[], start_time=None)
    finally:
        await page.close()


# Keep scrape_race as the public API — _do_scrape is internal


async def _extract_from_vuex(page: Page, race_no: int) -> List[BetEntryData]:
    """Try to pull liveBetList directly from the Vue app's Vuex store."""
    try:
        raw_list = await page.evaluate("""() => {
            try {
                const nuxtEl = document.getElementById('__nuxt');
                if (!nuxtEl) return null;
                const app = nuxtEl.__vue_app__;
                if (!app) return null;
                const store = app.config.globalProperties.$store;
                if (!store) return null;
                // Access the liveBet module state
                return store.state.liveBet || null;
            } catch(e) {
                return null;
            }
        }""")

        if not raw_list:
            return []

        # raw_list might be the state object; the data list is usually at .data
        bet_list = raw_list if isinstance(raw_list, list) else raw_list.get("data", [])
        if not bet_list:
            return []

        return _parse_vuex_entries(bet_list)

    except Exception as e:
        log.debug(f"Vuex extraction failed: {e}")
        return []


def _parse_vuex_entries(raw_list: list) -> List[BetEntryData]:
    entries = []
    for item in raw_list:
        try:
            bet_type = item.get("type", "win")
            horse_no1 = str(item.get("horseNo1", "")).strip()
            horse_no2 = str(item.get("horseNo2", "")).strip() if item.get("horseNo2") else None
            value_k = float(item.get("value", 0) or 0)
            amount = int(value_k * 1000)
            is_parlay = bool(item.get("parlay", False))

            # Parse snapshotTime
            snap_str = item.get("snapshotTime")
            snapshot_time = None
            if snap_str:
                try:
                    snapshot_time = datetime.fromisoformat(snap_str.replace("Z", "+00:00"))
                except Exception:
                    pass

            if horse_no1 and amount > 0:
                entries.append(BetEntryData(
                    horse_number=horse_no1,
                    horse_name=None,
                    bet_type=bet_type,
                    amount=amount,
                    is_parlay=is_parlay,
                    snapshot_time=snapshot_time,
                    horse_number_2=horse_no2,
                ))
        except Exception as e:
            log.debug(f"Skipping entry parse error: {e}")
    return entries


async def _extract_from_dom(page: Page, race_no: int) -> List[BetEntryData]:
    """Parse the rendered DOM for bet entries."""
    try:
        rows = await page.query_selector_all("div.grid.grid-cols-3.body-4")
        entries = []

        for row in rows:
            try:
                cols = await row.query_selector_all(":scope > div")
                if len(cols) < 3:
                    continue

                time_text = (await cols[0].inner_text()).strip()
                label_text = (await cols[1].inner_text()).strip()
                value_text = (await cols[2].inner_text()).strip()

                # Determine parlay from color class
                class_str = await row.get_attribute("class") or ""
                is_parlay = "#4900E5" in class_str or "4900E5" in class_str

                # Parse horse + type from label like "3W", "1-2Q", "5PLA", "1-2PQ"
                horse_no1, horse_no2, bet_type = _parse_label(label_text)

                # Parse amount: "45K" → 45000
                amount = _parse_amount(value_text)

                # Parse time
                snapshot_time = _parse_time(time_text)

                if horse_no1 and amount > 0:
                    entries.append(BetEntryData(
                        horse_number=horse_no1,
                        horse_name=None,
                        bet_type=bet_type,
                        amount=amount,
                        is_parlay=is_parlay,
                        snapshot_time=snapshot_time,
                        horse_number_2=horse_no2,
                    ))
            except Exception as e:
                log.debug(f"DOM row parse error: {e}")

        return entries

    except Exception as e:
        log.debug(f"DOM extraction failed: {e}")
        return []


async def _extract_start_time(page: Page, race_no: int) -> Optional[datetime]:
    """Extract 開跑時間 (race start time) from the Vuex store or DOM."""
    # Strategy 1: Vuex store
    try:
        raw = await page.evaluate("""() => {
            try {
                const nuxtEl = document.getElementById('__nuxt');
                if (!nuxtEl) return null;
                const app = nuxtEl.__vue_app__;
                if (!app) return null;
                const store = app.config.globalProperties.$store;
                if (!store) return null;
                const s = store.state;
                return s?.race?.startTime
                    || s?.raceInfo?.startTime
                    || s?.raceInfo?.raceStartTime
                    || s?.liveBet?.startTime
                    || s?.liveBet?.raceStartTime
                    || s?.odds?.startTime
                    || null;
            } catch(e) { return null; }
        }""")
        if raw:
            return _parse_start_time_str(str(raw))
    except Exception as e:
        log.debug(f"Vuex start_time extraction failed: {e}")

    # Strategy 2: DOM text — find "開跑時間" and grab the nearby time
    try:
        raw = await page.evaluate(r"""() => {
            const text = document.body.innerText || '';
            const m = text.match(/開跑時間[^\d]*(\d{1,2}:\d{2})/);
            if (m) return m[1];
            return null;
        }""")
        if raw:
            return _parse_start_time_str(str(raw))
    except Exception as e:
        log.debug(f"DOM start_time extraction failed: {e}")

    return None


def _parse_start_time_str(raw: str) -> Optional[datetime]:
    """Parse a time string like '14:30' or ISO into a HKT-aware datetime."""
    raw = raw.strip()
    # Try ISO first (already carries tz)
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        pass
    # HH:MM — interpret as today's HKT, regardless of server timezone
    try:
        t = datetime.strptime(raw, "%H:%M")
        now_hkt = datetime.now(_HKT)
        return now_hkt.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
    except Exception:
        pass
    return None


def _parse_label(label: str) -> Tuple[str, Optional[str], str]:
    """Parse labels like '3W', '5PLA', '1-2Q', '3-7PQ' into (horse1, horse2, type)."""
    label = label.strip()
    # Quinella place: "1-2PQ"
    m = re.match(r'^(\d+)-(\d+)PQ$', label)
    if m:
        return m.group(1), m.group(2), "place-quin"
    # Quinella: "1-2Q"
    m = re.match(r'^(\d+)-(\d+)Q$', label)
    if m:
        return m.group(1), m.group(2), "quin"
    # Place: "5PLA"
    m = re.match(r'^(\d+)PLA$', label)
    if m:
        return m.group(1), None, "place"
    # Win: "3W"
    m = re.match(r'^(\d+)W$', label)
    if m:
        return m.group(1), None, "win"
    # Fallback: just extract the number
    m = re.match(r'^(\d+)', label)
    if m:
        return m.group(1), None, "win"
    return label, None, "win"


def _parse_amount(value_str: str) -> int:
    """Parse '45K' or '45.5K' or '45,000' to integer HK$."""
    value_str = value_str.replace(",", "").strip()
    m = re.match(r'^([\d.]+)K?$', value_str, re.IGNORECASE)
    if m:
        val = float(m.group(1))
        if "K" in value_str.upper():
            return int(val * 1000)
        return int(val)
    return 0


def _parse_time(time_str: str) -> Optional[datetime]:
    """Parse 'HH:MM' into today's datetime."""
    try:
        t = datetime.strptime(time_str.strip(), "%H:%M")
        now = datetime.now()
        return now.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
    except Exception:
        return None

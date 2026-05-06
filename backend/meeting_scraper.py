"""
Meeting-wide scraper for the Trainer × Race grid.

Sources:
  • ma288 race card  → trainer / jockey / horse for every race in the meeting,
                       plus meeting date and venue from the page header.
  • stheadline odds_wp → win odds per horse → favourite (lowest 獨贏).
  • HKJC LocalResults  → top-3 finish positions (W = 1st, Q = 2nd/3rd).

Output is a single dict served via /api/meeting/trainer-grid.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, asdict
from typing import Optional
from urllib.parse import urlencode, urlparse, urlunparse, parse_qsl

from playwright.async_api import TimeoutError as PWTimeout

from . import scraper as _base_scraper
from . import source_config as _src_cfg

log = logging.getLogger(__name__)


# Limit concurrent ma288/stheadline/HKJC requests to keep things polite
_SEM = asyncio.Semaphore(4)

# Map ma288 venue text → HKJC racecourse code
_VENUE_TO_COURSE = {
    "沙田": "ST",
    "沙田夜馬": "ST",
    "跑馬地": "HV",
}

# Map ma288 simplified-Chinese venue → traditional / HKJC code
_VENUE_NORMALISE = {
    "沙田": ("沙田", "ST"),
    "跑馬地": ("跑馬地", "HV"),
}


@dataclass
class MeetingHorse:
    horse_no: int
    horse_name: str
    trainer: str
    jockey: str
    is_favorite: bool
    finish_position: Optional[int]   # 1/2/3 → W/Q, else None


@dataclass
class MeetingRace:
    race_no: int
    horses: list[dict]   # list of asdict(MeetingHorse)


@dataclass
class MeetingSummary:
    race_date: str        # ISO YYYY-MM-DD
    race_date_hkjc: str   # YYYY/MM/DD (HKJC format)
    racecourse: str       # ST | HV
    venue_name: str       # 沙田 | 跑馬地
    total_races: int
    races: list[dict]     # list of asdict(MeetingRace)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

async def _get_browser():
    if _base_scraper._browser is None:
        await _base_scraper.start_browser()
    return _base_scraper._browser


def _merge_qs(base: str, **extra: str) -> str:
    parts = urlparse(base)
    params = dict(parse_qsl(parts.query, keep_blank_values=True))
    params.update({k: str(v) for k, v in extra.items()})
    return urlunparse(parts._replace(query=urlencode(params)))


def _format_result_url(template: str, *, date_hkjc: str, course: str, raceno: int) -> str:
    """Substitute placeholders in the configured result URL template."""
    url = (template
        .replace("{date}", date_hkjc)
        .replace("{course}", course)
        .replace("{raceno}", str(raceno)))
    # Defensive: if template lacks placeholders, add them as query params
    if "{" in template and "}" in template and url == template:
        # Should not happen, but fall back
        url = _merge_qs(template, RaceDate=date_hkjc, Racecourse=course, RaceNo=raceno)
    return url


# ---------------------------------------------------------------------------
# 1. Meeting metadata + per-race horse list (ma288)
# ---------------------------------------------------------------------------

async def scrape_meeting_horses() -> Optional[MeetingSummary]:
    """
    Visit ma288 race card root, then iterate every race. Returns the meeting
    summary with horses (no favourite, no result yet — those are layered on later).
    """
    browser = await _get_browser()
    page = await browser.new_page()
    try:
        root = _src_cfg.get_url("race_card")
        await page.goto(root, wait_until="domcontentloaded", timeout=30_000)
        await page.wait_for_timeout(1200)

        meta = await page.evaluate(r"""() => {
            // Meeting date + venue from page header text
            const text = document.body.innerText;
            // Date: DD/MM/YYYY at start of a line
            const dm = text.match(/(\d{2})\/(\d{2})\/(\d{4})\s*([^\s\d第]{2,4})/);
            const venue = dm ? dm[4] : '';
            const dateDmy = dm ? `${dm[1]}/${dm[2]}/${dm[3]}` : '';
            // Race links
            const links = Array.from(document.querySelectorAll('a[href*="showRaceCard.do"]'))
              .filter(a => /^\d+$/.test(a.innerText.trim()))
              .map(a => ({ no: parseInt(a.innerText.trim()), href: a.href }));
            return { dateDmy, venue, links };
        }""")

        if not meta.get("links"):
            log.warning("meeting_scraper: no race links found on race card root")
            return None

        # Parse date
        dmy = meta["dateDmy"]
        if not re.match(r"^\d{2}/\d{2}/\d{4}$", dmy):
            log.warning("meeting_scraper: could not parse meeting date from header")
            return None
        d, m, y = dmy.split("/")
        race_date = f"{y}-{m}-{d}"
        race_date_hkjc = f"{y}/{m}/{d}"

        venue_raw = (meta.get("venue") or "").strip()
        # Normalise — ma288 may show simplified or traditional; pick traditional name
        venue_name = venue_raw
        for trad, simp in [("沙田", "沙田"), ("跑馬地", "跑马地")]:
            if simp in venue_raw or trad in venue_raw:
                venue_name = trad
                break
        course = _VENUE_TO_COURSE.get(venue_name, "ST")

        race_links = sorted(meta["links"], key=lambda l: l["no"])
        total = max(l["no"] for l in race_links)
        log.info(
            f"meeting_scraper: meeting {race_date} @ {venue_name} ({course}), "
            f"{total} races detected"
        )
    finally:
        await page.close()

    # Fetch each race in parallel (with semaphore limit)
    async def fetch_race(race_no: int, href: str) -> Optional[MeetingRace]:
        async with _SEM:
            p2 = await browser.new_page()
            try:
                await p2.goto(href, wait_until="domcontentloaded", timeout=30_000)
                await p2.wait_for_timeout(700)
                rows = await p2.evaluate("""() => {
                    const out = [];
                    const t = document.querySelector('table.raceCardTable');
                    if (!t) return out;
                    t.querySelectorAll('tbody tr').forEach(row => {
                        const tds = row.querySelectorAll('td');
                        if (tds.length < 11) return;
                        const horseNo = parseInt(tds[0].innerText.trim());
                        if (isNaN(horseNo) || horseNo <= 0) return;
                        out.push({
                            horse_no:   horseNo,
                            horse_name: tds[1].innerText.trim()
                                          .replace(/[+↓↑*\s]+$/g, '').trim(),
                            trainer:    tds[5].innerText.trim(),
                            jockey:     tds[6].innerText.trim()
                                          .replace(/\(.+\)$/, '').trim(),
                        });
                    });
                    return out;
                }""")
                horses = [
                    MeetingHorse(
                        horse_no=r["horse_no"],
                        horse_name=r["horse_name"],
                        trainer=r["trainer"],
                        jockey=r["jockey"],
                        is_favorite=False,
                        finish_position=None,
                    )
                    for r in rows
                ]
                return MeetingRace(race_no=race_no, horses=[asdict(h) for h in horses])
            except Exception as e:
                log.error(f"meeting_scraper: race {race_no} fetch failed: {e}")
                return None
            finally:
                await p2.close()

    race_results = await asyncio.gather(
        *[fetch_race(l["no"], l["href"]) for l in race_links]
    )
    races = [asdict(r) for r in race_results if r is not None]

    return MeetingSummary(
        race_date=race_date,
        race_date_hkjc=race_date_hkjc,
        racecourse=course,
        venue_name=venue_name,
        total_races=total,
        races=races,
    )


# ---------------------------------------------------------------------------
# 2. Favourite per race (stheadline odds_wp)
# ---------------------------------------------------------------------------

async def scrape_favorite(race_no: int) -> Optional[int]:
    """Return horse_no with the lowest 獨贏 odd, or None if not available."""
    browser = await _get_browser()
    base = _src_cfg.get_url("win_odds")
    url = _merge_qs(base, raceno=race_no, content_only2="true")

    async with _SEM:
        page = await browser.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=25_000)
            # Wait until at least one horse row is rendered (not just the empty <table>)
            try:
                await page.wait_for_function(
                    "() => { const t = document.querySelector('table.w-full.rounded');"
                    " return t && t.rows.length > 1"
                    " && (t.rows[1].cells[0]?.innerText || '').trim().length > 0; }",
                    timeout=15_000,
                )
            except PWTimeout:
                pass
            await page.wait_for_timeout(400)

            rows = await page.evaluate("""() => {
                const t = document.querySelector('table.w-full.rounded');
                if (!t) return [];
                return Array.from(t.rows).slice(1).map(r => {
                    const cells = Array.from(r.cells).map(c => c.innerText.trim());
                    return { horse: cells[0], win_odd: cells[3] };
                });
            }""")

            best_no, best_odd = None, float("inf")
            for r in rows:
                try:
                    hn = int(r["horse"])
                except (TypeError, ValueError):
                    continue
                # Skip scratched horses (often shown as "---" or "已退")
                raw = (r.get("win_odd") or "").strip()
                if not raw or raw in ("---", "—", "退"):
                    continue
                try:
                    odd = float(raw)
                except ValueError:
                    continue
                if odd > 0 and odd < best_odd:
                    best_no, best_odd = hn, odd
            return best_no
        except Exception as e:
            log.debug(f"meeting_scraper: favorite for race {race_no} failed: {e}")
            return None
        finally:
            await page.close()


# ---------------------------------------------------------------------------
# 3. Results per race (HKJC)
# ---------------------------------------------------------------------------

async def scrape_results(race_no: int, date_hkjc: str, course: str) -> dict[int, int]:
    """
    Return {horse_no: finish_position} for top-3 finishers, or {} if race
    has not been run yet (or page not available).
    """
    browser = await _get_browser()
    template = _src_cfg.get_url("race_result")
    url = _format_result_url(template, date_hkjc=date_hkjc, course=course, raceno=race_no)

    async with _SEM:
        page = await browser.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=25_000)
            await page.wait_for_timeout(800)

            payload = await page.evaluate("""() => {
                const text = document.body.innerText || '';
                // 賽事日期: DD/MM/YYYY — confirms HKJC actually served the page we asked for
                const dm = text.match(/賽事日期[^\\d]*(\\d{2}\\/\\d{2}\\/\\d{4})/);
                const pageDate = dm ? dm[1] : '';
                const tables = Array.from(document.querySelectorAll('table.draggable, table.f_tac'));
                let target = null;
                for (const t of tables) {
                    const hdr = t.rows[0]?.innerText || '';
                    if (hdr.includes('名次') && hdr.includes('馬號')) { target = t; break; }
                }
                const rows = target ? Array.from(target.rows).slice(1).map(r => {
                    const cells = Array.from(r.cells).map(c => c.innerText.trim());
                    return { pos: cells[0], horse: cells[1] };
                }) : [];
                return { pageDate, rows };
            }""")
            page_date = payload.get("pageDate") or ""
            # date_hkjc is YYYY/MM/DD; HKJC page shows DD/MM/YYYY
            y, m, d = date_hkjc.split("/")
            expected = f"{d}/{m}/{y}"
            if page_date and page_date != expected:
                # HKJC served a different meeting — treat as no results yet
                return {}
            rows = payload.get("rows") or []

            out: dict[int, int] = {}
            for r in rows:
                try:
                    pos = int(re.sub(r"\D", "", r["pos"] or ""))
                    hn  = int(re.sub(r"\D", "", r["horse"] or ""))
                except ValueError:
                    continue
                if pos in (1, 2, 3) and hn > 0:
                    out[hn] = pos
                if len(out) == 3:
                    break
            return out
        except Exception as e:
            log.debug(f"meeting_scraper: results for race {race_no} failed: {e}")
            return {}
        finally:
            await page.close()


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

async def scrape_trainer_grid() -> Optional[dict]:
    """
    Full pipeline: ma288 horses + stheadline favourites + HKJC results.
    Returns JSON-serialisable dict.
    """
    summary = await scrape_meeting_horses()
    if summary is None:
        return None

    race_nos = [r["race_no"] for r in summary.races]
    log.info(f"meeting_scraper: layering favourites + results for {len(race_nos)} races")

    favs, results = await asyncio.gather(
        asyncio.gather(*[scrape_favorite(n) for n in race_nos]),
        asyncio.gather(*[
            scrape_results(n, summary.race_date_hkjc, summary.racecourse)
            for n in race_nos
        ]),
    )

    fav_by_race    = dict(zip(race_nos, favs))
    result_by_race = dict(zip(race_nos, results))

    for race in summary.races:
        rn = race["race_no"]
        fav = fav_by_race.get(rn)
        res = result_by_race.get(rn) or {}
        for h in race["horses"]:
            if fav is not None and h["horse_no"] == fav:
                h["is_favorite"] = True
            pos = res.get(h["horse_no"])
            if pos:
                h["finish_position"] = pos

    return asdict(summary)

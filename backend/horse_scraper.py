"""
Horse info scraper for two sources:
1. ma288.com race card — horse list for a given race (馬號, 馬名, 烙號, 練馬師, 騎師, 近6次成績)
2. ma288.com horse profile — per-horse statistics (MA288評分, distanceSummary)

Uses the shared Playwright browser from scraper.py.
"""

import asyncio
import logging
from dataclasses import dataclass, asdict
from typing import Optional

from playwright.async_api import TimeoutError as PWTimeout

from . import scraper as _base_scraper  # access shared _browser
from . import source_config as _src_cfg

log = logging.getLogger(__name__)

# Limit concurrent ma288 page requests
_MA288_SEM = asyncio.Semaphore(3)

# URL accessors — read from source_config at call-time so edits take effect immediately
def _race_card_url() -> str:
    return _src_cfg.get_url("race_card")

def _horse_profile_url() -> str:
    return _src_cfg.get_url("horse_profile")

def _horse_fallback_url() -> str:
    return _src_cfg.get_url("horse_profile_fallback")

# Kept for the zh_CN result URL (not user-editable, derived from fallback base)
MA288_ZH_CN_RESULT = "https://www.ma288.com/has/zh_CN/horseinfo/searchHorse.do"

# JavaScript that extracts the required fields from a ma288 horse profile page.
# Works on BOTH zh_TW (traditional) and zh_CN (simplified) site versions
# because it matches by CSS class for distance/condition fields and uses
# flexible label matching for the horseinfo table.
_EXTRACT_JS = """() => {
    const result = { ma288_score: '', distance_summary_html: '' };

    // ── MA288評分 from table.horseinfo ────────────────────────────────
    const horseTable = document.querySelector('table.horseinfo');
    if (horseTable) {
        horseTable.querySelectorAll('tr').forEach(row => {
            const ths = row.querySelectorAll('th');
            const tds = row.querySelectorAll('td');
            ths.forEach((th, i) => {
                const label = th.innerText.trim();
                const val   = tds[i]
                    ? tds[i].innerText.replace(/^:\\s*/, '').trim()
                    : '';
                // Match both Traditional (評) and Simplified (评)
                if (label === 'MA288評分' || label === 'MA288评分')
                    result.ma288_score = val;
            });
        });
    }

    // ── Full distanceSummary table HTML ───────────────────────────────
    const distTable = document.querySelector('table.distanceSummary');
    if (distTable) {
        result.distance_summary_html = distTable.outerHTML;
    }

    return result;
}"""


@dataclass
class HorseInfoData:
    horse_no: int
    horse_name: str
    horse_code: Optional[str]
    barrier: str          # 檔位 — from race card
    trainer: str          # 練馬師 — from race card
    jockey: str           # 騎師   — from race card
    recent_results: str   # 近6次成績 — from race card
    ma288_score: str      # MA288評分 — from horse profile page
    distance_summary_html: str  # raw outerHTML of table.distanceSummary


def _empty_info(horse_no: int, horse_name: str, horse_code: Optional[str],
                barrier: str = "", trainer: str = "", jockey: str = "",
                recent_results: str = "") -> HorseInfoData:
    return HorseInfoData(
        horse_no=horse_no,
        horse_name=horse_name,
        horse_code=horse_code,
        barrier=barrier,
        trainer=trainer,
        jockey=jockey,
        recent_results=recent_results,
        ma288_score="",
        distance_summary_html="",
    )


async def _get_browser():
    if _base_scraper._browser is None:
        await _base_scraper.start_browser()
    return _base_scraper._browser


# ---------------------------------------------------------------------------
# ma288 race card: get horse list for a race
# ---------------------------------------------------------------------------

async def scrape_race_card_ma288(race_no: int) -> list[dict]:
    """
    Fetch today's race card from ma288.com for race_no.
    Returns [{"horse_no": 1, "horse_name": "…", "horse_code": "K392",
              "trainer": "…", "jockey": "…", "recent_results": "…"}, ...]

    Strategy:
      1. Load MA288_RACE_CARD_URL (no raceId) → redirects to today's race 1
      2. Find the nav link whose text == str(race_no)
      3. Navigate to that link
      4. Extract from table.raceCardTable:
           col 0 = 马号, col 1 = 马名, col 3 = 烙号,
           col 5 = 练马师, col 6 = 骑师, col 10 = 6次近绩
    """
    browser = await _get_browser()
    page = await browser.new_page()
    try:
        # Step 1: today's race 1 page
        await page.goto(_race_card_url(), wait_until="domcontentloaded", timeout=30_000)
        await page.wait_for_timeout(1000)

        # Step 2: find the link for the target race number
        race_url = await page.evaluate(f"""() => {{
            const links = Array.from(document.querySelectorAll('a[href*="showRaceCard.do"]'));
            const target = links.find(a => a.innerText.trim() === '{race_no}');
            return target ? target.href : null;
        }}""")

        if race_url:
            log.debug(f"Race card: navigating to {race_url}")
            await page.goto(race_url, wait_until="domcontentloaded", timeout=30_000)
            await page.wait_for_timeout(800)
        else:
            log.warning(f"Race {race_no}: nav link not found on race card page")

        # Step 3: extract from table.raceCardTable
        horses = await page.evaluate("""() => {
            const out = [];
            const table = document.querySelector('table.raceCardTable');
            if (!table) return out;

            // Find barrier (檔位) column by header text
            const headerCells = Array.from(
                table.querySelectorAll('thead th, thead td')
            );
            let barrierIdx = -1;
            headerCells.forEach((c, i) => {
                const t = c.innerText.trim();
                if (t.includes('檔') || t.includes('档') || t === '排位') {
                    barrierIdx = i;
                }
            });

            const rows = table.querySelectorAll('tbody tr');
            rows.forEach(row => {
                const tds = row.querySelectorAll('td');
                if (tds.length < 11) return;
                const horseNo = parseInt(tds[0].innerText.trim());
                if (isNaN(horseNo) || horseNo <= 0) return;
                const barrier = (barrierIdx >= 0 && tds[barrierIdx])
                    ? tds[barrierIdx].innerText.trim()
                    : '';
                out.push({
                    horse_no:       horseNo,
                    horse_name:     tds[1].innerText.trim(),
                    horse_code:     tds[3].innerText.trim() || null,
                    barrier:        barrier,
                    trainer:        tds[5].innerText.trim(),
                    jockey:         tds[6].innerText.trim(),
                    recent_results: tds[10].innerText.trim(),
                });
            });
            return out;
        }""")

        log.info(f"Race {race_no}: found {len(horses)} horses on ma288 race card")
        return horses if isinstance(horses, list) else []

    except Exception as e:
        log.error(f"Race {race_no}: race card scrape error: {e}")
        return []
    finally:
        await page.close()


# ---------------------------------------------------------------------------
# ma288.com: get per-horse stats
# ---------------------------------------------------------------------------

async def _search_by_name_zh_cn(page, horse_name: str, horse_code: Optional[str]) -> bool:
    """
    Fallback: search ma288 zh_CN site by horse name.
    Finds the correct result link (by code match, then by exact name, preferring
    non-retired horses), then navigates to that horse's profile page.
    Returns True if successfully navigated to a profile page, False otherwise.
    """
    try:
        await page.goto(_horse_fallback_url(), wait_until="domcontentloaded", timeout=20_000)

        # Fill and submit the 馬名 form (POST action: searchHorseByName.do)
        await page.evaluate(f"""() => {{
            const inputs = document.querySelectorAll('input[name="horseName"]');
            if (!inputs[0]) return;
            inputs[0].value = {repr(horse_name)};
            const form = inputs[0].closest('form');
            if (form) form.submit();
        }}""")

        await asyncio.sleep(1.5)  # wait for result page

        # Collect all horse result links with their text
        links = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('a[href*="horseId"]')).map(a => ({
                text: a.innerText.trim(),
                href: a.href
            })).filter(l => l.text && l.href);
        }""")

        if not links:
            log.debug(f"ma288 name search: no results for '{horse_name}'")
            return False

        # Match strategy:
        # 1. Exact name + brand code match (most reliable)
        # 2. Exact name match, non-retired
        # 3. Exact name match, retired
        target_url = None

        for link in links:
            # link.text format: "馬名\xa0(CODE)" or "馬名\xa0(CODE)\xa0(已退役)"
            parts = link["text"].replace("\xa0", " ").split("(")
            link_name = parts[0].strip()
            link_code = parts[1].rstrip(")").strip() if len(parts) > 1 else ""

            if link_name == horse_name:
                if horse_code and link_code.upper() == horse_code.upper():
                    # Best match: name + code
                    target_url = link["href"]
                    break
                if "(已退役)" not in link["text"] and target_url is None:
                    # Non-retired exact name match
                    target_url = link["href"]

        if not target_url:
            # Fallback: first exact name match (including retired)
            for link in links:
                link_name = link["text"].replace("\xa0", " ").split("(")[0].strip()
                if link_name == horse_name:
                    target_url = link["href"]
                    break

        if not target_url:
            log.debug(f"ma288 name search: no exact match for '{horse_name}'")
            return False

        log.debug(f"ma288 name search: navigating to {target_url}")
        await page.goto(target_url, wait_until="domcontentloaded", timeout=20_000)
        return await page.evaluate("() => !!document.querySelector('table.horseinfo')")

    except Exception as e:
        log.debug(f"ma288 name search fallback failed: {e}")
        return False


async def scrape_horse_ma288(
    horse_no: int,
    horse_name: str,
    horse_code: str,
    barrier: str = "",
    trainer: str = "",
    jockey: str = "",
    recent_results: str = "",
) -> HorseInfoData:
    """
    Scrape horse profile from ma288.com for MA288評分 and distanceSummary.
    trainer/jockey/recent_results are passed through from the race card.

    Primary: search by brand code (烙號) on zh_TW site.
    Fallback: if not found, search by horse name on zh_CN site.
    """
    async with _MA288_SEM:
        browser = await _get_browser()
        page = await browser.new_page()
        try:
            # ── Primary: search by brand code ─────────────────────────
            url = f"{_horse_profile_url()}?brandCode={horse_code}"
            log.debug(f"ma288: fetching {url}")
            await page.goto(url, wait_until="domcontentloaded", timeout=30_000)

            has_data = await page.evaluate(
                "() => !!document.querySelector('table.horseinfo')"
            )

            # ── Fallback: search by name on zh_CN site ─────────────────
            if not has_data:
                log.debug(
                    f"ma288: '{horse_name}' ({horse_code}) not found by brand code, "
                    f"trying name search"
                )
                has_data = await _search_by_name_zh_cn(page, horse_name, horse_code)

            if not has_data:
                log.debug(f"ma288: no data found for '{horse_name}' ({horse_code})")
                return _empty_info(horse_no, horse_name, horse_code, barrier, trainer, jockey, recent_results)

            # ── Extract profile data ───────────────────────────────────
            data = await page.evaluate(_EXTRACT_JS)

            return HorseInfoData(
                horse_no=horse_no,
                horse_name=horse_name,
                horse_code=horse_code,
                barrier=barrier,
                trainer=trainer,
                jockey=jockey,
                recent_results=recent_results,
                ma288_score=str(data.get("ma288_score", "") or ""),
                distance_summary_html=str(data.get("distance_summary_html", "") or ""),
            )

        except Exception as e:
            log.error(f"ma288: error scraping {horse_code}: {e}")
            return _empty_info(horse_no, horse_name, horse_code, barrier, trainer, jockey, recent_results)
        finally:
            await page.close()


# ---------------------------------------------------------------------------
# Full pipeline
# ---------------------------------------------------------------------------

async def scrape_all_horses(race_no: int) -> list[dict]:
    """
    Full pipeline:
      1. Scrape ma288 race card → horse list with 烙號, 練馬師, 騎師, 近6次成績
      2. For each horse, scrape ma288 profile → MA288評分 + distanceSummary
    Returns list of dicts (JSON-serialisable) sorted by horse_no.
    """
    horse_list = await scrape_race_card_ma288(race_no)
    if not horse_list:
        log.warning(f"Race {race_no}: no horses found on ma288 race card")
        return []

    log.info(f"Race {race_no}: got {len(horse_list)} horses, starting ma288 profile lookups")

    async def process_horse(h: dict) -> dict:
        h_no     = h.get("horse_no", 0)
        h_name   = h.get("horse_name", "")
        code     = h.get("horse_code") or ""
        barrier  = h.get("barrier", "")
        trainer  = h.get("trainer", "")
        jockey   = h.get("jockey", "")
        recent   = h.get("recent_results", "")

        if code:
            info = await scrape_horse_ma288(h_no, h_name, code, barrier, trainer, jockey, recent)
        else:
            log.warning(f"No 烙號 for '{h_name}' (horse #{h_no}), skipping profile")
            info = _empty_info(h_no, h_name, None, barrier, trainer, jockey, recent)
        return asdict(info)

    results = await asyncio.gather(
        *[process_horse(h) for h in horse_list],
        return_exceptions=True,
    )

    output = []
    for r in results:
        if isinstance(r, Exception):
            log.error(f"Horse scrape task error: {r}")
        else:
            output.append(r)

    output.sort(key=lambda x: x.get("horse_no", 0))
    log.info(f"Race {race_no}: completed horse info scrape, {len(output)} entries")
    return output

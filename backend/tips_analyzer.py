"""Combine all tipster picks for a meeting and correlate with live 大票房 data.

Each source's top-4 contributes weighted votes per horse:
    rank 1 → 4 pts,  rank 2 → 3 pts,  rank 3 → 2 pts,  rank 4 → 1 pt.

The output per race contains:
  • consensus top-4 (highest-voted horses + which sources picked them)
  • the key_pick consensus (highest "重心" pick across sources)
  • live 大票房 ranking by total bet amount, for cross-reference
"""

import logging
import os
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from typing import Dict, List

from sqlalchemy import select

from .database import AsyncSessionLocal
from .models import BetEntry
from .scheduler import _compute_aggregates
from . import horse_cache

_HKT = timezone(timedelta(hours=8))

log = logging.getLogger(__name__)

_POE_KEY = os.getenv("POE_API_KEY", "").strip()
_BASE_URL = os.getenv("POE_BASE_URL", "https://api.poe.com/v1")
_SUMMARY_MODEL = os.getenv("POE_SUMMARY_MODEL", "Claude-Sonnet-4.5")

# Results cache: meeting_date → (timestamp, {race_no: {pos: horse_no}})
import time
_RESULTS_TTL = 15 * 60   # 15 min — race results trickle in throughout race day
_results_cache: Dict[str, tuple] = {}


async def _get_meeting_results(meeting_date: str, force: bool = False) -> Dict[int, Dict[int, int]]:
    """Fetch HKJC top-3 finishers for every race of a meeting. Cached 15 min.
    Returns {race_no: {1: horse_no_1st, 2: horse_no_2nd, 3: horse_no_3rd}}.
    Tries ST course first, then HV, and stops once a course gives any result."""
    now = time.time()
    if not force:
        cached = _results_cache.get(meeting_date)
        if cached and (now - cached[0]) < _RESULTS_TTL:
            return cached[1]

    try:
        from .meeting_scraper import scrape_results
        y, m, d = meeting_date.split("-")
        date_hkjc = f"{y}/{m}/{d}"
    except Exception:
        return {}

    out: Dict[int, Dict[int, int]] = {}
    for course in ("ST", "HV"):
        course_results: Dict[int, Dict[int, int]] = {}
        for race_no in range(1, 13):
            try:
                r = await scrape_results(race_no, date_hkjc, course)
                if r:
                    # scrape_results returns {horse_no: position} — flip to {pos: horse_no}
                    by_pos = {pos: hn for hn, pos in r.items()}
                    course_results[race_no] = by_pos
            except Exception as e:
                log.debug(f"results {race_no} {course}: {e}")
        if course_results:
            out = course_results
            break

    _results_cache[meeting_date] = (now, out)
    return out


async def aggregate_per_race(per_source_extracted: Dict[str, dict], meeting_date: str = "") -> Dict[int, dict]:
    race_votes: Dict[int, Counter] = defaultdict(Counter)
    race_sources: Dict[int, Dict[int, List[str]]] = defaultdict(lambda: defaultdict(list))

    for filename, data in per_source_extracted.items():
        source = (data.get("source_name") or filename).strip() or filename
        races = data.get("races") or {}
        for race_no_str, info in races.items():
            try:
                rn = int(race_no_str)
            except (TypeError, ValueError):
                continue
            top4 = info.get("top4") or []
            for rank, hn in enumerate(top4[:4]):
                try:
                    hn_int = int(hn)
                except (TypeError, ValueError):
                    continue
                weight = max(1, 4 - rank)   # rank 0 → 4, rank 1 → 3, ...
                race_votes[rn][hn_int] += weight
                race_sources[rn][hn_int].append(source)
            # NOTE: the per-source `key_pick` field is intentionally ignored
            # for the displayed 重心. Sources don't agree on 重心, and showing
            # a 重心 that differs from the consensus top horse confuses the
            # user. 重心 is now derived from the consensus winner below.

    bet_rankings = await _get_bet_rankings(sorted(race_votes.keys()))
    meeting_results = (
        await _get_meeting_results(meeting_date) if meeting_date else {}
    )

    result: Dict[int, dict] = {}
    for rn in sorted(race_votes.keys()):
        top4 = []
        for hn, votes in race_votes[rn].most_common(4):
            top4.append({
                "horse_no": hn,
                "votes": votes,
                "sources": race_sources[rn][hn],
            })
        # 重心 = the single most-selected horse across all sources
        # (i.e. the same horse as top4[0]). Always agrees with the top of the
        # consensus ranking.
        key_consensus = None
        if top4:
            head = top4[0]
            key_consensus = {
                "horse_no": head["horse_no"],
                "votes": head["votes"],
                "source_count": len(head["sources"]),
            }
        # Race results — {pos: horse_no} for top-3 finishers if the race
        # has already been run; empty dict if results not yet published.
        race_results = meeting_results.get(rn, {})
        result[rn] = {
            "top4": top4,
            "key_pick_consensus": key_consensus,
            "bet_ranking": bet_rankings.get(rn, []),
            "total_sources": len(per_source_extracted),
            "results": {str(pos): hn for pos, hn in race_results.items()},
        }
    return result


async def _get_bet_rankings(race_nos: List[int]) -> Dict[int, List[dict]]:
    out: Dict[int, List[dict]] = {}
    if not race_nos:
        return out
    async with AsyncSessionLocal() as db:
        for rn in race_nos:
            res = await db.execute(select(BetEntry).where(BetEntry.race_no == rn))
            entries = res.scalars().all()
            if not entries:
                out[rn] = []
                continue
            aggs = _compute_aggregates(entries)
            singles = [a for a in aggs if "-" not in str(a["horse_number"])]
            singles.sort(
                key=lambda a: a["total_win_amount"] + a["total_place_amount"],
                reverse=True,
            )
            ranked = []
            for i, a in enumerate(singles):
                try:
                    hn = int(a["horse_number"])
                except ValueError:
                    continue
                ranked.append({
                    "rank": i + 1,
                    "horse_no": hn,
                    "total_bet": a["total_win_amount"] + a["total_place_amount"],
                })
            out[rn] = ranked
    return out


_TAG_RE = re.compile(r"<[^>]+>")


def _html_to_text(html: str) -> str:
    """Strip HTML tags from distance_summary_html → compact one-line text."""
    if not html:
        return ""
    text = _TAG_RE.sub(" ", html)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    text = " ".join(text.split())   # collapse all whitespace
    # Cap so the prompt stays compact
    return text[:280] + ("…" if len(text) > 280 else "")


def _horse_context_for(race_no: int, meeting_date: str, relevant: set[int]) -> str:
    """Build a per-horse data block from horse_cache. The cache is in-memory
    and reset on meeting-day rollover, so its contents always reflect TODAY's
    meeting. Only inject the data when the analysis is FOR today's meeting —
    historical-meeting analyses skip horse data (it wouldn't be the right
    field of horses anyway)."""
    today_hkt = datetime.now(_HKT).strftime("%Y-%m-%d")
    if meeting_date != today_hkt:
        return ""

    horses = horse_cache.get_horse_info(race_no) or []
    if not horses:
        return ""

    by_no = {int(h["horse_no"]): h for h in horses if h.get("horse_no") is not None}
    lines = []
    for hn in sorted(relevant):
        info = by_no.get(hn)
        if not info:
            continue
        name = info.get("horse_name") or ""
        barrier = info.get("barrier") or "—"
        trainer = info.get("trainer") or "—"
        jockey = info.get("jockey") or "—"
        ma288 = info.get("ma288_score") or "—"
        recent = info.get("recent_results") or "—"
        track = _html_to_text(info.get("distance_summary_html") or "")
        lines.append(
            f"  #{hn} {name} | 檔位 {barrier} | 練 {trainer} | 騎 {jockey} | "
            f"MA288 {ma288} | 近6 {recent} | 賽道 {track or '—'}"
        )
    return "\n".join(lines)


async def generate_summary(race_no: int, race_data: dict, meeting_date: str = "") -> str:
    """Generate a Traditional Chinese analyst summary for one race, citing
    concrete data (近6次成績, 賽道紀錄, 騎師/練馬師, MA288) where available."""
    top4 = race_data.get("top4") or []
    bet = race_data.get("bet_ranking") or []

    # Cheap fallback if no API key (or call fails) — still useful text.
    if not _POE_KEY or not top4:
        if top4:
            head = top4[0]
            tail = f"共 {len(head['sources'])} 個來源推介,得 {head['votes']} 票。"
            return f"R{race_no} 共識頭馬: #{head['horse_no']} ({tail})"
        return f"R{race_no} 暫無貼士數據。"

    try:
        from openai import AsyncOpenAI
    except ImportError:
        return ""

    bet_lines = "\n".join(
        f"  第{r['rank']}位: #{r['horse_no']} 馬 (總入飛 HK${r['total_bet']:,})"
        for r in bet[:4]
    ) or "  (暫無入飛數據)"
    tip_lines = "\n".join(
        f"  第{i + 1}位: #{h['horse_no']} 馬 — {h['votes']} 票 / {len(h['sources'])} 個來源"
        for i, h in enumerate(top4)
    )
    key = race_data.get("key_pick_consensus")
    key_line = (
        f"  共識重心: #{key['horse_no']} 馬 (得 {key['votes']} 票,獲 {key['source_count']} 個來源推介)"
        if key else "  (暫無重心共識)"
    )

    # Per-horse data for the horses we're going to discuss (consensus top-4 +
    # 大票房 top-4). Pulled live from horse_cache for the meeting being
    # analysed; empty string if not available (e.g. historical meeting).
    relevant: set[int] = set()
    for h in top4[:4]:
        try: relevant.add(int(h["horse_no"]))
        except (TypeError, ValueError): pass
    for r in bet[:4]:
        try: relevant.add(int(r["horse_no"]))
        except (TypeError, ValueError): pass
    horse_block = _horse_context_for(race_no, meeting_date, relevant)
    horse_section = (
        f"\n相關馬匹資料:\n{horse_block}\n"
        if horse_block
        else "\n(暫無馬匹詳細資料)\n"
    )

    prompt = f"""你係一位資深嘅香港賽馬分析員,專門寫貼士總結。請根據以下實際數據,
為第 {race_no} 場寫一段 3-5 句嘅繁體中文分析,**所有論點都要引用具體數據支持**。

第 {race_no} 場 — 合共 {race_data['total_sources']} 個貼士來源。

貼士共識排名 (按加權票數):
{tip_lines}
{key_line}

大票房入飛排名 (按總注額):
{bet_lines}
{horse_section}
寫作要求:
1. **開頭以「重心 #N 馬」起筆**,簡述呢匹馬點解係共識頭馬 (例:得幾多票、幾多個來源推介)。
2. 引用該馬嘅「近6次成績」、「賽道紀錄」、「騎師/練馬師」或「MA288評分」其中至少一兩項
   去解釋點解佢被睇好。例如「近6次有3-1-2」、「同條賽道贏過1場」、「莫雷拉策騎」等。
3. 對比貼士共識同大票房入飛排名,指出兩者一致定有分歧 (邊隻馬大票房高捧但貼士冷門,
   或者相反)。
4. 如果貼士排第2-4 嘅有冷門馬 (即大票房入飛唔入前4位),簡述潛在價值。
5. 全段唔好用 markdown,唔好用標題或前綴,純文字 3-5 句。
6. 語氣係專業分析員,可帶少少粵語口語,但要實牙實齒、有數據撐腰、唔好流於空泛。"""

    client = AsyncOpenAI(api_key=_POE_KEY, base_url=_BASE_URL)
    try:
        resp = await client.chat.completions.create(
            model=_SUMMARY_MODEL,
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as e:
        log.error(f"Summary generation failed for race {race_no}: {e}")
        return ""

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
from collections import Counter, defaultdict
from typing import Dict, List

from sqlalchemy import select

from .database import AsyncSessionLocal
from .models import BetEntry
from .scheduler import _compute_aggregates

log = logging.getLogger(__name__)

_POE_KEY = os.getenv("POE_API_KEY", "").strip()
_BASE_URL = os.getenv("POE_BASE_URL", "https://api.poe.com/v1")
_SUMMARY_MODEL = os.getenv("POE_SUMMARY_MODEL", "Claude-Sonnet-4.5")


async def aggregate_per_race(per_source_extracted: Dict[str, dict]) -> Dict[int, dict]:
    race_votes: Dict[int, Counter] = defaultdict(Counter)
    race_sources: Dict[int, Dict[int, List[str]]] = defaultdict(lambda: defaultdict(list))
    race_key_picks: Dict[int, Counter] = defaultdict(Counter)

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
            key = info.get("key_pick")
            if key is not None:
                try:
                    race_key_picks[rn][int(key)] += 1
                except (TypeError, ValueError):
                    pass

    bet_rankings = await _get_bet_rankings(sorted(race_votes.keys()))

    result: Dict[int, dict] = {}
    for rn in sorted(race_votes.keys()):
        top4 = []
        for hn, votes in race_votes[rn].most_common(4):
            top4.append({
                "horse_no": hn,
                "votes": votes,
                "sources": race_sources[rn][hn],
            })
        key_consensus = None
        if race_key_picks[rn]:
            hn, votes = race_key_picks[rn].most_common(1)[0]
            key_consensus = {"horse_no": hn, "votes": votes}
        result[rn] = {
            "top4": top4,
            "key_pick_consensus": key_consensus,
            "bet_ranking": bet_rankings.get(rn, []),
            "total_sources": len(per_source_extracted),
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


async def generate_summary(race_no: int, race_data: dict) -> str:
    """Generate a 2-3 sentence Traditional Chinese summary for one race."""
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
    key_line = f"  共識重心: #{key['horse_no']} 馬 ({key['votes']} 個來源)" if key else "  (無重心共識)"

    prompt = f"""你係香港賽馬分析員。請根據以下數據,用繁體中文寫一段 2-3 句的總結,適合放在貼士頁面。

第 {race_no} 場,合共 {race_data['total_sources']} 個貼士來源。

貼士共識排名 (按加權票數):
{tip_lines}
{key_line}

大票房入飛排名:
{bet_lines}

寫作要求:
- 指出共識頭馬 / 是否符合大票房排名
- 點出是否有「冷門」(貼士推介但大票房入飛不在前 4 位)
- 簡潔有力,口語化少少都得
- 只回覆總結文字,唔好包 markdown 標題或前綴"""

    client = AsyncOpenAI(api_key=_POE_KEY, base_url=_BASE_URL)
    try:
        resp = await client.chat.completions.create(
            model=_SUMMARY_MODEL,
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as e:
        log.error(f"Summary generation failed for race {race_no}: {e}")
        return ""

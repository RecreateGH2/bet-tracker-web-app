"""
In-memory cache for horse info data per race.
Thread-safe with asyncio — all access from the same event loop.
"""

from typing import Optional

# race_no → list of HorseInfoData dicts (plain dicts for JSON serialisation)
_cache: dict[int, list[dict]] = {}
_loading: set[int] = set()


def get_horse_info(race_no: int) -> Optional[list[dict]]:
    return _cache.get(race_no)


def set_horse_info(race_no: int, data: list[dict]) -> None:
    _cache[race_no] = data
    _loading.discard(race_no)


def is_loading(race_no: int) -> bool:
    return race_no in _loading


def start_loading(race_no: int) -> None:
    _loading.add(race_no)


def finish_loading(race_no: int) -> None:
    _loading.discard(race_no)


def clear_race(race_no: int) -> None:
    _cache.pop(race_no, None)
    _loading.discard(race_no)

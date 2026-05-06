"""TTL cache for the meeting trainer-grid summary."""

import time
from typing import Optional

_TTL_SECONDS = 60

_cache: Optional[dict] = None
_cached_at: float = 0.0
_loading: bool = False


def get() -> Optional[dict]:
    if _cache is None:
        return None
    if time.time() - _cached_at > _TTL_SECONDS:
        return None
    return _cache


def set(data: dict) -> None:
    global _cache, _cached_at, _loading
    _cache = data
    _cached_at = time.time()
    _loading = False


def clear() -> None:
    global _cache, _cached_at
    _cache = None
    _cached_at = 0.0


def is_loading() -> bool:
    return _loading


def start_loading() -> None:
    global _loading
    _loading = True


def finish_loading() -> None:
    global _loading
    _loading = False

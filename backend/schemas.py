from datetime import datetime
from typing import Literal, Optional, List
from pydantic import BaseModel


class BetEntryOut(BaseModel):
    horse_number: str
    horse_name: Optional[str]
    bet_type: str
    amount: int
    is_parlay: bool
    scraped_at: datetime

    model_config = {"from_attributes": True}


class HorseAggregate(BaseModel):
    horse_number: str
    horse_name: Optional[str]
    total_win_amount: int
    total_place_amount: int
    win_bet_count: int
    place_bet_count: int
    win_share_pct: float
    prev_win_share_pct: float
    pct_change: float


class SnapshotOut(BaseModel):
    id: int
    race_no: int
    scraped_at: datetime
    entry_count: int
    entries: List[BetEntryOut] = []

    model_config = {"from_attributes": True}


class ActiveRaceIn(BaseModel):
    race_no: int


class ActiveRaceOut(BaseModel):
    race_no: Optional[int]


class WebSocketMessage(BaseModel):
    type: Literal["snapshot", "status", "error", "race_changed"]
    race_no: Optional[int] = None
    scraped_at: Optional[datetime] = None
    snapshot_id: Optional[int] = None
    entry_count: Optional[int] = None
    message: Optional[str] = None
    entries: List[BetEntryOut] = []
    aggregates: List[HorseAggregate] = []

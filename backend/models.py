from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey, Index
)
from sqlalchemy.orm import relationship
from .database import Base


class Race(Base):
    __tablename__ = "races"

    id = Column(Integer, primary_key=True, autoincrement=True)
    race_no = Column(Integer, nullable=False, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_scraped_at = Column(DateTime, nullable=True)

    snapshots = relationship("Snapshot", back_populates="race", cascade="all, delete-orphan")


class Snapshot(Base):
    __tablename__ = "snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    race_id = Column(Integer, ForeignKey("races.id"), nullable=False)
    race_no = Column(Integer, nullable=False)
    scraped_at = Column(DateTime, nullable=False, index=True)
    raw_html_hash = Column(String(64), nullable=True)
    entry_count = Column(Integer, default=0)

    race = relationship("Race", back_populates="snapshots")
    entries = relationship("BetEntry", back_populates="snapshot", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_snapshots_race_time", "race_no", "scraped_at"),
    )


class BetEntry(Base):
    __tablename__ = "bet_entries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    snapshot_id = Column(Integer, ForeignKey("snapshots.id"), nullable=False)
    race_no = Column(Integer, nullable=False)
    horse_number = Column(String(4), nullable=False)
    horse_name = Column(String(100), nullable=True)
    bet_type = Column(String(20), nullable=False)  # win/place/quinella/quinella_place
    amount = Column(Integer, nullable=False)
    is_parlay = Column(Boolean, default=False)
    scraped_at = Column(DateTime, nullable=False)

    snapshot = relationship("Snapshot", back_populates="entries")

    __table_args__ = (
        Index("idx_bet_entries_race_time", "race_no", "scraped_at"),
    )

from pydantic_settings import BaseSettings
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent


class Settings(BaseSettings):
    database_url: str = f"sqlite+aiosqlite:///{BASE_DIR}/data/bets.db"
    scrape_interval_seconds: int = 30
    target_base_url: str = (
        "https://racing.stheadline.com/tc/odds_livebet/%E5%A4%A7%E7%A5%A8%E6%88%BF"
    )
    use_playwright_fallback: bool = False

    class Config:
        env_file = BASE_DIR / ".env"
        env_file_encoding = "utf-8"


settings = Settings()

"""Extract horse-tip picks from JPEGs via the Poe API (OpenAI-compatible).

Returns structured JSON per image:
  {
    "source_name": "Winson賽馬交流",
    "races": {
      "1": {"top4": [7, 5, 1, 9], "key_pick": 7},
      "2": {"top4": [2, 11, 10, 14], "key_pick": 2},
      ...
    }
  }

The Poe API speaks the OpenAI Chat Completions protocol at
https://api.poe.com/v1 so we can use the standard OpenAI SDK pointed at it.
Configurable model — defaults to Claude-Sonnet-4.5 (strong vision + Chinese).
"""

import base64
import json
import logging
import os
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

_POE_KEY = os.getenv("POE_API_KEY", "").strip()
_BASE_URL = os.getenv("POE_BASE_URL", "https://api.poe.com/v1")
_MODEL = os.getenv("POE_VISION_MODEL", "Claude-Sonnet-4.5")

_PROMPT = """You are analysing a Hong Kong horse-racing tipster's recommendation
post (馬王貼士). The image shows top picks for each race of a race meeting.

Extract these fields and return ONLY a single JSON object (no prose, no
markdown fences):

{
  "source_name": "<tipster page / username / column name visible in the image>",
  "races": {
    "<race_no as string>": {
      "top4": [<horse_no>, <horse_no>, <horse_no>, <horse_no>],
      "key_pick": <horse_no or null>
    }
  }
}

Rules:
- top4 holds **horse numbers only** (馬號, integers 1-14). The first entry is the
  strongest pick, the fourth is the weakest. Order matters.
- key_pick is the "重心" / "膽" / star pick if labelled; otherwise null.
- If a row uses circled digits (①②⑦⑪) or other glyphs, decode them to integers.
- If the image is a list with horse names like "8 神駒馬靈", use the LEADING
  number (8) as the horse_no.
- Race numbers may appear as "R1", "r1", "第1場", "第一場", or just a header
  "1". Always emit them as the integer (e.g. "1", "11").
- Omit any race that isn't clearly present in the image.
- If you can't read the image at all, return {"source_name": null, "races": {}}.
"""


def has_api_key() -> bool:
    return bool(_POE_KEY)


async def extract_from_image(image_path: Path) -> Optional[dict]:
    if not _POE_KEY:
        log.warning("POE_API_KEY not set — extraction skipped")
        return None
    try:
        from openai import AsyncOpenAI
    except ImportError:
        log.error("openai package not installed; pip install openai")
        return None

    try:
        image_data = image_path.read_bytes()
    except Exception as e:
        log.error(f"Could not read {image_path}: {e}")
        return None

    image_b64 = base64.standard_b64encode(image_data).decode("utf-8")
    suffix = image_path.suffix.lower()
    media_type = "image/png" if suffix == ".png" else "image/jpeg"
    data_url = f"data:{media_type};base64,{image_b64}"

    client = AsyncOpenAI(api_key=_POE_KEY, base_url=_BASE_URL)
    text = ""
    try:
        resp = await client.chat.completions.create(
            model=_MODEL,
            max_tokens=2000,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": _PROMPT},
                    ],
                }
            ],
        )
        text = (resp.choices[0].message.content or "").strip()
        # Strip ```json ... ``` fences if present
        if text.startswith("```"):
            text = text.lstrip("`")
            if text.lower().startswith("json"):
                text = text[4:]
            text = text.split("```")[0].strip()
        return json.loads(text)
    except json.JSONDecodeError as e:
        log.error(f"Could not parse extraction JSON for {image_path.name}: {e}; got: {text[:200]}")
        return None
    except Exception as e:
        log.error(f"Extraction failed for {image_path.name}: {e}")
        return None

"""The Event record passed between the scraper, the store and the frontend."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, asdict
from typing import Optional


def event_id(url: str, title: str, start: str) -> str:
    """Stable id for an event so manual tags survive re-scrapes."""
    basis = (url or "") + "|" + (title or "") + "|" + (start or "")
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]


@dataclass
class Event:
    id: str
    title: str
    url: str
    source: str
    description: str = ""
    start: str = ""            # ISO 8601 string as published
    end: str = ""
    image: str = ""
    address: str = ""
    locality: str = ""
    lat: Optional[float] = None
    lon: Optional[float] = None
    distance_km: Optional[float] = None
    permanent: bool = False    # a place you can visit anytime (no fixed date)
    category: str = ""         # e.g. "Museum", "Park" (mostly for permanent places)
    auto_tags: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)   # effective tags (auto + manual)

    def as_dict(self) -> dict:
        return asdict(self)

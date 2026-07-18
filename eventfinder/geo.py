"""Geocoding (OpenStreetMap / Nominatim) and distance helpers.

Nothing here needs an API key. Nominatim asks callers to send a descriptive
User-Agent and to stay under ~1 request/second, so we cache every lookup on
disk and throttle live calls.
"""
from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from typing import Optional

import requests

NOMINATIM_URL = "https://nominatim.openstreetmap.org"
# Nominatim's usage policy wants a real, identifying User-Agent.
USER_AGENT = "LocalEventsFinder/1.0 (self-hosted; https://github.com/TheRealDeltrex)"
_MIN_INTERVAL = 1.1  # seconds between live Nominatim calls

_lock = threading.Lock()
_last_call = 0.0


@dataclass
class Location:
    lat: float
    lon: float
    label: str = ""

    def as_dict(self) -> dict:
        return {"lat": self.lat, "lon": self.lon, "label": self.label}


def _throttle() -> None:
    """Block just long enough to respect Nominatim's rate limit."""
    global _last_call
    with _lock:
        wait = _MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()


def _request(path: str, params: dict) -> Optional[list | dict]:
    _throttle()
    try:
        resp = requests.get(
            f"{NOMINATIM_URL}/{path}",
            params=params,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en,de"},
            timeout=20,
        )
        resp.raise_for_status()
        return resp.json()
    except (requests.RequestException, ValueError):
        return None


def geocode(query: str, cache: Optional[dict] = None) -> Optional[Location]:
    """Turn a place name or address into coordinates. Cached by query string."""
    query = (query or "").strip()
    if not query:
        return None
    key = query.lower()
    if cache is not None and key in cache:
        hit = cache[key]
        return Location(**hit) if hit else None

    data = _request(
        "search", {"q": query, "format": "json", "limit": 1, "addressdetails": 0}
    )
    result: Optional[Location] = None
    if isinstance(data, list) and data:
        top = data[0]
        try:
            result = Location(
                lat=float(top["lat"]),
                lon=float(top["lon"]),
                label=top.get("display_name", query),
            )
        except (KeyError, ValueError, TypeError):
            result = None

    if cache is not None:
        cache[key] = result.as_dict() if result else None
    return result


def reverse(lat: float, lon: float) -> Optional[str]:
    """Human-readable label for a coordinate (used for device GPS)."""
    data = _request(
        "reverse", {"lat": lat, "lon": lon, "format": "json", "zoom": 14}
    )
    if isinstance(data, dict):
        return data.get("display_name")
    return None


def _city_from_address(addr: dict) -> str:
    for key in ("city", "town", "village", "municipality", "county", "state"):
        if addr.get(key):
            return addr[key]
    return ""


def resolve_search_location(
    query: Optional[str] = None,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
) -> Optional[dict]:
    """Resolve the *search* location from either a typed name or device GPS.

    Returns a dict with ``lat``, ``lon``, ``label``, ``city`` and ``cc``
    (ISO country code) — the last two are used to build source URLs.
    """
    if lat is not None and lon is not None:
        data = _request(
            "reverse", {"lat": lat, "lon": lon, "format": "json", "zoom": 14}
        )
        addr = data.get("address", {}) if isinstance(data, dict) else {}
        label = data.get("display_name", f"{lat:.4f}, {lon:.4f}") if isinstance(data, dict) else ""
        return {
            "lat": float(lat),
            "lon": float(lon),
            "label": label or f"{lat:.4f}, {lon:.4f}",
            "city": _city_from_address(addr),
            "cc": (addr.get("country_code") or "").lower(),
        }

    query = (query or "").strip()
    if not query:
        return None
    data = _request(
        "search",
        {"q": query, "format": "json", "limit": 1, "addressdetails": 1},
    )
    if not (isinstance(data, list) and data):
        return None
    top = data[0]
    addr = top.get("address", {})
    try:
        return {
            "lat": float(top["lat"]),
            "lon": float(top["lon"]),
            "label": top.get("display_name", query),
            "city": _city_from_address(addr) or query,
            "cc": (addr.get("country_code") or "").lower(),
        }
    except (KeyError, ValueError, TypeError):
        return None


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometres."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))

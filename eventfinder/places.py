"""Permanent 'things to do' from OpenStreetMap via the Overpass API.

Scraped event feeds only cover scheduled happenings, and in a given area there
may be few of those. This adds the places you can visit *any* day — museums,
parks, zoos, galleries, cinemas, castles and so on — so the finder always has
something to show within range. No API key needed.
"""
from __future__ import annotations

from typing import Optional

import requests

from . import geo
from .models import Event, event_id

# The public Overpass instances get overloaded and return 504/429; rotate
# through mirrors until one answers with valid JSON.
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

# OSM (key, value) -> (human label, tags). Drives both the query and tagging.
CATEGORIES: dict[tuple[str, str], tuple[str, list[str]]] = {
    ("tourism", "museum"): ("Museum", ["family"]),
    ("tourism", "gallery"): ("Gallery", ["date"]),
    ("tourism", "zoo"): ("Zoo", ["family"]),
    ("tourism", "theme_park"): ("Theme park", ["family"]),
    ("tourism", "aquarium"): ("Aquarium", ["family"]),
    ("tourism", "attraction"): ("Attraction", []),
    ("tourism", "viewpoint"): ("Viewpoint", ["date"]),
    ("tourism", "artwork"): ("Public art", ["date"]),
    ("leisure", "park"): ("Park", ["family"]),
    ("leisure", "garden"): ("Garden", ["date"]),
    ("leisure", "nature_reserve"): ("Nature reserve", []),
    ("leisure", "water_park"): ("Water park", ["family"]),
    ("amenity", "cinema"): ("Cinema", ["date"]),
    ("amenity", "theatre"): ("Theatre", ["date"]),
    ("amenity", "arts_centre"): ("Arts centre", ["date"]),
    ("historic", "castle"): ("Castle", ["date"]),
    ("historic", "monument"): ("Monument", []),
    ("historic", "memorial"): ("Memorial", []),
    ("historic", "ruins"): ("Ruins", ["date"]),
}


def _values(key: str) -> str:
    vals = [v for (k, v) in CATEGORIES if k == key]
    return "|".join(vals)


def build_query(lat: float, lon: float, radius_m: int) -> str:
    # Nodes only: point POIs resolve fast and reliably on the public servers;
    # querying ways/relations (nwr) forces geometry resolution and routinely
    # times out over a 40 km radius.
    clauses = []
    for key in ("tourism", "leisure", "amenity", "historic"):
        clauses.append(
            f'node(around:{radius_m},{lat},{lon})["{key}"~"^({_values(key)})$"];'
        )
    body = "".join(clauses)
    return f"[out:json][timeout:25];({body});out 80;"


def _category_of(tags: dict) -> Optional[tuple[str, list[str]]]:
    for key in ("tourism", "leisure", "amenity", "historic"):
        val = tags.get(key)
        if val and (key, val) in CATEGORIES:
            return CATEGORIES[(key, val)]
    return None


def fetch_places(lat: float, lon: float, radius_km: float, limit: int = 60) -> list[Event]:
    """Return named permanent places within radius, nearest first."""
    radius_m = int(radius_km * 1000)
    query = build_query(lat, lon, radius_m)
    elements = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            resp = requests.post(
                endpoint,
                data={"data": query},
                headers={"User-Agent": geo.USER_AGENT},
                timeout=40,
            )
            if resp.status_code != 200:
                continue
            elements = resp.json().get("elements", [])
            break
        except (requests.RequestException, ValueError):
            continue
    if elements is None:
        return []

    seen: set[str] = set()
    out: list[Event] = []
    for el in elements:
        tags = el.get("tags") or {}
        name = tags.get("name")
        if not name:
            continue
        cat = _category_of(tags)
        if not cat:
            continue
        label, cat_tags = cat
        plat = el.get("lat") or (el.get("center") or {}).get("lat")
        plon = el.get("lon") or (el.get("center") or {}).get("lon")
        if plat is None or plon is None:
            continue
        key = f"{name.lower()}|{label}"
        if key in seen:
            continue
        seen.add(key)
        osm_url = f"https://www.openstreetmap.org/{el.get('type')}/{el.get('id')}"
        website = tags.get("website") or tags.get("contact:website") or osm_url
        out.append(
            Event(
                id=event_id(osm_url, name, label),
                title=name,
                url=website,
                source="OpenStreetMap",
                description=label + (f" · {tags['tourism']}" if tags.get("tourism") else ""),
                permanent=True,
                category=label,
                locality=tags.get("addr:city", ""),
                lat=float(plat),
                lon=float(plon),
                auto_tags=list(cat_tags),
            )
        )
    return out[: max(limit, 0)] if limit else out

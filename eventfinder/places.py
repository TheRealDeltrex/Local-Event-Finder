"""Permanent 'things to do' from OpenStreetMap via the Overpass API.

Scraped event feeds only cover scheduled happenings, and in a given area there
may be few of those. This adds the places you can visit *any* day — museums,
parks, zoos, galleries, cinemas, castles and so on — so the finder always has
something to show within range. No API key needed.
"""
from __future__ import annotations

import concurrent.futures
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

# OSM key order to check, most specific first.
_KEYS = ("tourism", "leisure", "amenity", "historic", "natural")

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
    ("leisure", "miniature_golf"): ("Mini golf", ["family"]),
    ("leisure", "golf_course"): ("Golf course", []),
    ("leisure", "sports_centre"): ("Sports centre", ["family"]),
    ("leisure", "swimming_pool"): ("Swimming pool", ["family"]),
    ("leisure", "bathing_place"): ("Bathing spot", ["family"]),
    ("leisure", "horse_riding"): ("Horse riding", ["family"]),
    ("leisure", "playground"): ("Playground", ["family"]),
    ("leisure", "bird_hide"): ("Bird hide", ["date"]),
    ("amenity", "cinema"): ("Cinema", ["date"]),
    ("amenity", "theatre"): ("Theatre", ["date"]),
    ("amenity", "arts_centre"): ("Arts centre", ["date"]),
    ("amenity", "public_bath"): ("Swimming pool", ["family"]),
    ("historic", "castle"): ("Castle", ["date"]),
    ("historic", "monument"): ("Monument", []),
    ("historic", "memorial"): ("Memorial", []),
    ("historic", "ruins"): ("Ruins", ["date"]),
    ("natural", "beach"): ("Beach", ["family"]),
}


def _values(key: str) -> str:
    vals = [v for (k, v) in CATEGORIES if k == key]
    return "|".join(vals)


def build_query(lat: float, lon: float, radius_m: int) -> str:
    # nwr = nodes + ways + relations. Many attractions (parks, museums, the
    # Rømø labyrinth) are mapped as areas, not points, so a nodes-only query
    # misses them. `out center` gives each area a representative coordinate.
    clauses = []
    for key in _KEYS:
        clauses.append(
            f'nwr(around:{radius_m},{lat},{lon})["{key}"~"^({_values(key)})$"];'
        )
    body = "".join(clauses)
    # Output nodes, ways and relations *separately* — a single `out` emits all
    # nodes first, so a plain cap would exhaust its slots on nodes and drop
    # every area (the labyrinth is a way). Per-type caps guarantee areas appear.
    return (
        f"[out:json][timeout:60];({body})->.a;"
        f"node.a;out 300;way.a;out center 300;relation.a;out center 100;"
    )


def _category_of(tags: dict) -> Optional[tuple[str, list[str]]]:
    # Public swimming pools are mapped inconsistently (leisure=swimming_pool,
    # water_park, or sports_centre+sport=swimming, amenity=public_bath). Detect
    # any of them and label clearly as "Swimming pool".
    sport = (tags.get("sport") or "").lower()
    if (
        "swimming" in sport
        or tags.get("leisure") in ("swimming_pool", "water_park")
        or tags.get("amenity") == "public_bath"
    ):
        return ("Swimming pool", ["family"])
    for key in _KEYS:
        val = tags.get(key)
        if val and (key, val) in CATEGORIES:
            return CATEGORIES[(key, val)]
    return None


def _query_one(endpoint: str, query: str) -> Optional[list]:
    try:
        resp = requests.post(
            endpoint,
            data={"data": query},
            headers={"User-Agent": geo.USER_AGENT},
            timeout=55,
        )
        if resp.status_code == 200:
            return resp.json().get("elements", [])
    except (requests.RequestException, ValueError):
        return None
    return None


def run_overpass(query: str) -> Optional[list]:
    """Run an Overpass query against all mirrors in parallel, returning the
    elements from the first that answers (or None)."""
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=len(OVERPASS_ENDPOINTS))
    futures = [executor.submit(_query_one, ep, query) for ep in OVERPASS_ENDPOINTS]
    try:
        for fut in concurrent.futures.as_completed(futures):
            res = fut.result()
            if res is not None:
                return res
    finally:
        executor.shutdown(wait=False)  # don't block on the losing mirrors
    return None


def nearby_localities(lat: float, lon: float, radius_km: float, limit: int = 8) -> list[str]:
    """Nearest named towns/cities within the radius — used to look up events in
    neighbouring places, not just the origin's own (which may have none)."""
    radius_m = int(radius_km * 1000)
    # `out` (body) gives coordinates + tags for nodes; `out tags` omits coords.
    query = (
        f'[out:json][timeout:40];'
        f'(node(around:{radius_m},{lat},{lon})[place~"^(city|town)$"];);out 200;'
    )
    elements = run_overpass(query) or []
    scored: list[tuple[float, str]] = []
    for el in elements:
        name = (el.get("tags") or {}).get("name")
        plat, plon = el.get("lat"), el.get("lon")
        if name and plat is not None and plon is not None:
            scored.append((geo.haversine_km(lat, lon, plat, plon), name))
    scored.sort()
    seen: set[str] = set()
    names: list[str] = []
    for _, name in scored:
        key = name.lower()
        if key not in seen:
            seen.add(key)
            names.append(name)
    return names[:limit]


def fetch_places(lat: float, lon: float, radius_km: float, limit: int = 120) -> list[Event]:
    """Return named permanent places within radius.

    The public Overpass servers are individually slow and unreliable, so we
    hit all mirrors in parallel and take the first that answers — bounding the
    wait to the fastest server instead of the sum of their timeouts.
    """
    radius_m = int(radius_km * 1000)
    elements = run_overpass(build_query(lat, lon, radius_m))
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
        # Dedupe by name + coarse location (~1 km) so a facility mapped twice
        # (e.g. the pool basin and the building) collapses into one result.
        key = f"{name.lower()}|{round(float(plat), 2)}|{round(float(plon), 2)}"
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
                description=label,
                permanent=True,
                category=label,
                locality=tags.get("addr:city", ""),
                lat=float(plat),
                lon=float(plon),
                hours=tags.get("opening_hours", ""),
                auto_tags=list(cat_tags),
            )
        )
    # Overpass returns by id, not distance; keep the nearest `limit` so a close
    # place (e.g. the labyrinth around the corner) is never truncated away.
    out.sort(key=lambda e: geo.haversine_km(lat, lon, e.lat, e.lon))
    return out[: max(limit, 0)] if limit else out

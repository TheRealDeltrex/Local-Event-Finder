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

from . import geo, tagging
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

# OSM (key, value) -> (human label, type, kid friendly). Drives both the query
# and tagging. "Kid friendly" is only for places actually aimed at children —
# a park is fine for kids but isn't *for* kids, a playground is.
CATEGORIES: dict[tuple[str, str], tuple[str, str, bool]] = {
    ("tourism", "museum"): ("Museum", "museum", False),
    ("tourism", "gallery"): ("Gallery", "art", False),
    ("tourism", "zoo"): ("Zoo", "animals", True),
    ("tourism", "theme_park"): ("Theme park", "attraction", True),
    ("tourism", "aquarium"): ("Aquarium", "animals", True),
    ("tourism", "attraction"): ("Attraction", "attraction", False),
    ("tourism", "viewpoint"): ("Viewpoint", "park", False),
    ("tourism", "artwork"): ("Public art", "art", False),
    ("leisure", "park"): ("Park", "park", False),
    ("leisure", "garden"): ("Garden", "park", False),
    ("leisure", "nature_reserve"): ("Nature reserve", "park", False),
    ("leisure", "water_park"): ("Water park", "water", True),
    ("leisure", "miniature_golf"): ("Mini golf", "attraction", False),
    ("leisure", "golf_course"): ("Golf course", "sport", False),
    ("leisure", "sports_centre"): ("Sports centre", "sport", False),
    ("leisure", "swimming_pool"): ("Swimming pool", "water", False),
    ("leisure", "bathing_place"): ("Bathing spot", "water", False),
    ("leisure", "horse_riding"): ("Horse riding", "sport", False),
    ("leisure", "playground"): ("Playground", "play", True),
    ("leisure", "bird_hide"): ("Bird hide", "park", False),
    ("amenity", "cinema"): ("Cinema", "film", False),
    ("amenity", "theatre"): ("Theatre", "theatre", False),
    ("amenity", "arts_centre"): ("Arts centre", "art", False),
    ("amenity", "public_bath"): ("Swimming pool", "water", False),
    ("historic", "castle"): ("Castle", "museum", False),
    ("historic", "monument"): ("Monument", "museum", False),
    ("historic", "memorial"): ("Memorial", "museum", False),
    ("historic", "ruins"): ("Ruins", "museum", False),
    ("natural", "beach"): ("Beach", "water", False),
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


def _category_of(tags: dict) -> Optional[tuple[str, str, bool]]:
    # Public swimming pools are mapped inconsistently (leisure=swimming_pool,
    # sports_centre+sport=swimming, amenity=public_bath). Detect any of them and
    # label clearly as "Swimming pool". Water parks keep their own label because
    # they are aimed at kids.
    if tags.get("leisure") == "water_park":
        return CATEGORIES[("leisure", "water_park")]
    sport = (tags.get("sport") or "").lower()
    if (
        "swimming" in sport
        or tags.get("leisure") == "swimming_pool"
        or tags.get("amenity") == "public_bath"
    ):
        return ("Swimming pool", "water", False)
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
        label, place_type, kids = cat
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
                type=place_type,
                auto_tags=[tagging.TAG_KIDS] if kids else [],
            )
        )
    # Overpass returns by id, not distance; keep the nearest `limit` so a close
    # place (e.g. the labyrinth around the corner) is never truncated away.
    out.sort(key=lambda e: geo.haversine_km(lat, lon, e.lat, e.lon))
    return out[: max(limit, 0)] if limit else out

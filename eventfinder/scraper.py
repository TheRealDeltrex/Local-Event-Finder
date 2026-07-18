"""The scraping pipeline.

Rather than screen-scraping one site's fragile HTML, we pull the structured
schema.org ``Event`` data (JSON-LD) that most event sites already embed for
search engines. That makes the same extractor work across Meetup, Eventbrite,
venue and city-tourism pages — you just point it at more source URLs.

Pipeline:  fetch source pages -> extract Event JSON-LD -> geocode each venue
-> compute distance from the user -> drop anything past the range -> tag.
"""
from __future__ import annotations

import html
import json
from typing import Iterable, Optional
from urllib.parse import quote

import requests
from bs4 import BeautifulSoup

from . import geo, tagging
from .models import Event, event_id

BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0 Safari/537.36"
)


# --------------------------------------------------------------------------
# JSON-LD extraction
# --------------------------------------------------------------------------
def _iter_ld_nodes(data) -> Iterable[dict]:
    """Yield every dict node in a JSON-LD payload, unwrapping @graph/lists."""
    stack = [data]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(node)
        elif isinstance(node, dict):
            if "@graph" in node and isinstance(node["@graph"], list):
                stack.extend(node["@graph"])
            yield node


def _is_event(node: dict) -> bool:
    t = node.get("@type", "")
    types = t if isinstance(t, list) else [t]
    return any("Event" in str(x) for x in types)


def _first(value):
    return value[0] if isinstance(value, list) and value else value


def _text(value) -> str:
    value = _first(value)
    if isinstance(value, dict):
        value = value.get("name") or value.get("url") or ""
    if not isinstance(value, str):
        return ""
    return html.unescape(value).strip()


def _location_fields(node: dict) -> tuple[str, str, Optional[float], Optional[float]]:
    """Return (address, locality, lat, lon) from an Event's location, if physical."""
    loc = _first(node.get("location"))
    if not isinstance(loc, dict):
        return "", "", None, None
    if "Virtual" in str(loc.get("@type", "")):
        return "", "", None, None  # online-only event, skip

    lat = lon = None
    geo_node = loc.get("geo")
    if isinstance(geo_node, dict):
        try:
            lat = float(geo_node["latitude"])
            lon = float(geo_node["longitude"])
        except (KeyError, ValueError, TypeError):
            lat = lon = None

    addr = loc.get("address")
    locality = ""
    parts: list[str] = []
    if isinstance(addr, dict):
        locality = addr.get("addressLocality", "") or ""
        for key in ("streetAddress", "addressLocality", "postalCode", "addressCountry"):
            val = addr.get(key)
            if val and val not in parts:
                parts.append(str(val))
    elif isinstance(addr, str):
        parts.append(addr)

    name = loc.get("name", "")
    address = ", ".join(p for p in ([name] if name else []) + parts if p)
    return html.unescape(address), html.unescape(locality), lat, lon


def extract_events(html: str, source_name: str) -> list[Event]:
    soup = BeautifulSoup(html, "lxml")
    events: list[Event] = []
    seen: set[str] = set()
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = tag.string or tag.get_text() or ""
        raw = raw.strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        for node in _iter_ld_nodes(data):
            if not _is_event(node):
                continue
            title = _text(node.get("name"))
            url = _text(node.get("url"))
            start = _text(node.get("startDate"))
            if not title:
                continue
            eid = event_id(url, title, start)
            if eid in seen:
                continue
            seen.add(eid)
            address, locality, lat, lon = _location_fields(node)
            description = _text(node.get("description"))
            events.append(
                Event(
                    id=eid,
                    title=title,
                    url=url,
                    source=source_name,
                    description=description,
                    start=start,
                    end=_text(node.get("endDate")),
                    image=_text(node.get("image")),
                    address=address,
                    locality=locality,
                    lat=lat,
                    lon=lon,
                    auto_tags=tagging.auto_tags(title, description),
                )
            )
    return events


# --------------------------------------------------------------------------
# Source fetching
# --------------------------------------------------------------------------
def build_source_url(template: str, place: dict) -> str:
    city = (place.get("city") or place.get("label", "").split(",")[0]).strip()
    # allevents-style slugs want a lowercased, hyphenated city.
    city_slug = quote(city.lower().replace(" ", "-"))
    return template.format(
        city=quote(city),
        city_lower=city_slug,
        cc=quote((place.get("cc") or "").strip()),
        label=quote(place.get("label", "")),
    )


def fetch(url: str) -> Optional[str]:
    try:
        resp = requests.get(
            url,
            headers={"User-Agent": BROWSER_UA, "Accept-Language": "en,de"},
            timeout=25,
        )
        if resp.status_code == 200:
            return resp.text
    except requests.RequestException:
        return None
    return None


# --------------------------------------------------------------------------
# Full run
# --------------------------------------------------------------------------
def _apply_manual(ev: Event, overrides: dict) -> None:
    """Combine auto tags with the user's manual add/remove for this event."""
    tags = set(ev.auto_tags)
    entry = overrides.get(ev.id)
    if entry:
        tags.update(entry.get("add", []))
        tags.difference_update(entry.get("remove", []))
    ev.tags = sorted(tags)


def run_search(
    place: dict,
    sources: list[dict],
    range_km: float,
    store,
    log: Optional[list] = None,
) -> list[Event]:
    """Scrape all enabled sources and return events within ``range_km``."""
    log = log if log is not None else []
    geocode_cache = store.load_geocode_cache()
    manual = store.load_manual_tags()
    origin_lat, origin_lon = place["lat"], place["lon"]

    collected: dict[str, Event] = {}
    for src in sources:
        if not src.get("enabled", True):
            continue
        url = build_source_url(src["url"], place)
        html = fetch(url)
        if html is None:
            log.append(f"{src['name']}: could not fetch {url}")
            continue
        found = extract_events(html, src["name"])
        log.append(f"{src['name']}: {len(found)} event(s) with structured data")
        for ev in found:
            collected.setdefault(ev.id, ev)

    results: list[Event] = []
    for ev in collected.values():
        # Geocode the venue if the feed didn't already carry coordinates.
        if ev.lat is None or ev.lon is None:
            query = ev.address or ev.locality
            if not query:
                continue
            loc = geo.geocode(query, cache=geocode_cache)
            if loc is None:
                continue
            ev.lat, ev.lon = loc.lat, loc.lon
        ev.distance_km = round(
            geo.haversine_km(origin_lat, origin_lon, ev.lat, ev.lon), 1
        )
        if ev.distance_km > range_km:
            continue
        _apply_manual(ev, manual)
        results.append(ev)

    store.save_geocode_cache(geocode_cache)
    results.sort(key=lambda e: (e.start or "9999", e.distance_km or 0))
    log.append(f"{len(results)} event(s) within {range_km:g} km")
    return results

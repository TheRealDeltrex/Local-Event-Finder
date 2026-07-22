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
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional
from urllib.parse import quote

import requests
from bs4 import BeautifulSoup

from . import geo, tagging
from .places import fetch_places
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
def build_source_url(template: str, place: dict, city_lower_override: Optional[str] = None) -> str:
    city = (place.get("city") or place.get("label", "").split(",")[0]).strip()
    # allevents-style slugs want a lowercased, hyphenated city.
    city_slug = quote(city_lower_override) if city_lower_override else quote(city.lower().replace(" ", "-"))
    return template.format(
        city=quote(city),
        city_lower=city_slug,
        cc=quote((place.get("cc") or "").strip()),
        label=quote(place.get("label", "")),
    )


def _strip_diacritics(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)
    )


def city_slug_candidates(place: dict) -> list[str]:
    """Ordered slug guesses for a city — event sites localize names badly
    (Nominatim gives "Hanover", but AllEvents wants "hannover"; "München" must
    become "munich", not "muenchen"). We try the local name, an ASCII-folded
    version, and the English name, and let the caller pick by proximity."""
    names = [n for n in (place.get("city_local"), place.get("city")) if n]
    if not names and place.get("label"):
        names = [place["label"].split(",")[0]]
    out: list[str] = []
    for name in names:
        base = name.strip().lower().replace(" ", "-")
        for slug in (base, _strip_diacritics(base)):
            if slug and slug not in out:
                out.append(slug)
    return out


def resolve_allevents_slug(
    place: dict, origin_lat: float, origin_lon: float, range_km: float
) -> tuple[Optional[str], Optional[str]]:
    """Pick the AllEvents city slug whose /all events are actually near the
    origin. Returns (slug, cached_all_html) so the winning page can be reused."""
    first: tuple[Optional[str], Optional[str]] = (None, None)
    for slug in city_slug_candidates(place):
        html = fetch(f"https://allevents.in/{quote(slug)}/all")
        if first[0] is None:
            first = (slug, html)
        if not html:
            continue
        events = extract_events(html, "AllEvents")
        if any(
            e.lat is not None
            and geo.haversine_km(origin_lat, origin_lon, e.lat, e.lon) <= range_km
            for e in events
        ):
            return slug, html
    return first


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


def _parse_start(start: str) -> Optional[datetime]:
    """Parse an ISO-8601 start string to an aware datetime, or None."""
    if not start:
        return None
    s = start.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        # try just the date part, e.g. "2026-07-22"
        try:
            dt = datetime.fromisoformat(s[:10])
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _within_window(dt: Optional[datetime], now: datetime, days: int) -> Optional[bool]:
    """True if within the window, False if outside, None if undated."""
    if dt is None:
        return None
    return (now - timedelta(days=1)) <= dt <= (now + timedelta(days=days))


def run_search(
    place: dict,
    sources: list[dict],
    range_km: float,
    store,
    log: Optional[list] = None,
    window_days: int = 365,
    include_places: bool = True,
) -> list[Event]:
    """Find things to do within ``range_km``: scheduled events happening in the
    next ``window_days`` days (plus undated/recurring listings), and permanent
    places you can visit any day (museums, parks, …)."""
    log = log if log is not None else []
    geocode_cache = store.load_geocode_cache()
    manual = store.load_manual_tags()
    origin_lat, origin_lon = place["lat"], place["lon"]
    now = datetime.now(timezone.utc)

    # Work out which AllEvents city slug actually returns local events (city
    # names localize inconsistently), reusing the winning /all page.
    enabled = [s for s in sources if s.get("enabled", True)]
    has_allevents = any("allevents.in" in s.get("url", "") for s in enabled)
    ae_slug: Optional[str] = None
    ae_all_html: Optional[str] = None
    if has_allevents:
        ae_slug, ae_all_html = resolve_allevents_slug(place, origin_lat, origin_lon, range_km)
        if ae_slug:
            log.append(f"AllEvents city slug: {ae_slug}")

    # Fetch sources sequentially: AllEvents returns a degraded, IP-geolocated
    # response when hit with concurrent requests, so we must not parallelize.
    collected: dict[str, Event] = {}
    for src in enabled:
        is_allevents = "allevents.in" in src.get("url", "")
        # Reuse the /all page we already fetched while picking the slug.
        if is_allevents and src["url"].endswith("/all") and ae_all_html is not None:
            html = ae_all_html
        else:
            url = build_source_url(
                src["url"], place, city_lower_override=ae_slug if is_allevents else None
            )
            html = fetch(url)
        if html is None:
            log.append(f"{src['name']}: could not fetch")
            continue
        found = extract_events(html, src["name"])
        log.append(f"{src['name']}: {len(found)} event(s) with structured data")
        for ev in found:
            collected.setdefault(ev.id, ev)

    results: list[Event] = []
    dropped_old = 0
    for ev in collected.values():
        # Only keep events happening within the next week (undated listings,
        # which are often recurring, are kept and shown without a date).
        in_window = _within_window(_parse_start(ev.start), now, window_days)
        if in_window is False:
            dropped_old += 1
            continue
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
        ev.direction = (
            geo.compass16(origin_lat, origin_lon, ev.lat, ev.lon)
            if ev.distance_km > 0 else ""
        )
        _apply_manual(ev, manual)
        results.append(ev)
    store.save_geocode_cache(geocode_cache)
    if dropped_old:
        log.append(f"skipped {dropped_old} event(s) outside the next {window_days} days")

    # Permanent places (museums, parks, galleries, …) you can visit any day.
    if include_places:
        places = fetch_places(origin_lat, origin_lon, range_km)
        added = 0
        for ev in places:
            if ev.id in {e.id for e in results}:
                continue
            ev.distance_km = round(
                geo.haversine_km(origin_lat, origin_lon, ev.lat, ev.lon), 1
            )
            if ev.distance_km > range_km:
                continue
            ev.direction = (
                geo.compass16(origin_lat, origin_lon, ev.lat, ev.lon)
                if ev.distance_km > 0 else ""
            )
            _apply_manual(ev, manual)
            results.append(ev)
            added += 1
        log.append(f"{added} permanent place(s) from OpenStreetMap")

    # Upcoming dated events first (by date), then undated events, then permanent
    # places (nearest first).
    def sort_key(e: Event):
        if e.permanent:
            return (2, e.distance_km or 0.0, "")
        dt = _parse_start(e.start)
        if dt is None:
            return (1, e.distance_km or 0.0, "")
        return (0, dt.timestamp(), "")

    results.sort(key=sort_key)
    log.append(f"{len(results)} thing(s) to do within {range_km:g} km")
    return results

"""Auto-tagging heuristics.

Every result gets exactly one **type** (music, park, theatre, …, or
``unknown`` when nothing fits) and, separately, may get the **kid friendly**
tag when it is actually aimed at children (a playground or a puppet show, not
just any park).

* Events are typed from their schema.org ``@type`` (``MusicEvent`` …) when the
  site says something specific, then from keywords in the title, then from the
  feed they came from (AllEvents · Music …), then from keywords in the
  description.
* Permanent places get their type and kid-friendliness from their OpenStreetMap
  category (see ``places.CATEGORIES``).

The user can turn the kid friendly tag on or off by hand; those manual choices
are stored separately and win over the guess (see ``store`` / ``scraper``).

These tables are mirrored in the Android app (``Tagging.kt``) and the browser
version (``docs/webapp.js``); ``scripts/check_parity.py`` keeps them in step.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

TAG_KIDS = "kids"
ALL_TAGS = (TAG_KIDS,)
TAG_LABELS = {TAG_KIDS: "Kid friendly"}

TYPE_UNKNOWN = "unknown"

# (key, label, colour). Order is the order of the filter chips.
TYPES = [
    ("music", "Music", "#8e24aa"),
    ("theatre", "Theatre & shows", "#c62828"),
    ("comedy", "Comedy", "#ef6c00"),
    ("film", "Film", "#455a64"),
    ("art", "Art", "#d81b60"),
    ("museum", "Museum & history", "#6d4c41"),
    ("park", "Park & nature", "#2e7d32"),
    ("water", "Swimming & beach", "#0288d1"),
    ("animals", "Zoo & animals", "#00897b"),
    ("sport", "Sport", "#3949ab"),
    ("play", "Playground", "#f4511e"),
    ("attraction", "Attraction", "#c0a000"),
    ("food", "Food & drink", "#a1541b"),
    ("nightlife", "Nightlife", "#5e35b1"),
    ("festival", "Festival & market", "#e91e63"),
    ("workshop", "Class & talk", "#00838f"),
    ("community", "Meetup & social", "#607d8b"),
    ("unknown", "Unknown", "#757575"),
]
TYPE_KEYS = [k for k, _, _ in TYPES]
TYPE_LABELS = {k: label for k, label, _ in TYPES}
TYPE_COLORS = {k: colour for k, _, colour in TYPES}

# schema.org event @type -> our type. Plain "Event" says nothing and is skipped.
LD_TYPES = {
    "MusicEvent": "music",
    "TheaterEvent": "theatre",
    "DanceEvent": "theatre",
    "ComedyEvent": "comedy",
    "ScreeningEvent": "film",
    "VisualArtsEvent": "art",
    "ExhibitionEvent": "art",
    "SportsEvent": "sport",
    "FoodEvent": "food",
    "Festival": "festival",
    "SaleEvent": "festival",
    "EducationEvent": "workshop",
    "LiteraryEvent": "workshop",
    "SocialEvent": "community",
}

# The AllEvents category feed an event was found in -> our type.
SOURCE_TYPES = {
    "music": "music",
    "theatre": "theatre",
    "comedy": "comedy",
    "arts": "art",
    "nightlife": "nightlife",
}

# Whole-word keyword hints per type, lowercase, matched case-insensitively.
# When several match, the one appearing first in the text wins.
TYPE_HINTS = {
    "music": [
        "concert", "concerts", "live music", "gig", "band", "bands", "jazz",
        "blues", "orchestra", "symphony", "philharmonic", "choir", "recital",
        "acoustic", "open mic", "singer", "songwriter", "rock", "punk", "metal",
        "hip hop", "rap", "folk", "musik", "konzert", "chor", "music",
    ],
    "theatre": [
        "theatre", "theater", "musical", "opera", "ballet", "drama", "cabaret",
        "circus", "magic show", "dance show", "puppet", "puppet show",
        "pantomime", "oper", "schauspiel", "zirkus", "theaterstück",
    ],
    "comedy": [
        "comedy", "stand-up", "standup", "stand up", "comedian", "comedians",
        "improv", "kabarett", "satire",
    ],
    "film": [
        "film", "films", "movie", "movies", "cinema", "screening",
        "open air cinema", "kino", "filmabend",
    ],
    "art": [
        "art", "arts", "gallery", "exhibition", "painting", "sculpture",
        "art walk", "vernissage", "photography", "paint and sip", "ausstellung",
        "kunst", "galerie",
    ],
    "museum": [
        "museum", "museums", "heritage", "history tour", "historic",
        "castle", "museumsnacht", "burg", "schloss",
    ],
    "park": [
        "park", "garden", "gardens", "hike", "hiking", "nature walk", "forest",
        "botanical", "nature", "wandern", "wanderung", "naturpark",
    ],
    "water": [
        "swim", "swimming", "pool", "beach", "lido", "schwimmen", "strand",
        "freibad", "hallenbad",
    ],
    "animals": [
        "zoo", "aquarium", "petting zoo", "wildlife", "animals", "farm animals",
        "tierpark", "wildpark",
    ],
    "sport": [
        "run", "running", "marathon", "5k", "10k", "football", "soccer",
        "yoga", "fitness", "cycling", "bike ride", "climbing", "bouldering",
        "tennis", "match", "tournament", "volleyball", "basketball", "hockey",
        "handball", "sport", "sports", "lauf", "fußball", "turnier",
    ],
    "play": [
        "playground", "soft play", "bouncy castle", "spielplatz", "play area",
    ],
    "attraction": [
        "theme park", "funfair", "amusement", "escape room", "mini golf",
        "minigolf", "kirmes", "freizeitpark",
    ],
    "food": [
        "food", "dinner", "brunch", "breakfast", "tasting", "wine",
        "wine tasting", "beer", "brewery", "distillery", "whisky", "whiskey",
        "gin", "street food", "bbq", "barbecue", "coffee", "cocktail",
        "cocktails", "supper club", "weinprobe", "essen",
    ],
    "nightlife": [
        "club night", "dance party", "afterparty", "dj", "rave", "techno", "house music",
        "nightlife", "disco", "pub crawl", "karaoke", "quiz night", "pub quiz",
        "salsa night", "silent disco",
    ],
    "festival": [
        "festival", "fest", "market", "flea market", "christmas market",
        "carnival", "parade", "fair", "street party", "markt", "flohmarkt",
        "weihnachtsmarkt", "volksfest", "stadtfest",
    ],
    "workshop": [
        "workshop", "class", "classes", "course", "lesson", "lessons",
        "seminar", "lecture", "talk", "tutorial", "bootcamp", "masterclass",
        "pottery", "craft", "crafts", "kurs", "vortrag", "reading", "lesung",
    ],
    "community": [
        "meetup", "meet-up", "networking", "social", "meet and greet",
        "language exchange", "board games", "board game", "stammtisch",
        "volunteer", "volunteering", "community", "get together",
    ],
}

# Things actually aimed at children — not just "fine to bring kids to".
KID_HINTS = [
    "kids", "kid", "children", "child", "childrens", "children's", "toddler",
    "toddlers", "baby", "babies", "little ones", "junior", "juniors",
    "family day", "family fun", "family-friendly", "family friendly",
    "for families", "puppet", "puppet show", "storytime", "story time",
    "fairy tale", "petting zoo", "face painting", "bouncy castle", "lego",
    "soft play", "playground", "school holiday", "school holidays", "half term",
    "easter egg hunt", "kinder", "kinderfest", "kindertheater", "familienfest",
    "spielplatz", "märchen", "kinderprogramm",
]


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").lower())


def _regex(hints: Iterable[str]) -> re.Pattern:
    # longest first so "puppet show" wins over "puppet"; word-boundary match so
    # "art" doesn't fire inside "start"
    alternation = "|".join(re.escape(h) for h in sorted(hints, key=len, reverse=True))
    return re.compile(r"(?<!\w)(?:" + alternation + r")(?!\w)")


_TYPE_RES = {t: _regex(h) for t, h in TYPE_HINTS.items()}
_KID_RE = _regex(KID_HINTS)


def _type_from_text(text: str) -> Optional[str]:
    """The type whose keyword appears earliest in ``text`` (ties: TYPES order)."""
    best: Optional[tuple[int, int, str]] = None
    for order, key in enumerate(TYPE_KEYS):
        rx = _TYPE_RES.get(key)
        if rx is None:
            continue
        m = rx.search(text)
        if m and (best is None or (m.start(), order) < best[:2]):
            best = (m.start(), order, key)
    return best[2] if best else None


def _ld_type(ld_types: Iterable[str]) -> Optional[str]:
    for t in ld_types:
        name = str(t).rsplit("/", 1)[-1]
        if name in LD_TYPES:
            return LD_TYPES[name]
    return None


def _source_type(source: str) -> Optional[str]:
    # "AllEvents (Town/music)" or "AllEvents · Music" -> "music"
    m = re.search(r"[·/]\s*(\w+)\)?\s*$", source or "")
    return SOURCE_TYPES.get(m.group(1).lower()) if m else None


def event_type(
    title: str,
    description: str = "",
    ld_types: Iterable[str] = (),
    source: str = "",
) -> str:
    """Best-guess type for a scheduled event; ``unknown`` if nothing fits."""
    return (
        _ld_type(ld_types)
        or _type_from_text(_norm(title))
        or _source_type(source)
        or _type_from_text(_norm(description))
        or ("community" if (source or "").lower().startswith("meetup") else None)
        or TYPE_UNKNOWN
    )


def is_kid_friendly(title: str, description: str = "", ld_types: Iterable[str] = ()) -> bool:
    if any(str(t).rsplit("/", 1)[-1] == "ChildrensEvent" for t in ld_types):
        return True
    return bool(_KID_RE.search(_norm(f"{title} \n {description}")))


def auto_tags(title: str, description: str = "", ld_types: Iterable[str] = ()) -> list[str]:
    """Best-guess secondary tags for an event from its text. May return []."""
    return [TAG_KIDS] if is_kid_friendly(title, description, ld_types) else []

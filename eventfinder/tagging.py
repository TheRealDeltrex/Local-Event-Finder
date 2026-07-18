"""Auto-tagging heuristics.

Two tag categories the user cares about:

* ``date``   — "possible date" ideas (date-night / romantic outings)
* ``family`` — child- or family-friendly things to do

Tags are guessed from the event's title + description with keyword matching.
The user can always add or remove a tag by hand; those manual choices are
stored separately and win over the guess (see ``store`` / ``scraper``).
"""
from __future__ import annotations

import re
from typing import Iterable

TAG_DATE = "date"
TAG_FAMILY = "family"
ALL_TAGS = (TAG_DATE, TAG_FAMILY)

TAG_LABELS = {
    TAG_DATE: "Possible date",
    TAG_FAMILY: "Family friendly",
}

# Whole-word keyword hints per tag. Kept lowercase; matched case-insensitively.
_DATE_HINTS = [
    "date night", "romantic", "couples", "wine", "wine tasting", "tasting",
    "cocktail", "cocktails", "speakeasy", "rooftop", "candlelight", "candlelit",
    "dinner", "brunch", "jazz", "live music", "concert", "acoustic", "vinyl",
    "comedy", "stand-up", "standup", "theatre", "theater", "opera", "ballet",
    "gallery", "art walk", "exhibition", "gin", "whisky", "whiskey", "brewery",
    "distillery", "tapas", "salsa", "tango", "dance class", "sunset", "cruise",
    "pottery", "paint and sip", "quiz night", "wine bar",
]

_FAMILY_HINTS = [
    "family", "families", "family-friendly", "kid", "kids", "child", "children",
    "toddler", "toddlers", "baby", "babies", "all ages", "all-ages",
    "playground", "puppet", "storytime", "story time", "fairy tale",
    "petting zoo", "zoo", "aquarium", "science museum", "planetarium",
    "craft", "crafts", "lego", "face painting", "bouncy castle", "funfair",
    "kinder", "familien", "familie", "spielplatz", "märchen",  # German hints
    "workshop for kids", "school holiday", "half term", "easter egg",
]


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").lower())


def _match_any(text: str, hints: Iterable[str]) -> bool:
    for hint in hints:
        # word-boundary match so "art" doesn't fire inside "start"
        if re.search(r"(?<!\w)" + re.escape(hint) + r"(?!\w)", text):
            return True
    return False


def auto_tags(title: str, description: str = "") -> list[str]:
    """Best-guess tags for an event from its text. May return [] (untagged)."""
    text = _norm(f"{title} \n {description}")
    tags: list[str] = []
    if _match_any(text, _DATE_HINTS):
        tags.append(TAG_DATE)
    if _match_any(text, _FAMILY_HINTS):
        tags.append(TAG_FAMILY)
    return tags

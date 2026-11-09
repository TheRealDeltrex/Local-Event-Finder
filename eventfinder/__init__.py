"""Local Events Finder — scrape nearby events, tag and filter them."""
from pathlib import Path


def _read_version() -> str:
    # The top-level VERSION file is the single source of truth for every
    # deliverable (Flask app, Android app, browser version).
    try:
        return (Path(__file__).resolve().parent.parent / "VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        return "0.0.0+unknown"


__version__ = _read_version()

__all__ = ["geo", "models", "tagging", "scraper", "store", "__version__"]

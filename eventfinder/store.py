"""On-disk persistence — everything stays in local JSON files, no cloud.

Three small files under the data directory:

* ``geocode_cache.json`` — address -> coordinates, so we don't hammer Nominatim
* ``manual_tags.json``   — per-event tag overrides the user set by hand
* ``settings.json``      — saved home location + event sources
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any

_lock = threading.Lock()

DEFAULT_SOURCES = [
    {
        "name": "Meetup",
        # {city} / {cc} are filled from the resolved search location.
        "url": "https://www.meetup.com/find/?location={cc}--{city}&source=EVENTS",
        "enabled": True,
    },
    # AllEvents aggregates ticketed venue events (concerts, theatre, comedy,
    # shows). Its per-category pages surface different events than /all, so we
    # pull several to cover the full range of "evening-filling" things to do.
    # {city_lower} is the lowercased, hyphenated city slug.
    {"name": "AllEvents", "url": "https://allevents.in/{city_lower}/all", "enabled": True},
    {"name": "AllEvents · Music", "url": "https://allevents.in/{city_lower}/music", "enabled": True},
    {"name": "AllEvents · Theatre", "url": "https://allevents.in/{city_lower}/theatre", "enabled": True},
    {"name": "AllEvents · Comedy", "url": "https://allevents.in/{city_lower}/comedy", "enabled": True},
    {"name": "AllEvents · Arts", "url": "https://allevents.in/{city_lower}/arts", "enabled": True},
    {"name": "AllEvents · Nightlife", "url": "https://allevents.in/{city_lower}/nightlife", "enabled": True},
]


class Store:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.geocode_path = os.path.join(data_dir, "geocode_cache.json")
        self.tags_path = os.path.join(data_dir, "manual_tags.json")
        self.settings_path = os.path.join(data_dir, "settings.json")

    # --- low level -------------------------------------------------------
    def _read(self, path: str, default: Any) -> Any:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            return default

    def _write(self, path: str, data: Any) -> None:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    # --- geocode cache ---------------------------------------------------
    def load_geocode_cache(self) -> dict:
        return self._read(self.geocode_path, {})

    def save_geocode_cache(self, cache: dict) -> None:
        with _lock:
            self._write(self.geocode_path, cache)

    # --- manual tag overrides -------------------------------------------
    def load_manual_tags(self) -> dict:
        """Maps event id -> {"add": [...], "remove": [...]}."""
        return self._read(self.tags_path, {})

    def set_manual_tags(self, event_id: str, add: list[str], remove: list[str]) -> dict:
        with _lock:
            data = self._read(self.tags_path, {})
            entry = {"add": sorted(set(add)), "remove": sorted(set(remove))}
            if not entry["add"] and not entry["remove"]:
                data.pop(event_id, None)
            else:
                data[event_id] = entry
            self._write(self.tags_path, data)
            return entry

    # --- settings --------------------------------------------------------
    def load_settings(self) -> dict:
        settings = self._read(self.settings_path, {})
        settings.setdefault("home", None)          # {"lat","lon","label"} or None
        settings.setdefault("range_km", 40)
        # Always use the current default source list so shipped improvements
        # (new categories, fixes) apply even to an existing settings.json.
        settings["sources"] = DEFAULT_SOURCES
        return settings

    def save_settings(self, settings: dict) -> None:
        with _lock:
            self._write(self.settings_path, settings)

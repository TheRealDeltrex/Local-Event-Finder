"""Local Events Finder — a small local Flask app.

Finds things to do near you by scraping structured event data, filters them
to a distance range, and tags them as possible dates / family-friendly.
Runs entirely on your machine; the only outbound calls are to the event
sources and to OpenStreetMap for geocoding.
"""
from __future__ import annotations

import os
import webbrowser
from threading import Timer

from flask import Flask, jsonify, render_template, request

from eventfinder import geo, scraper
from eventfinder.store import Store
from eventfinder.tagging import ALL_TAGS, TAG_LABELS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get(
    "EVENTFINDER_DATA",
    os.path.join(os.path.expanduser("~"), "Documents", "LocalEventsFinder"),
)

app = Flask(__name__)
store = Store(DATA_DIR)


@app.route("/")
def index():
    settings = store.load_settings()
    return render_template(
        "index.html",
        tag_labels=TAG_LABELS,
        all_tags=ALL_TAGS,
        settings=settings,
    )


@app.post("/api/search")
def api_search():
    body = request.get_json(silent=True) or {}
    lat = body.get("lat")
    lon = body.get("lon")
    location_name = (body.get("location") or "").strip()
    try:
        range_km = float(body.get("range_km", 40))
    except (TypeError, ValueError):
        range_km = 40.0
    range_km = max(1.0, min(range_km, 200.0))

    if lat is not None and lon is not None:
        place = geo.resolve_search_location(lat=float(lat), lon=float(lon))
    elif location_name:
        place = geo.resolve_search_location(query=location_name)
    else:
        return jsonify({"error": "Provide a location name or share your device location."}), 400

    if not place:
        return jsonify({"error": "Could not resolve that location. Try a nearby town or city name."}), 404

    settings = store.load_settings()
    sources = settings.get("sources", [])

    log: list[str] = []
    events = scraper.run_search(place, sources, range_km, store, log=log)

    # Remember this as the home location for next time.
    settings["home"] = {"lat": place["lat"], "lon": place["lon"], "label": place["label"]}
    settings["range_km"] = range_km
    store.save_settings(settings)

    return jsonify(
        {
            "place": place,
            "range_km": range_km,
            "events": [e.as_dict() for e in events],
            "log": log,
        }
    )


@app.post("/api/events/<event_id>/tags")
def api_set_tags(event_id: str):
    """Persist a manual tag override for one event.

    Body: {"tag": "date"|"family", "state": true|false}.
    We record it as an add/remove relative to the auto-guess so it survives
    re-scrapes even though we don't store the event body itself.
    """
    body = request.get_json(silent=True) or {}
    tag = body.get("tag")
    state = bool(body.get("state"))
    if tag not in ALL_TAGS:
        return jsonify({"error": "unknown tag"}), 400
    was_auto = bool(body.get("auto"))  # whether the auto-guess included this tag

    manual = store.load_manual_tags()
    entry = manual.get(event_id, {"add": [], "remove": []})
    add = set(entry.get("add", []))
    remove = set(entry.get("remove", []))
    add.discard(tag)
    remove.discard(tag)
    if state and not was_auto:
        add.add(tag)          # user turned on a tag the guess missed
    elif not state and was_auto:
        remove.add(tag)       # user turned off a tag the guess added
    entry = store.set_manual_tags(event_id, sorted(add), sorted(remove))
    return jsonify({"ok": True, "override": entry})


@app.get("/api/settings")
def api_get_settings():
    return jsonify(store.load_settings())


@app.post("/api/settings")
def api_save_settings():
    body = request.get_json(silent=True) or {}
    settings = store.load_settings()
    if "sources" in body and isinstance(body["sources"], list):
        settings["sources"] = body["sources"]
    store.save_settings(settings)
    return jsonify(settings)


def _open_browser(port: int) -> None:
    webbrowser.open(f"http://127.0.0.1:{port}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    if os.environ.get("EVENTFINDER_OPEN", "1") == "1":
        Timer(1.0, _open_browser, args=(port,)).start()
    app.run(host="127.0.0.1", port=port, debug=bool(os.environ.get("FLASK_DEBUG")))

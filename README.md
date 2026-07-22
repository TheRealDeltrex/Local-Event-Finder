# 📍 Local Events Finder

### 🌐 [**Open the web app & download the Android app →**](https://therealdeltrex.github.io/Local-Event-Finder/)

_Live at **https://therealdeltrex.github.io/Local-Event-Finder/** — run it in your browser or grab the signed APK._

---

Find things to do near you. Point it at your area, set a range (up to 40 km),
and browse local events — each one tagged as a **possible date** or **family
friendly**, and filterable by tag and distance.

It runs entirely on your own machine. The only outbound calls are to the event
sources it scrapes and to OpenStreetMap for turning place names into
coordinates. Your searches and your tag choices stay in local files.

> **📱 Android app:** there's a native Kotlin/Jetpack Compose version in
> [`android/`](android/) with the same features (device GPS, scraping, tagging,
> filtering). See [android/README.md](android/README.md) to build it.
>
> **🌐 Landing page + APK download:** the [**live site**](https://therealdeltrex.github.io/Local-Event-Finder/)
> (served from [`docs/`](docs/) via GitHub Pages) runs the web version in the
> browser and offers the signed Android APK
> ([`docs/LocalEventFinder.apk`](docs/LocalEventFinder.apk)).

## What it does

- **Web scraping** — pulls events from configurable sources. Instead of
  screen-scraping one site's fragile HTML, it reads the structured
  [schema.org `Event`](https://schema.org/Event) data (JSON-LD) that most event
  sites already publish for search engines, so the same extractor works across
  many sites. Ships with two sources enabled (Meetup and AllEvents); add your
  own in Settings.
- **Your location, your way** — click **Use my location** to use the device's
  GPS (browser geolocation), or just **type a town or city**.
- **40 km range** — every event is geocoded and its straight-line distance from
  you is shown. Anything past the range is dropped.
- **Tags** — each event is auto-tagged as *Possible date* and/or *Family
  friendly* from keyword heuristics. Click a tag chip on any card to add or
  remove it by hand; your override is saved and survives re-scrapes.
- **Filter** — filter the results live by **tag** (checkboxes) and **range**
  (slider) without re-fetching.

## Run it

```bash
cd event-finder
python3 -m venv .venv && source .venv/bin/activate    # optional but recommended
pip install -r requirements.txt
python app.py
```

It opens in your browser at <http://127.0.0.1:5001>. Type a place (or click
*Use my location*), press **Search**, and browse.

### Environment variables

| Variable            | Default                                   | Purpose                                  |
| ------------------- | ----------------------------------------- | ---------------------------------------- |
| `PORT`              | `5001`                                    | Port to serve on                         |
| `EVENTFINDER_DATA`  | `~/Documents/LocalEventsFinder`           | Where cache / tags / settings are stored |
| `EVENTFINDER_OPEN`  | `1`                                       | Set to `0` to not auto-open the browser  |
| `FLASK_DEBUG`       | *(unset)*                                 | Set to enable Flask debug mode           |

## Where your data goes

Under `EVENTFINDER_DATA` (by default `~/Documents/LocalEventsFinder`):

- `geocode_cache.json` — remembered address → coordinate lookups (keeps us
  polite to OpenStreetMap)
- `manual_tags.json` — your per-event tag overrides
- `settings.json` — your last location, range, and event sources

## Adding event sources

Sources live in `settings.json` (seeded from `eventfinder/store.py`). Each is a
name + URL template. The template can use these placeholders, filled from your
resolved search location:

- `{city}` — city name, URL-encoded (e.g. `Cologne`)
- `{city_lower}` — lowercased, hyphenated slug (e.g. `cologne`)
- `{cc}` — ISO country code (e.g. `de`)
- `{label}` — the full resolved location label

Any page that publishes schema.org `Event` JSON-LD will work. Offline events
with a geocodable address are kept; online-only events are skipped (they have no
distance).

## How it fits together

```
app.py                 Flask routes: page + /api/search, tag toggle, settings
eventfinder/
  geo.py               OpenStreetMap geocoding + reverse + haversine (cached, throttled)
  scraper.py           JSON-LD Event extraction → geocode → distance → tag
  tagging.py           keyword heuristics for "date" / "family" tags
  store.py             local JSON persistence (cache, tags, settings)
  models.py            the Event record
templates/index.html   the UI
static/app.js          search, filtering, tag toggling
static/style.css       styling
```

## Notes & limits

- Scraping depends on each source keeping its structured data — if a site
  changes, that source may return fewer events. The pluggable design means you
  can add or swap sources without touching the pipeline.
- Geocoding uses the public OpenStreetMap Nominatim service, which asks for a
  descriptive User-Agent and ~1 request/second; results are cached on disk to
  stay well within that.
- Distances are straight-line ("as the crow flies"), not driving distance.

## License

Released under the **GNU General Public License v3.0** — see [LICENSE](LICENSE).

# 📍 Local Event Finder — Android

A native Android port of the Local Events Finder. Same idea, same pipeline as
the [web app](../README.md), rebuilt in Kotlin + Jetpack Compose:

- **Web scraping** of schema.org `Event` JSON-LD from configurable sources
  (Meetup + AllEvents by default) using OkHttp + Jsoup — one extractor across
  many sites.
- **Location** from the device (Google Play Services fused location) or a typed
  town/city, resolved with OpenStreetMap / Nominatim.
- **Range up to 40 km**, with every event geocoded and distance-filtered
  (haversine), shown as straight-line distance.
- **Tags**: events are auto-tagged *Possible date* / *Family friendly*; tap a
  chip on any card to override, and the choice is saved in `SharedPreferences`.
- **Live filtering** by tag chips and a range slider.

Everything runs on the phone; the only network calls are to the event sources
and to OpenStreetMap.

## Build & run

**Easiest:** open the `android/` folder in **Android Studio** (Ladybug or newer),
let it sync, and click ▶ on a device/emulator (Android 8.0 / API 26+).

**Command line:**

```bash
cd android
# point the build at your SDK (or set ANDROID_HOME)
echo "sdk.dir=$HOME/Android/Sdk" > local.properties
./gradlew :app:assembleDebug          # builds app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug                # install onto a connected device/emulator
```

To install the APK by hand:

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

> This project was compiled successfully with Android Gradle Plugin 8.5.2,
> Kotlin 1.9.24, Gradle 8.14.3, and `compileSdk` 34. The debug build is
> unsigned; sign a release build before publishing.

## Project layout

```
app/src/main/java/com/therealdeltrex/localeventfinder/
  MainActivity.kt        Compose UI: location controls, range slider, filters, event cards
  EventsViewModel.kt     search state, filtering, tag toggling
  data/
    Event.kt             the event record + stable id
    Tagging.kt           keyword heuristics for "date" / "family" tags
    Geo.kt               Nominatim geocoding (throttled + cached) + haversine
    Scraper.kt           JSON-LD Event extraction → geocode → distance → tag
    Sources.kt           default sources + URL templating
    TagStore.kt          SharedPreferences persistence (overrides, last location, range)
  ui/theme/Theme.kt      Compose Material 3 theme
```

## Permissions

- `INTERNET` — fetching events and geocoding.
- `ACCESS_COARSE_LOCATION` / `ACCESS_FINE_LOCATION` — only used when you tap
  **Use my location**; typing a place name needs no location permission.

## Notes & limits

- Scraping depends on each source publishing schema.org data; if a site changes,
  that source may return fewer events. Sources live in `Sources.kt`.
- Distances are straight-line, not driving distance.
- Nominatim is rate-limited to ~1 request/second (handled in `Geo.kt`); a busy
  search geocodes venues sequentially, so the first search in a new area can
  take a few seconds.

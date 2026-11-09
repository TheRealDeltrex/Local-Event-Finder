# Changelog

All three versions of Local Events Finder (the local web app, the Android app
and the in-browser version) share one version number, kept in the
[`VERSION`](VERSION) file. Each release below applies to all three.

The format follows [Keep a Changelog](https://keepachangelog.com/), and version
numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-11-06

### Added
- Every event and place now gets a colour-coded type tag, such as Music,
  Theatre & shows, Park & nature, Swimming & beach or Food & drink, and
  "Unknown" when the type can't be worked out.
- A type filter: show or hide each type of event and place, with All and None
  shortcuts. The choice is remembered.
- A "Kid friendly" tag for things actually aimed at children (playgrounds, zoos,
  puppet shows, kids' workshops…), but not for places that are merely fine for
  kids, like parks. You can still switch it on or off by hand, and an "Only kid
  friendly" filter shows just those.
- Separate "Events" and "Permanent places" switches.
- Tests for the tagging rules.

### Removed
- The "Possible date" and "Family friendly" tags and their filters. Manual
  choices made for them are ignored.

## [1.1.0] - 2026-11-06

### Added
- One shared version number for every version of the app, shown in each app's
  footer and on the download page.
- The browser version now also searches the towns around you, not just your
  own town, like the local and Android apps already did.
- An automatic check that the three versions stay in step (same keywords,
  place types, sources and search features).

### Changed
- The Android app's version code now follows the shared version, so each new
  APK installs as an update.
- The README describes the app in general terms.

## [1.0.0] - 2026-07-22

First release: event search from public event listings and OpenStreetMap
places within 40 km, distance and direction, "possible date" and "family
friendly" tags with manual overrides, a date range slider, and three ways to
run it (local web app, Android app, in-browser version).

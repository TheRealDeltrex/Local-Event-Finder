#!/usr/bin/env python3
"""Guard against drift between the three implementations.

The Flask app (Python), the Android app (Kotlin) and the browser version
(JavaScript) each implement the same pipeline. This script extracts the shared
tables (tag keywords, place categories, sources, Overpass mirrors, AllEvents
categories) from each and fails if they differ, so a change made in one place
can't silently miss the others.

Usage:  python scripts/check_parity.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KT = ROOT / "android/app/src/main/java/com/therealdeltrex/localeventfinder"
PY = {
    "tagging": ROOT / "eventfinder/tagging.py",
    "places": ROOT / "eventfinder/places.py",
    "store": ROOT / "eventfinder/store.py",
    "scraper": ROOT / "eventfinder/scraper.py",
}
JS = (ROOT / "docs/webapp.js").read_text(encoding="utf-8")
STR = re.compile(r'"((?:[^"\\]|\\.)*)"')


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def block(text: str, start: str, end: str) -> str:
    i = text.index(start)
    j = text.index(end, i + len(start))
    return text[i + len(start):j]


def strings(text: str) -> list[str]:
    return STR.findall(text)


def hints() -> dict[str, dict[str, list[str]]]:
    py, kt = read(PY["tagging"]), read(KT / "data/Tagging.kt")
    return {
        "date keywords": {
            "python": strings(block(py, "_DATE_HINTS = [", "]")),
            "android": strings(block(kt, "DATE_HINTS = listOf(", ")")),
            "browser": strings(block(JS, "DATE_HINTS = [", "]")),
        },
        "family keywords": {
            "python": strings(block(py, "_FAMILY_HINTS = [", "]")),
            "android": strings(block(kt, "FAMILY_HINTS = listOf(", ")\n")),
            "browser": strings(block(JS, "FAMILY_HINTS = [", "]")),
        },
    }


def categories() -> dict[str, list[str]]:
    py = block(read(PY["places"]), "CATEGORIES:", "\n}\n")
    py_rows = re.findall(r'\("(\w+)", "(\w+)"\): \("([^"]+)", \[([^\]]*)\]\)', py)
    kt = block(read(KT / "data/Places.kt"), "\"tourism|museum\"", "\n    )")
    kt = '"tourism|museum"' + kt
    kt_rows = re.findall(r'"(\w+)\|(\w+)" to \("([^"]+)" to (?:listOf\(([^)]*)\)|emptyList\(\))\)', kt)
    js = block(JS, "const POI_CATS = {", "};")
    js_rows = re.findall(r'"(\w+)\|(\w+)": \["([^"]+)", \[([^\]]*)\]\]', js)

    def norm(rows, tagmap=lambda t: t):
        out = []
        for k, v, label, tags in rows:
            ts = sorted(tagmap(t.strip()) for t in tags.split(",") if t.strip())
            out.append(f"{k}={v} -> {label} {ts}")
        return sorted(out)

    kt_tag = {"Tagging.TAG_FAMILY": '"family"', "Tagging.TAG_DATE": '"date"'}
    return {
        "python": norm(py_rows),
        "android": norm(kt_rows, lambda t: kt_tag.get(t, t)),
        "browser": norm(js_rows),
    }


def urls(text: str, pattern: str) -> list[str]:
    return sorted(set(re.findall(pattern, text)))


def main() -> int:
    checks: dict[str, dict[str, list[str]]] = {}
    checks.update(hints())
    checks["place categories"] = categories()

    overpass = r'"(https://[^"]+/interpreter)"'
    checks["Overpass mirrors"] = {
        "python": urls(read(PY["places"]), overpass),
        "android": urls(read(KT / "data/Places.kt"), overpass),
        "browser": urls(JS, overpass),
    }
    source = r'"(https://(?:www\.meetup\.com|allevents\.in)/[^"]*\{[^"]+)"'
    checks["event sources"] = {
        "python": urls(read(PY["store"]), source),
        "android": urls(read(KT / "data/Sources.kt"), source),
        "browser": urls(JS, source),
    }
    cats = r'\(\s*"music", "theatre", "comedy", "arts", "nightlife"\s*\)|\[\s*"music", "theatre", "comedy", "arts", "nightlife"\s*\]|listOf\("music", "theatre", "comedy", "arts", "nightlife"\)'
    checks["AllEvents deep categories"] = {
        "python": ["present"] if re.search(cats, read(PY["scraper"])) else [],
        "android": ["present"] if re.search(cats, read(KT / "data/Scraper.kt")) else [],
        "browser": ["present"] if re.search(cats, JS) else [],
    }
    # Feature markers: functions every implementation must have.
    features = {
        "nearby towns lookup": ("nearby_localities", "nearbyLocalities", "nearbyLocalities"),
        "AllEvents origin + nearby towns": ("gather_allevents", "gatherAllEvents", "gatherAllEvents"),
        "native-language city name": ("city_local", "cityLocal", "cityLocal"),
        "permanent places": ("fetch_places", "places.fetch(", "fetchPlaces"),
        "compass direction": ("compass16", "compass16", "compass16"),
    }
    py_all = "".join(read(p) for p in PY.values()) + read(ROOT / "eventfinder/geo.py")
    kt_all = "".join(read(p) for p in KT.rglob("*.kt"))
    for name, (p, k, j) in features.items():
        checks[name] = {
            "python": ["present"] if p in py_all else [],
            "android": ["present"] if k in kt_all else [],
            "browser": ["present"] if j in JS else [],
        }

    failed = False
    for name, impls in checks.items():
        ref = impls["python"]
        if not ref:
            print(f"FAIL {name}: nothing found in the Python app (has the code moved?)")
            failed = True
            continue
        for impl, values in impls.items():
            if values != ref:
                failed = True
                missing = sorted(set(ref) - set(values))
                extra = sorted(set(values) - set(ref))
                print(f"FAIL {name}: {impl} differs from python"
                      + (f"; missing {missing}" if missing else "")
                      + (f"; extra {extra}" if extra else "")
                      + ("" if missing or extra else "; order differs"))
    if not failed:
        print(f"parity check: OK ({len(checks)} shared tables/features match across all three)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

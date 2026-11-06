#!/usr/bin/env python3
"""Guard against drift between the three implementations.

The Flask app (Python), the Android app (Kotlin) and the browser version
(JavaScript) each implement the same pipeline. This script extracts the shared
tables (types and their colours, type and kid-friendly keywords, place categories, sources, Overpass mirrors, AllEvents
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


def pairs(text: str) -> list[str]:
    """"a" to "b" / "a": "b" pairs as "a=b"."""
    return [f"{k}={v}" for k, v in re.findall(r'"([^"]+)"(?: to |: )"([^"]+)"', text)]


def hints() -> dict[str, dict[str, list[str]]]:
    py, kt = read(PY["tagging"]), read(KT / "data/Tagging.kt")
    out: dict[str, dict[str, list[str]]] = {
        "types (key, label, colour)": {
            "python": [" ".join(r) for r in re.findall(
                r'\("(\w+)", "([^"]+)", "#([0-9a-fA-F]{6})"\)', block(py, "TYPES = [", "\n]"))],
            "android": [f"{k} {label} {c.lower()}" for k, label, c in re.findall(
                r'TypeInfo\("(\w+)", "([^"]+)", 0xFF([0-9A-Fa-f]{6})\)', block(kt, "val TYPES = listOf(", "\n    )"))],
            "browser": [" ".join(r) for r in re.findall(
                r'\["(\w+)", "([^"]+)", "#([0-9a-fA-F]{6})"\]', block(JS, "const TYPES = [", "\n];"))],
        },
        "schema.org type mapping": {
            "python": pairs(block(py, "LD_TYPES = {", "}")),
            "android": pairs(block(kt, "LD_TYPES = mapOf(", ")")),
            "browser": pairs(block(JS, "const LD_TYPES = {", "}")),
        },
        "AllEvents feed type mapping": {
            "python": pairs(block(py, "SOURCE_TYPES = {", "}")),
            "android": pairs(block(kt, "SOURCE_TYPES = mapOf(", ")")),
            "browser": pairs(block(JS, "const SOURCE_TYPES = {", "}")),
        },
        "kid friendly keywords": {
            "python": strings(block(py, "KID_HINTS = [", "]")),
            "android": strings(block(kt, "KID_HINTS = listOf(", "\n    )")),
            "browser": strings(block(JS, "const KID_HINTS = [", "];")),
        },
    }
    # Per-type keyword lists.
    py_h = block(py, "TYPE_HINTS = {", "\n}")
    kt_h = block(kt, "TYPE_HINTS = linkedMapOf(", "\n    )\n")
    js_h = block(JS, "const TYPE_HINTS = {", "\n};")
    py_rows = dict(re.findall(r'"(\w+)": \[(.*?)\]', py_h, re.S))
    kt_rows = dict(re.findall(r'"(\w+)" to listOf\((.*?)\n        \)', kt_h, re.S))
    js_rows = dict(re.findall(r'^  (\w+): \[(.*?)\],?$', js_h, re.M))
    for key in py_rows:
        out[f"{key} keywords"] = {
            "python": strings(py_rows[key]),
            "android": strings(kt_rows.get(key, "")),
            "browser": strings(js_rows.get(key, "")),
        }
    return out


def categories() -> dict[str, list[str]]:
    py = block(read(PY["places"]), "CATEGORIES:", "\n}\n")
    py_rows = re.findall(r'\("(\w+)", "(\w+)"\): \("([^"]+)", "(\w+)", (True|False)\)', py)
    kt = block(read(KT / "data/Places.kt"), "private val cats", "\n    )")
    kt_rows = re.findall(r'"(\w+)\|(\w+)" to PlaceCat\("([^"]+)", "(\w+)", (true|false)\)', kt)
    js = block(JS, "const POI_CATS = {", "};")
    js_rows = re.findall(r'"(\w+)\|(\w+)": \["([^"]+)", "(\w+)", (true|false)\]', js)

    def norm(rows):
        return sorted(f"{k}={v} -> {label} [{t}{', kids' if kids.lower() == 'true' else ''}]"
                      for k, v, label, t, kids in rows)

    return {"python": norm(py_rows), "android": norm(kt_rows), "browser": norm(js_rows)}


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
        "event typing": ("def event_type", "fun eventType", "function eventType"),
        "type filter": ("type-filter", "hiddenTypes", "type-filter"),
    }
    py_all = "".join(read(p) for p in PY.values()) + read(ROOT / "eventfinder/geo.py")
    # the local web app's own page + script count as the Python app's UI
    py_all += read(ROOT / "templates/index.html") + read(ROOT / "static/app.js")
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

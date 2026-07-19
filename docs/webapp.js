"use strict";
/*
 * In-browser version of the Local Events Finder.
 *
 * The Flask app scrapes server-side; a static GitHub Pages site can't run
 * Python, and browsers block cross-origin scraping. So this build fetches the
 * source pages through a public CORS proxy, then does the same work the Flask
 * backend does — extract schema.org Event JSON-LD, geocode via OpenStreetMap,
 * distance-filter, tag — entirely client-side. Geocoding (Nominatim) allows
 * browser requests directly. Manual tags + cache live in localStorage.
 */

const TAGS = ["date", "family"];
const TAG_LABELS = { date: "Possible date", family: "Family friendly" };
const CORS_PROXY = (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
const NOMINATIM = "https://nominatim.openstreetmap.org";

const SOURCES = [
  { name: "Meetup", url: "https://www.meetup.com/find/?location={cc}--{city}&source=EVENTS" },
  { name: "AllEvents", url: "https://allevents.in/{city_lower}/all" },
];

const DATE_HINTS = ["date night","romantic","couples","wine","wine tasting","tasting","cocktail","cocktails","speakeasy","rooftop","candlelight","candlelit","dinner","brunch","jazz","live music","concert","acoustic","vinyl","comedy","stand-up","standup","theatre","theater","opera","ballet","gallery","art walk","exhibition","gin","whisky","whiskey","brewery","distillery","tapas","salsa","tango","dance class","sunset","cruise","pottery","paint and sip","quiz night","wine bar"];
const FAMILY_HINTS = ["family","families","family-friendly","kid","kids","child","children","toddler","toddlers","baby","babies","all ages","all-ages","playground","puppet","storytime","story time","fairy tale","petting zoo","zoo","aquarium","science museum","planetarium","craft","crafts","lego","face painting","bouncy castle","funfair","kinder","familien","familie","spielplatz","märchen","workshop for kids","school holiday","half term","easter egg"];

function buildHintRegex(hints) {
  const alt = hints.slice().sort((a, b) => b.length - a.length)
    .map((h) => h.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|");
  return new RegExp("(?<!\\w)(?:" + alt + ")(?!\\w)", "i");
}
const DATE_RE = buildHintRegex(DATE_HINTS);
const FAMILY_RE = buildHintRegex(FAMILY_HINTS);

function autoTags(title, description) {
  const text = `${title} \n ${description || ""}`;
  const t = [];
  if (DATE_RE.test(text)) t.push("date");
  if (FAMILY_RE.test(text)) t.push("family");
  return t;
}

// ---- persistence ----------------------------------------------------------
const store = {
  geo: JSON.parse(localStorage.getItem("lef_geo") || "{}"),
  overrides: JSON.parse(localStorage.getItem("lef_tags") || "{}"),
  saveGeo() { localStorage.setItem("lef_geo", JSON.stringify(this.geo)); },
  saveOverrides() { localStorage.setItem("lef_tags", JSON.stringify(this.overrides)); },
};

// ---- geo ------------------------------------------------------------------
let lastNominatim = 0;
async function throttle() {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
}
async function nominatim(path) {
  await throttle();
  const resp = await fetch(`${NOMINATIM}/${path}`, { headers: { "Accept-Language": "en,de" } });
  if (!resp.ok) throw new Error("nominatim " + resp.status);
  return resp.json();
}
function haversine(a, b, c, d) {
  const R = 6371, r = Math.PI / 180;
  const dp = (c - a) * r, dl = (d - b) * r;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function cityFromAddr(addr) {
  if (!addr) return "";
  for (const k of ["city", "town", "village", "municipality", "county", "state"])
    if (addr[k]) return addr[k];
  return "";
}
async function resolvePlace(query) {
  const data = await nominatim(`search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`);
  if (!data.length) return null;
  const t = data[0];
  return {
    lat: parseFloat(t.lat), lon: parseFloat(t.lon), label: t.display_name || query,
    city: cityFromAddr(t.address) || query, cc: (t.address?.country_code || "").toLowerCase(),
  };
}
async function resolveCoords(lat, lon) {
  let label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`, addr = null;
  try {
    const d = await nominatim(`reverse?lat=${lat}&lon=${lon}&format=json&zoom=14`);
    label = d.display_name || label; addr = d.address;
  } catch (e) { /* keep coords label */ }
  return { lat, lon, label, city: cityFromAddr(addr), cc: (addr?.country_code || "").toLowerCase() };
}
async function geocode(query) {
  const key = query.toLowerCase();
  if (key in store.geo) return store.geo[key];
  let result = null;
  try {
    const d = await nominatim(`search?q=${encodeURIComponent(query)}&format=json&limit=1`);
    if (d.length) result = { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon) };
  } catch (e) { result = null; }
  store.geo[key] = result; store.saveGeo();
  return result;
}

// ---- scraping -------------------------------------------------------------
function buildUrl(tpl, place) {
  const city = (place.city || place.label.split(",")[0]).trim();
  const slug = encodeURIComponent(city.toLowerCase().replace(/\s+/g, "-"));
  return tpl.replace("{city}", encodeURIComponent(city))
    .replace("{city_lower}", slug)
    .replace("{cc}", encodeURIComponent((place.cc || "").trim()))
    .replace("{label}", encodeURIComponent(place.label));
}
function eid(url, title, start) {
  let h = 0; const s = `${url}|${title}|${start}`;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return "e" + (h >>> 0).toString(16);
}
function collectNodes(root, out) {
  if (Array.isArray(root)) root.forEach((n) => collectNodes(n, out));
  else if (root && typeof root === "object") {
    out.push(root);
    if (Array.isArray(root["@graph"])) collectNodes(root["@graph"], out);
  }
}
function isEvent(node) {
  const t = node["@type"]; if (!t) return false;
  return (Array.isArray(t) ? t : [t]).some((x) => String(x).includes("Event"));
}
function txt(v) {
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === "object") v = v.name || v.url || "";
  return (typeof v === "string" ? v : "").trim();
}
function locFields(node) {
  let loc = node.location; if (Array.isArray(loc)) loc = loc[0];
  if (!loc || typeof loc !== "object") return { address: "", locality: "", lat: null, lon: null };
  if (String(loc["@type"] || "").includes("Virtual")) return { address: "", locality: "", lat: null, lon: null };
  let lat = null, lon = null;
  if (loc.geo) { lat = parseFloat(loc.geo.latitude); lon = parseFloat(loc.geo.longitude); if (isNaN(lat)) lat = lon = null; }
  let locality = "", parts = [];
  const a = loc.address;
  if (a && typeof a === "object") {
    locality = a.addressLocality || "";
    for (const k of ["streetAddress", "addressLocality", "postalCode", "addressCountry"])
      if (a[k] && !parts.includes(a[k])) parts.push(a[k]);
  } else if (typeof a === "string") parts.push(a);
  const name = loc.name || "";
  const address = [name, ...parts].filter(Boolean).join(", ");
  return { address, locality, lat, lon };
}
function extractEvents(html, sourceName) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = [], seen = new Set();
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    let data; try { data = JSON.parse(s.textContent); } catch (e) { return; }
    const nodes = []; collectNodes(data, nodes);
    for (const node of nodes) {
      if (!isEvent(node)) continue;
      const title = txt(node.name); if (!title) continue;
      const url = txt(node.url), start = txt(node.startDate), id = eid(url, title, start);
      if (seen.has(id)) continue; seen.add(id);
      const lf = locFields(node), description = txt(node.description);
      out.push({ id, title, url, source: sourceName, description, start,
        image: txt(node.image), address: lf.address, locality: lf.locality,
        lat: lf.lat, lon: lf.lon, autoTags: autoTags(title, description), tags: [] });
    }
  });
  return out;
}
async function fetchSource(url) {
  const resp = await fetch(CORS_PROXY(url), { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error("proxy " + resp.status);
  return resp.text();
}

function effectiveTags(ev) {
  const t = new Set(ev.autoTags);
  const ov = store.overrides[ev.id];
  if (ov) { (ov.add || []).forEach((x) => t.add(x)); (ov.remove || []).forEach((x) => t.delete(x)); }
  return [...t];
}

// Sample events, positioned around the resolved location, used when live
// scraping isn't reachable from a static page (see the note in search()).
const SAMPLE = [
  { t: "Candlelight Jazz & Wine Tasting", d: "A romantic evening of live jazz and local wines.", km: 1.2, h: 19 },
  { t: "Rooftop Cocktails & Live Music", d: "Sunset cocktails with an acoustic set.", km: 2.4, h: 20 },
  { t: "Stand-up Comedy Night", d: "An evening of stand-up at the local club.", km: 3.1, h: 21 },
  { t: "Kids' Craft & Storytime Morning", d: "Crafts and storytime for toddlers — all ages welcome.", km: 1.8, h: 10 },
  { t: "Family Fun Day in the Park", d: "A family day out with a petting zoo and face painting.", km: 4.6, h: 11 },
  { t: "Puppet Show for Little Ones", d: "A puppet show the whole family will enjoy.", km: 6.0, h: 14 },
  { t: "Saturday Farmers Market", d: "Local produce, street food and makers.", km: 2.0, h: 9 },
  { t: "Open-Air Cinema: Classics", d: "A screening under the stars.", km: 8.3, h: 21 },
];
function makeSampleEvents(place) {
  const now = new Date();
  return SAMPLE.map((s, i) => {
    // offset ~s.km north-east of the origin (1 deg lat ≈ 111 km)
    const dLat = (s.km / 111) * 0.7, dLon = (s.km / 85) * 0.7;
    const when = new Date(now); when.setDate(now.getDate() + i + 1); when.setHours(s.h, 0, 0, 0);
    return {
      id: "sample-" + i, title: s.t, url: "", source: "Sample",
      description: s.d, start: when.toISOString(),
      address: "", locality: place.city || place.label.split(",")[0],
      lat: place.lat + dLat, lon: place.lon + dLon,
      autoTags: autoTags(s.t, s.d), tags: [],
    };
  });
}

async function runSearch(place, rangeKm, log) {
  const collected = new Map();
  for (const src of SOURCES) {
    try {
      const html = await fetchSource(buildUrl(src.url, place));
      const found = extractEvents(html, src.name);
      log.push(`${src.name}: ${found.length} event(s) with structured data`);
      for (const ev of found) if (!collected.has(ev.id)) collected.set(ev.id, ev);
    } catch (e) {
      log.push(`${src.name}: live scrape unavailable (${e.message})`);
    }
  }
  if (collected.size === 0) {
    log.push("Live sources unreachable from the browser — showing sample events.");
    for (const ev of makeSampleEvents(place)) collected.set(ev.id, ev);
    window.__lef_sample = true;
  } else {
    window.__lef_sample = false;
  }
  const results = [];
  for (const ev of collected.values()) {
    if (ev.lat == null || ev.lon == null) {
      const q = ev.address || ev.locality; if (!q) continue;
      const g = await geocode(q); if (!g) continue;
      ev.lat = g.lat; ev.lon = g.lon;
    }
    ev.distance_km = Math.round(haversine(place.lat, place.lon, ev.lat, ev.lon) * 10) / 10;
    if (ev.distance_km > rangeKm) continue;
    ev.tags = effectiveTags(ev);
    results.push(ev);
  }
  results.sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999") || a.distance_km - b.distance_km);
  log.push(`${results.length} event(s) within ${rangeKm} km`);
  return results;
}

// ---- UI -------------------------------------------------------------------
const el = (s) => document.querySelector(s);
let allEvents = [];

function setStatus(msg, isError = false, busy = false) {
  const s = el("#status"); s.classList.toggle("error", isError);
  s.innerHTML = (busy ? '<span class="spinner"></span>' : "") + msg;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmtWhen(iso) {
  if (!iso) return "Date TBC";
  const d = new Date(iso); if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function activeFilters() { const on = new Set(); document.querySelectorAll(".tag-filter:checked").forEach((c) => on.add(c.value)); return on; }

function render() {
  const filters = activeFilters(), maxR = Number(el("#range").value), box = el("#results");
  box.innerHTML = "";
  const shown = allEvents.filter((ev) => {
    if (ev.distance_km != null && ev.distance_km > maxR) return false;
    if (!ev.tags.length) return filters.has("__untagged__");
    return ev.tags.some((t) => filters.has(t));
  });
  if (!allEvents.length) return;
  if (!shown.length) { box.innerHTML = '<p class="empty">No events match these filters. Widen the range or turn on more tags.</p>'; return; }
  for (const ev of shown) {
    const card = document.createElement("article"); card.className = "card event";
    card.innerHTML = `<div class="event-main">
      <h3 class="event-title"><a target="_blank" rel="noopener" href="${esc(ev.url || "#")}">${esc(ev.title)}</a></h3>
      <p class="event-meta"><span>${esc(fmtWhen(ev.start))}</span><span class="dot">·</span>
        <span class="event-dist">${ev.distance_km} km away</span>${ev.locality ? `<span>· ${esc(ev.locality)}</span>` : ""}</p>
      ${ev.description ? `<p class="event-desc">${esc(ev.description)}</p>` : ""}
    </div><div class="event-tags"></div>`;
    const tagWrap = card.querySelector(".event-tags");
    for (const tag of TAGS) {
      const on = ev.tags.includes(tag);
      const b = document.createElement("button");
      b.className = "tag-btn"; b.dataset.tag = tag; b.classList.toggle("on", on);
      b.textContent = (on ? "✓ " : "+ ") + TAG_LABELS[tag];
      b.onclick = () => toggleTag(ev, tag, b);
      tagWrap.appendChild(b);
    }
    box.appendChild(card);
  }
}
function toggleTag(ev, tag, btn) {
  const on = ev.tags.includes(tag), wasAuto = ev.autoTags.includes(tag), next = !on;
  ev.tags = next ? [...new Set([...ev.tags, tag])] : ev.tags.filter((t) => t !== tag);
  const ov = store.overrides[ev.id] || { add: [], remove: [] };
  ov.add = ov.add.filter((t) => t !== tag); ov.remove = ov.remove.filter((t) => t !== tag);
  if (next && !wasAuto) ov.add.push(tag); else if (!next && wasAuto) ov.remove.push(tag);
  if (!ov.add.length && !ov.remove.length) delete store.overrides[ev.id]; else store.overrides[ev.id] = ov;
  store.saveOverrides();
  btn.classList.toggle("on", next); btn.textContent = (next ? "✓ " : "+ ") + TAG_LABELS[tag];
  render();
}

async function search(resolver) {
  setStatus("Searching for events…", false, true);
  el("#btn-search").disabled = true; el("#btn-geo").disabled = true;
  try {
    const place = await resolver();
    if (!place) { setStatus("Could not resolve that location. Try a nearby town.", true); return; }
    const range = Number(el("#range").value), log = [];
    allEvents = await runSearch(place, range, log);
    el("#log").innerHTML = log.map((l) => `<li>${esc(l)}</li>`).join("");
    const near = place.label.split(",").slice(0, 2).join(",");
    const within = allEvents.filter((e) => e.distance_km <= range).length;
    if (window.__lef_sample) {
      setStatus(`Live scraping isn't available in this static browser demo — showing ${within} <strong>sample</strong> event(s) near ${esc(near)} so you can try the interface. Install the Android app or run the local version for real listings.`);
    } else if (within) {
      setStatus(`${within} event(s) within ${range} km of ${esc(near)}.`);
    } else {
      setStatus(`No events within ${range} km of ${esc(near)}. Try a wider range.`, true);
    }
    render();
  } catch (e) {
    setStatus("Something went wrong (network or CORS proxy). Try again, or run the local Flask version.", true);
  } finally {
    el("#btn-search").disabled = false; el("#btn-geo").disabled = false;
  }
}

el("#btn-search").onclick = () => {
  const name = el("#loc-name").value.trim();
  if (!name) { setStatus("Type a town or city, or use your location.", true); return; }
  search(() => resolvePlace(name));
};
el("#loc-name").addEventListener("keydown", (e) => { if (e.key === "Enter") el("#btn-search").click(); });
el("#btn-geo").onclick = () => {
  if (!navigator.geolocation) { setStatus("This browser can't share a location. Type a place name.", true); return; }
  setStatus("Asking your device for its location…", false, true);
  navigator.geolocation.getCurrentPosition(
    (p) => search(() => resolveCoords(p.coords.latitude, p.coords.longitude)),
    () => setStatus("Location permission denied. Type a place name instead.", true),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
};
el("#range").addEventListener("input", () => { el("#range-val").textContent = el("#range").value; render(); });
document.querySelectorAll(".tag-filter").forEach((c) => c.addEventListener("change", render));
setStatus("Share your location or type a place to start.");

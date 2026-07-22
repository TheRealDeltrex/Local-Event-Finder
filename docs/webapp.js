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
const COMPASS_16 = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
function compass16(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  const bearing = (Math.atan2(y, x) / r + 360) % 360;
  return COMPASS_16[Math.round(bearing / 22.5) % 16];
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
        end: txt(node.endDate), image: txt(node.image), address: lf.address, locality: lf.locality,
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

// ---- permanent places (OpenStreetMap / Overpass, CORS-enabled) ------------
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const POI_KEYS = ["tourism", "leisure", "amenity", "historic", "natural"];
// "key|value": [label, tags]
const POI_CATS = {
  "tourism|museum": ["Museum", ["family"]], "tourism|gallery": ["Gallery", ["date"]],
  "tourism|zoo": ["Zoo", ["family"]], "tourism|theme_park": ["Theme park", ["family"]],
  "tourism|aquarium": ["Aquarium", ["family"]], "tourism|attraction": ["Attraction", []],
  "tourism|viewpoint": ["Viewpoint", ["date"]], "tourism|artwork": ["Public art", ["date"]],
  "leisure|park": ["Park", ["family"]], "leisure|garden": ["Garden", ["date"]],
  "leisure|nature_reserve": ["Nature reserve", []], "leisure|water_park": ["Water park", ["family"]],
  "leisure|miniature_golf": ["Mini golf", ["family"]], "leisure|golf_course": ["Golf course", []],
  "leisure|sports_centre": ["Sports centre", ["family"]], "leisure|swimming_pool": ["Swimming pool", ["family"]],
  "leisure|bathing_place": ["Bathing spot", ["family"]], "leisure|horse_riding": ["Horse riding", ["family"]],
  "leisure|playground": ["Playground", ["family"]], "leisure|bird_hide": ["Bird hide", ["date"]],
  "amenity|cinema": ["Cinema", ["date"]], "amenity|theatre": ["Theatre", ["date"]],
  "amenity|arts_centre": ["Arts centre", ["date"]], "amenity|public_bath": ["Swimming pool", ["family"]],
  "historic|castle": ["Castle", ["date"]], "historic|monument": ["Monument", []],
  "historic|memorial": ["Memorial", []], "historic|ruins": ["Ruins", ["date"]],
  "natural|beach": ["Beach", ["family"]],
};
function overpassQuery(lat, lon, r) {
  // nwr = nodes+ways+relations (many attractions are areas, e.g. the labyrinth);
  // output each type separately so a single cap can't drop all the areas.
  const keys = {}; POI_KEYS.forEach((k) => (keys[k] = []));
  for (const k in POI_CATS) { const [key, val] = k.split("|"); keys[key].push(val); }
  const body = Object.entries(keys).filter(([, v]) => v.length)
    .map(([key, vals]) => `nwr(around:${r},${lat},${lon})["${key}"~"^(${vals.join("|")})$"];`).join("");
  return `[out:json][timeout:60];(${body})->.a;node.a;out 300;way.a;out center 300;relation.a;out center 100;`;
}
function catOf(tags) {
  // Public pools are tagged inconsistently — label any of them "Swimming pool".
  const sport = (tags.sport || "").toLowerCase();
  if (sport.includes("swimming") || tags.leisure === "swimming_pool" ||
      tags.leisure === "water_park" || tags.amenity === "public_bath") {
    return ["Swimming pool", ["family"]];
  }
  for (const key of POI_KEYS) {
    const v = tags[key]; if (v && POI_CATS[`${key}|${v}`]) return POI_CATS[`${key}|${v}`];
  }
  return null;
}
async function fetchPlaces(lat, lon, rangeKm) {
  const q = overpassQuery(lat, lon, Math.round(rangeKm * 1000));
  const tryEndpoint = async (ep) => {
    const resp = await fetch(ep, {
      method: "POST", body: "data=" + encodeURIComponent(q),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(55000),
    });
    if (!resp.ok) throw new Error(`${ep} ${resp.status}`);
    const arr = (await resp.json()).elements;
    if (!arr) throw new Error("no elements");
    return arr;
  };
  let elements;
  try {
    // hit all mirrors at once, take the first that answers
    elements = await Promise.any(OVERPASS.map(tryEndpoint));
  } catch (e) { return []; }

  const seen = new Set(), out = [];
  for (const el of elements) {
    const tags = el.tags || {}, name = tags.name; if (!name) continue;
    const cat = catOf(tags); if (!cat) continue;
    const plat = el.lat ?? el.center?.lat, plon = el.lon ?? el.center?.lon;
    if (plat == null || plon == null) continue;
    // dedupe by name + coarse location (~1 km) so a twice-mapped place collapses
    const key = `${name.toLowerCase()}|${(+plat).toFixed(2)}|${(+plon).toFixed(2)}`;
    if (seen.has(key)) continue; seen.add(key);
    const url = tags.website || tags["contact:website"] || `https://www.openstreetmap.org/${el.type}/${el.id}`;
    out.push({ id: "poi-" + el.type + "-" + el.id, title: name, url, source: "OpenStreetMap",
      description: cat[0], permanent: true, category: cat[0], start: "", hours: tags.opening_hours || "",
      locality: tags["addr:city"] || "", lat: +plat, lon: +plon, autoTags: [...cat[1]], tags: [] });
  }
  // nearest first, then cap — so a close area is never truncated away
  out.sort((a, b) => haversine(lat, lon, a.lat, a.lon) - haversine(lat, lon, b.lat, b.lon));
  return out.slice(0, 120);
}
const WINDOW_DAYS = 14;
function withinWindow(startISO) {
  if (!startISO) return null;
  const t = Date.parse(startISO); if (isNaN(t)) return null;
  const now = Date.now();
  return t >= now - 864e5 && t <= now + WINDOW_DAYS * 864e5;
}

// Sample events, positioned around the resolved location, used only when both
// live scraping AND OpenStreetMap are unreachable (see runSearch()).
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

  // 1) scheduled events happening in the next week (undated listings kept too)
  let dropped = 0;
  for (const src of SOURCES) {
    try {
      const html = await fetchSource(buildUrl(src.url, place));
      const found = extractEvents(html, src.name);
      let kept = 0;
      for (const ev of found) {
        if (withinWindow(ev.start) === false) { dropped++; continue; }
        if (!collected.has(ev.id)) { collected.set(ev.id, ev); kept++; }
      }
      log.push(`${src.name}: ${kept} event(s) in the next 2 weeks (of ${found.length})`);
    } catch (e) {
      log.push(`${src.name}: live scrape unavailable in-browser (${e.message})`);
    }
  }
  if (dropped) log.push(`skipped ${dropped} event(s) outside the next ${WINDOW_DAYS} days`);

  // 2) permanent places you can visit any day (OpenStreetMap)
  try {
    const places = await fetchPlaces(place.lat, place.lon, rangeKm);
    log.push(`${places.length} permanent place(s) from OpenStreetMap`);
    for (const ev of places) if (!collected.has(ev.id)) collected.set(ev.id, ev);
  } catch (e) {
    log.push(`OpenStreetMap unavailable (${e.message})`);
  }

  // 3) only if we genuinely found nothing, fall back to sample events
  if (collected.size === 0) {
    log.push("Nothing reachable from the browser — showing sample events.");
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
    ev.direction = ev.distance_km > 0 ? compass16(place.lat, place.lon, ev.lat, ev.lon) : "";
    ev.tags = effectiveTags(ev);
    results.push(ev);
  }
  // upcoming dated events first, then undated events, then permanent (nearest)
  const rank = (e) => {
    if (e.permanent) return [2, e.distance_km || 0];
    const t = Date.parse(e.start);
    return isNaN(t) ? [1, e.distance_km || 0] : [0, t];
  };
  results.sort((a, b) => { const ka = rank(a), kb = rank(b); return ka[0] - kb[0] || ka[1] - kb[1]; });
  log.push(`${results.length} thing(s) to do within ${rangeKm} km`);
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
function fmtWhenRange(start, end) {
  const base = fmtWhen(start);
  if (!end) return base;
  const s = new Date(start), e = new Date(end);
  if (isNaN(s) || isNaN(e) || e <= s) return base;
  if (s.toDateString() !== e.toDateString()) return base;
  return `${base} – ${e.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}
function prettyHours(s) { return String(s).replace(/\s*;\s*/g, " · ").trim(); }
function mapsUrl(ev) {
  if (ev.lat != null && ev.lon != null)
    return `https://www.google.com/maps/search/?api=1&query=${ev.lat}%2C${ev.lon}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.title)}`;
}
function activeFilters() { const on = new Set(); document.querySelectorAll(".tag-filter:checked").forEach((c) => on.add(c.value)); return on; }

// ---- date range (dual slider, day offsets within the 2-week window) ----
function dayOffset(iso) {
  if (!iso) return null;
  const t = Date.parse(iso); if (isNaN(t)) return null;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return Math.floor((t - start.getTime()) / 864e5);
}
function labelForDay(off) {
  if (off <= 0) return "today";
  if (off === 1) return "tomorrow";
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
function dayBounds() {
  const a = Number(el("#day-min").value), b = Number(el("#day-max").value);
  return [Math.min(a, b), Math.max(a, b)];
}
function updateDateUI() {
  const [lo, hi] = dayBounds(), fill = el("#date-fill");
  fill.style.left = (lo / WINDOW_DAYS) * 100 + "%";
  fill.style.width = ((hi - lo) / WINDOW_DAYS) * 100 + "%";
  el("#date-label").textContent =
    lo === 0 && hi === WINDOW_DAYS ? "next 2 weeks" : `${labelForDay(lo)} → ${labelForDay(hi)}`;
}
function inDateRange(ev) {
  if (ev.permanent) return true;
  const off = dayOffset(ev.start);
  if (off === null) return true;
  const [lo, hi] = dayBounds();
  return Math.max(off, 0) >= lo && Math.max(off, 0) <= hi;
}

function render() {
  const filters = activeFilters(), maxR = Number(el("#range").value), box = el("#results");
  box.innerHTML = "";
  const shown = allEvents.filter((ev) => {
    if (ev.distance_km != null && ev.distance_km > maxR) return false;
    if (!inDateRange(ev)) return false;
    if (ev.permanent && !filters.has("__permanent__")) return false;
    if (!ev.tags.length) return filters.has("__untagged__");
    return ev.tags.some((t) => filters.has(t));
  });
  if (!allEvents.length) return;
  if (!shown.length) { box.innerHTML = '<p class="empty">Nothing matches these filters. Widen the distance or date range, or turn on more tags.</p>'; return; }
  for (const ev of shown) {
    const card = document.createElement("article"); card.className = "card event";
    const whenText = ev.permanent
      ? `${ev.category || "Place"} · ${ev.hours ? prettyHours(ev.hours) : "permanent"}`
      : fmtWhenRange(ev.start, ev.end);
    const descText = ev.permanent ? "" : (ev.description || "");
    card.innerHTML = `<div class="event-main">
      <h3 class="event-title"><a target="_blank" rel="noopener" href="${esc(ev.url || "#")}">${esc(ev.title)}</a></h3>
      <p class="event-meta"><span>${esc(whenText)}</span><span class="dot">·</span>
        <a class="event-dist" target="_blank" rel="noopener" title="Open in Google Maps" href="${esc(mapsUrl(ev))}">${ev.distance_km} km${ev.direction ? " " + esc(ev.direction) : ""}</a>${ev.locality ? `<span>· ${esc(ev.locality)}</span>` : ""}</p>
      ${descText ? `<p class="event-desc">${esc(descText)}</p>` : ""}
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
      setStatus(`${within} thing(s) to do within ${range} km of ${esc(near)}.`);
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

function onDaySlide(e) {
  const mn = el("#day-min"), mx = el("#day-max");
  let a = Number(mn.value), b = Number(mx.value);
  if (a > b) { if (e.target === mn) mx.value = a; else mn.value = b; }
  updateDateUI();
  render();
}
el("#day-min").addEventListener("input", onDaySlide);
el("#day-max").addEventListener("input", onDaySlide);
updateDateUI();
setStatus("Share your location or type a place to start.");

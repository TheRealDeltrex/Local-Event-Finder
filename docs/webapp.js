"use strict";
/*
 * In-browser version of the Local Events Finder.
 *
 * The Flask app scrapes server-side; a static GitHub Pages site can't run
 * Python, and browsers block cross-origin scraping. So this build fetches the
 * source pages through a public CORS proxy, then does the same work the Flask
 * backend does — extract schema.org Event JSON-LD, geocode via OpenStreetMap,
 * distance-filter, tag by type — entirely client-side. Geocoding (Nominatim) allows
 * browser requests directly. Manual tags + cache live in localStorage.
 */

const CORS_PROXY = (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
const NOMINATIM = "https://nominatim.openstreetmap.org";

const APP_VERSION = window.LEF_VERSION || "dev";   // stamped into version.js

// Same defaults as the Flask app (store.py) and Android (Sources.kt). AllEvents
// sources are handled by gatherAllEvents(): origin city + nearby towns.
const SOURCES = [
  { name: "Meetup", url: "https://www.meetup.com/find/?location={cc}--{city}&source=EVENTS" },
  { name: "AllEvents", url: "https://allevents.in/{city_lower}/all" },
  { name: "AllEvents · Music", url: "https://allevents.in/{city_lower}/music" },
  { name: "AllEvents · Theatre", url: "https://allevents.in/{city_lower}/theatre" },
  { name: "AllEvents · Comedy", url: "https://allevents.in/{city_lower}/comedy" },
  { name: "AllEvents · Arts", url: "https://allevents.in/{city_lower}/arts" },
  { name: "AllEvents · Nightlife", url: "https://allevents.in/{city_lower}/nightlife" },
];
const ALLEVENTS_CATEGORIES = ["music", "theatre", "comedy", "arts", "nightlife"];

// ---- tagging (mirrors eventfinder/tagging.py) ------------------------------
// Every result gets one primary type (music, park, …, or "unknown") and may get
// the secondary "kids" tag when it's actually aimed at children.
const TAGS = ["kids"];
const TAG_LABELS = { kids: "Kid friendly" };
// [key, label, colour] — order is the order of the filter chips.
const TYPES = [
  ["music", "Music", "#8e24aa"],
  ["theatre", "Theatre & shows", "#c62828"],
  ["comedy", "Comedy", "#ef6c00"],
  ["film", "Film", "#455a64"],
  ["art", "Art", "#d81b60"],
  ["museum", "Museum & history", "#6d4c41"],
  ["park", "Park & nature", "#2e7d32"],
  ["water", "Swimming & beach", "#0288d1"],
  ["animals", "Zoo & animals", "#00897b"],
  ["sport", "Sport", "#3949ab"],
  ["play", "Playground", "#f4511e"],
  ["attraction", "Attraction", "#c0a000"],
  ["food", "Food & drink", "#a1541b"],
  ["nightlife", "Nightlife", "#5e35b1"],
  ["festival", "Festival & market", "#e91e63"],
  ["workshop", "Class & talk", "#00838f"],
  ["community", "Meetup & social", "#607d8b"],
  ["unknown", "Unknown", "#757575"],
];
const TYPE_BY_KEY = Object.fromEntries(TYPES.map(([key, label, color]) => [key, { key, label, color }]));
// schema.org event @type -> type (plain "Event" says nothing).
const LD_TYPES = {
  "MusicEvent": "music",
  "TheaterEvent": "theatre",
  "DanceEvent": "theatre",
  "ComedyEvent": "comedy",
  "ScreeningEvent": "film",
  "VisualArtsEvent": "art",
  "ExhibitionEvent": "art",
  "SportsEvent": "sport",
  "FoodEvent": "food",
  "Festival": "festival",
  "SaleEvent": "festival",
  "EducationEvent": "workshop",
  "LiteraryEvent": "workshop",
  "SocialEvent": "community",
};
// AllEvents category feed -> type.
const SOURCE_TYPES = {
  "music": "music",
  "theatre": "theatre",
  "comedy": "comedy",
  "arts": "art",
  "nightlife": "nightlife",
};
// Whole-word keyword hints per type; the one appearing first in the text wins.
const TYPE_HINTS = {
  music: ["concert","concerts","live music","gig","band","bands","jazz","blues","orchestra","symphony","philharmonic","choir","recital","acoustic","open mic","singer","songwriter","rock","punk","metal","hip hop","rap","folk","musik","konzert","chor","music"],
  theatre: ["theatre","theater","musical","opera","ballet","drama","cabaret","circus","magic show","dance show","puppet","puppet show","pantomime","oper","schauspiel","zirkus","theaterstück"],
  comedy: ["comedy","stand-up","standup","stand up","comedian","comedians","improv","kabarett","satire"],
  film: ["film","films","movie","movies","cinema","screening","open air cinema","kino","filmabend"],
  art: ["art","arts","gallery","exhibition","painting","sculpture","art walk","vernissage","photography","paint and sip","ausstellung","kunst","galerie"],
  museum: ["museum","museums","heritage","history tour","historic","castle","museumsnacht","burg","schloss"],
  park: ["park","garden","gardens","hike","hiking","nature walk","forest","botanical","nature","wandern","wanderung","naturpark"],
  water: ["swim","swimming","pool","beach","lido","schwimmen","strand","freibad","hallenbad"],
  animals: ["zoo","aquarium","petting zoo","wildlife","animals","farm animals","tierpark","wildpark"],
  sport: ["run","running","marathon","5k","10k","football","soccer","yoga","fitness","cycling","bike ride","climbing","bouldering","tennis","match","tournament","volleyball","basketball","hockey","handball","sport","sports","lauf","fußball","turnier"],
  play: ["playground","soft play","bouncy castle","spielplatz","play area"],
  attraction: ["theme park","funfair","amusement","escape room","mini golf","minigolf","kirmes","freizeitpark"],
  food: ["food","dinner","brunch","breakfast","tasting","wine","wine tasting","beer","brewery","distillery","whisky","whiskey","gin","street food","bbq","barbecue","coffee","cocktail","cocktails","supper club","weinprobe","essen"],
  nightlife: ["club night","dance party","afterparty","dj","rave","techno","house music","nightlife","disco","pub crawl","karaoke","quiz night","pub quiz","salsa night","silent disco"],
  festival: ["festival","fest","market","flea market","christmas market","carnival","parade","fair","street party","markt","flohmarkt","weihnachtsmarkt","volksfest","stadtfest"],
  workshop: ["workshop","class","classes","course","lesson","lessons","seminar","lecture","talk","tutorial","bootcamp","masterclass","pottery","craft","crafts","kurs","vortrag","reading","lesung"],
  community: ["meetup","meet-up","networking","social","meet and greet","language exchange","board games","board game","stammtisch","volunteer","volunteering","community","get together"],
};
// Things actually aimed at children, not just "fine to bring kids to".
const KID_HINTS = ["kids","kid","children","child","childrens","children's","toddler","toddlers","baby","babies","little ones","junior","juniors","family day","family fun","family-friendly","family friendly","for families","puppet","puppet show","storytime","story time","fairy tale","petting zoo","face painting","bouncy castle","lego","soft play","playground","school holiday","school holidays","half term","easter egg hunt","kinder","kinderfest","kindertheater","familienfest","spielplatz","märchen","kinderprogramm"];

function buildHintRegex(hints, flags = "i") {
  const alt = hints.slice().sort((a, b) => b.length - a.length)
    .map((h) => h.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|");
  return new RegExp("(?<!\\w)(?:" + alt + ")(?!\\w)", flags);
}
const TYPE_RES = Object.fromEntries(Object.entries(TYPE_HINTS).map(([k, h]) => [k, buildHintRegex(h)]));
const KID_RE = buildHintRegex(KID_HINTS);
const ldName = (x) => String(x).split("/").pop();

function typeFromText(text) {
  let best = null;
  TYPES.forEach(([key], order) => {
    const rx = TYPE_RES[key]; if (!rx) return;
    const m = rx.exec((text || "").toLowerCase());
    if (m && (!best || m.index < best[0] || (m.index === best[0] && order < best[1]))) best = [m.index, order, key];
  });
  return best ? best[2] : null;
}
function sourceType(source) {
  const m = /[·/]\s*(\w+)\)?\s*$/.exec(source || "");
  return m ? SOURCE_TYPES[m[1].toLowerCase()] || null : null;
}
function eventType(title, description, ldTypes, source) {
  for (const x of ldTypes || []) if (LD_TYPES[ldName(x)]) return LD_TYPES[ldName(x)];
  return typeFromText(title) || sourceType(source) || typeFromText(description)
    || (/^meetup/i.test(source || "") ? "community" : null) || "unknown";
}
function autoTags(title, description, ldTypes) {
  const kids = (ldTypes || []).some((x) => ldName(x) === "ChildrensEvent")
    || KID_RE.test(`${title} \n ${description || ""}`);
  return kids ? ["kids"] : [];
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
// cityLocal is the native-language name — some event sites slug by it
// (Nominatim gives "Hanover", AllEvents wants "hannover").
async function resolvePlace(query) {
  const data = await nominatim(`search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1&namedetails=1`);
  if (!data.length) return null;
  const t = data[0];
  return {
    lat: parseFloat(t.lat), lon: parseFloat(t.lon), label: t.display_name || query,
    city: cityFromAddr(t.address) || query, cityLocal: t.namedetails?.name || "",
    cc: (t.address?.country_code || "").toLowerCase(),
  };
}
async function resolveCoords(lat, lon) {
  let label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`, addr = null, cityLocal = "";
  try {
    const d = await nominatim(`reverse?lat=${lat}&lon=${lon}&format=json&zoom=14&namedetails=1`);
    label = d.display_name || label; addr = d.address; cityLocal = d.namedetails?.name || "";
  } catch (e) { /* keep coords label */ }
  return { lat, lon, label, city: cityFromAddr(addr), cityLocal, cc: (addr?.country_code || "").toLowerCase() };
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
      const ldTypes = [].concat(node["@type"] || []).map(String);
      out.push({ id, title, url, source: sourceName, description, start,
        end: txt(node.endDate), image: txt(node.image), address: lf.address, locality: lf.locality,
        lat: lf.lat, lon: lf.lon, type: eventType(title, description, ldTypes, sourceName),
        autoTags: autoTags(title, description, ldTypes), tags: [] });
    }
  });
  return out;
}
async function fetchSource(url) {
  const resp = await fetch(CORS_PROXY(url), { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) { const e = new Error("proxy " + resp.status); e.status = resp.status; throw e; }
  return resp.text();
}

// ---- AllEvents: origin city + nearby towns --------------------------------
function stripDiacritics(s) { return s.normalize("NFKD").replace(/\p{M}+/gu, ""); }
function nameToSlugs(name) {
  const base = name.trim().toLowerCase().replace(/ /g, "-");
  return [...new Set([base, stripDiacritics(base)].filter(Boolean))];
}
// Try slug variants of a place name against AllEvents /all; returns the best
// {slug, html, near}. Throws if the proxy itself is unreachable/blocked.
async function fetchAllEventsAll(name, olat, olon, rangeKm) {
  let best = { slug: null, html: null, near: 0 }, lastErr = null;
  for (const slug of nameToSlugs(name)) {
    let html;
    try { html = await fetchSource(`https://allevents.in/${encodeURIComponent(slug)}/all`); }
    catch (e) { if (e.status !== 404) lastErr = e; continue; }   // 404 = no page for this slug
    const near = extractEvents(html, "AllEvents").filter((e) =>
      e.lat != null && haversine(olat, olon, e.lat, e.lon) <= rangeKm).length;
    if (near > 0) return { slug, html, near };
    if (best.html == null) best = { slug, html, near };
  }
  if (best.html == null && lastErr) throw lastErr;
  return best;
}
async function gatherAllEvents(place, rangeKm, log) {
  const names = [], has = (n) => names.some((x) => x.toLowerCase() === n.toLowerCase());
  for (const n of [place.cityLocal, place.city]) if (n && !has(n)) names.push(n);
  // A town centre can sit just outside the range while its events fall inside.
  for (const n of await nearbyLocalities(place.lat, place.lon, rangeKm + 20)) if (!has(n)) names.push(n);

  const out = [], seen = new Set(), scored = [];
  const add = (evs) => { for (const e of evs) if (!seen.has(e.id)) { seen.add(e.id); out.push(e); } };
  let failures = 0;   // consecutive proxy failures (not just "no such town page")
  for (const name of names.slice(0, 8)) {
    let r;
    try { r = await fetchAllEventsAll(name, place.lat, place.lon, rangeKm); }
    catch (e) {
      // The CORS proxy is often blocked by AllEvents; stop early rather than
      // waiting out a timeout for every nearby town.
      if (++failures >= 2) { log.push(`AllEvents: unavailable in-browser (${e.message})`); break; }
      continue;
    }
    failures = 0;
    if (r.html == null) continue;
    add(extractEvents(r.html, `AllEvents (${name})`));
    if (r.near > 0) { scored.push([r.near, r.slug, name]); log.push(`AllEvents · ${name}: ${r.near} nearby event(s)`); }
  }
  scored.sort((a, b) => b[0] - a[0]);
  for (const [, slug, name] of scored.slice(0, 1)) {   // deepen the best locality
    for (const cat of ALLEVENTS_CATEGORIES) {
      try { add(extractEvents(await fetchSource(`https://allevents.in/${encodeURIComponent(slug)}/${cat}`), `AllEvents (${name}/${cat})`)); }
      catch (e) { /* skip this category */ }
    }
  }
  return out;
}

function effectiveTags(ev) {
  const t = new Set(ev.autoTags);
  const ov = store.overrides[ev.id];
  if (ov) { (ov.add || []).forEach((x) => t.add(x)); (ov.remove || []).forEach((x) => t.delete(x)); }
  return [...t].filter((x) => TAGS.includes(x));   // drops retired "date"/"family" overrides
}

// ---- permanent places (OpenStreetMap / Overpass, CORS-enabled) ------------
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const POI_KEYS = ["tourism", "leisure", "amenity", "historic", "natural"];
// "key|value": [label, type, kid friendly] — kid friendly only for places
// actually aimed at children (a playground, not a park).
const POI_CATS = {
  "tourism|museum": ["Museum", "museum", false],
  "tourism|gallery": ["Gallery", "art", false],
  "tourism|zoo": ["Zoo", "animals", true],
  "tourism|theme_park": ["Theme park", "attraction", true],
  "tourism|aquarium": ["Aquarium", "animals", true],
  "tourism|attraction": ["Attraction", "attraction", false],
  "tourism|viewpoint": ["Viewpoint", "park", false],
  "tourism|artwork": ["Public art", "art", false],
  "leisure|park": ["Park", "park", false],
  "leisure|garden": ["Garden", "park", false],
  "leisure|nature_reserve": ["Nature reserve", "park", false],
  "leisure|water_park": ["Water park", "water", true],
  "leisure|miniature_golf": ["Mini golf", "attraction", false],
  "leisure|golf_course": ["Golf course", "sport", false],
  "leisure|sports_centre": ["Sports centre", "sport", false],
  "leisure|swimming_pool": ["Swimming pool", "water", false],
  "leisure|bathing_place": ["Bathing spot", "water", false],
  "leisure|horse_riding": ["Horse riding", "sport", false],
  "leisure|playground": ["Playground", "play", true],
  "leisure|bird_hide": ["Bird hide", "park", false],
  "amenity|cinema": ["Cinema", "film", false],
  "amenity|theatre": ["Theatre", "theatre", false],
  "amenity|arts_centre": ["Arts centre", "art", false],
  "amenity|public_bath": ["Swimming pool", "water", false],
  "historic|castle": ["Castle", "museum", false],
  "historic|monument": ["Monument", "museum", false],
  "historic|memorial": ["Memorial", "museum", false],
  "historic|ruins": ["Ruins", "museum", false],
  "natural|beach": ["Beach", "water", false],
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
  // Water parks keep their own label (they're aimed at kids).
  if (tags.leisure === "water_park") return POI_CATS["leisure|water_park"];
  const sport = (tags.sport || "").toLowerCase();
  if (sport.includes("swimming") || tags.leisure === "swimming_pool" || tags.amenity === "public_bath") {
    return ["Swimming pool", "water", false];
  }
  for (const key of POI_KEYS) {
    const v = tags[key]; if (v && POI_CATS[`${key}|${v}`]) return POI_CATS[`${key}|${v}`];
  }
  return null;
}
// Run an Overpass query against every mirror at once; first answer wins.
async function runOverpass(q) {
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
  try { return await Promise.any(OVERPASS.map(tryEndpoint)); } catch (e) { return null; }
}
// Nearest named towns/cities within the radius — used to look up events in
// neighbouring places, not just the origin's own (which may have none).
async function nearbyLocalities(lat, lon, radiusKm, limit = 8) {
  const r = Math.round(radiusKm * 1000);
  const q = `[out:json][timeout:40];(node(around:${r},${lat},${lon})[place~"^(city|town)$"];);out 200;`;
  const elements = (await runOverpass(q)) || [];
  const scored = [];
  for (const e of elements) {
    const name = e.tags?.name;
    if (name && e.lat != null && e.lon != null) scored.push([haversine(lat, lon, e.lat, e.lon), name]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  const seen = new Set(), names = [];
  for (const [, n] of scored) if (!seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); names.push(n); }
  return names.slice(0, limit);
}
async function fetchPlaces(lat, lon, rangeKm) {
  const elements = await runOverpass(overpassQuery(lat, lon, Math.round(rangeKm * 1000)));
  if (!elements) return [];

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
      locality: tags["addr:city"] || "", lat: +plat, lon: +plon, type: cat[1], autoTags: cat[2] ? ["kids"] : [], tags: [] });
  }
  // nearest first, then cap — so a close area is never truncated away
  out.sort((a, b) => haversine(lat, lon, a.lat, a.lon) - haversine(lat, lon, b.lat, b.lon));
  return out.slice(0, 120);
}
const WINDOW_DAYS = 365;           // events are kept for a year…
let viewWindow = 14;               // …but the slider views two weeks by default
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
      type: eventType(s.t, s.d, [], "Sample"), autoTags: autoTags(s.t, s.d), tags: [],
    };
  });
}

async function runSearch(place, rangeKm, log) {
  const collected = new Map();

  // 1) scheduled events in the next year (undated listings kept too).
  //    Non-AllEvents sources (e.g. Meetup) are queried by the origin city.
  const found = [];
  for (const src of SOURCES) {
    if (src.url.includes("allevents.in")) continue;
    try {
      const evs = extractEvents(await fetchSource(buildUrl(src.url, place)), src.name);
      log.push(`${src.name}: ${evs.length} event(s) with structured data`);
      found.push(...evs);
    } catch (e) {
      log.push(`${src.name}: live scrape unavailable in-browser (${e.message})`);
    }
  }
  //    AllEvents: the origin city AND nearby towns within the radius, so a
  //    remote location still finds events in neighbouring places.
  if (SOURCES.some((s) => s.url.includes("allevents.in"))) {
    found.push(...await gatherAllEvents(place, rangeKm, log));
  }
  let dropped = 0;
  for (const ev of found) {
    if (withinWindow(ev.start) === false) { dropped++; continue; }
    if (!collected.has(ev.id)) collected.set(ev.id, ev);
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
function activeFilters() {
  const types = new Set();
  document.querySelectorAll(".type-filter:checked").forEach((c) => types.add(c.value));
  return { types, onlyKids: el("#only-kids").checked, events: el("#show-events").checked, permanent: el("#show-permanent").checked };
}
// Type filter chips, built from TYPES; switched-off types are remembered.
const TYPE_FILTER_KEY = "lef_hidden_types";
function saveTypeFilter() {
  const hidden = [...document.querySelectorAll(".type-filter")].filter((c) => !c.checked).map((c) => c.value);
  try { localStorage.setItem(TYPE_FILTER_KEY, JSON.stringify(hidden)); } catch (e) { /* ignore */ }
}
function buildTypeFilters() {
  let hidden = [];
  try { hidden = JSON.parse(localStorage.getItem(TYPE_FILTER_KEY) || "[]"); } catch (e) { /* ignore */ }
  const box = el("#type-chips");
  for (const [key, label, color] of TYPES) {
    const chip = document.createElement("label");
    chip.className = "chip-toggle type-chip"; chip.style.setProperty("--type-color", color);
    chip.innerHTML = `<input type="checkbox" class="type-filter" value="${key}" ${hidden.includes(key) ? "" : "checked"} /><span>${esc(label)}</span>`;
    chip.querySelector("input").addEventListener("change", () => { saveTypeFilter(); render(); });
    box.appendChild(chip);
  }
}
function setAllTypes(on) {
  document.querySelectorAll(".type-filter").forEach((c) => { c.checked = on; });
  saveTypeFilter(); render();
}

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
  fill.style.left = (lo / viewWindow) * 100 + "%";
  fill.style.width = ((hi - lo) / viewWindow) * 100 + "%";
  el("#date-label").textContent =
    lo === 0 && hi === viewWindow
      ? (viewWindow >= 365 ? "next 12 months" : "next 2 weeks")
      : `${labelForDay(lo)} → ${labelForDay(hi)}`;
}
// Switch the date-slider span between 2 weeks and a year (client-side only).
function setViewWindow(days) {
  viewWindow = days;
  const mn = el("#day-min"), mx = el("#day-max");
  mn.max = String(days); mx.max = String(days);
  mn.value = "0"; mx.value = String(days);
  updateDateUI();
  render();
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
    if (ev.permanent ? !filters.permanent : !filters.events) return false;
    if (!filters.types.has(ev.type || "unknown")) return false;
    if (filters.onlyKids && !ev.tags.includes("kids")) return false;
    return true;
  });
  if (!allEvents.length) return;
  if (!shown.length) { box.innerHTML = '<p class="empty">Nothing matches these filters. Widen the distance or date range, or turn on more types.</p>'; return; }
  for (const ev of shown) {
    const card = document.createElement("article"); card.className = "card event";
    const type = TYPE_BY_KEY[ev.type] || TYPE_BY_KEY.unknown;
    card.style.setProperty("--type-color", type.color);
    const whenText = ev.permanent
      ? `${ev.category || "Place"} · ${ev.hours ? prettyHours(ev.hours) : "permanent"}`
      : fmtWhenRange(ev.start, ev.end);
    const descText = ev.permanent ? "" : (ev.description || "");
    card.innerHTML = `<div class="event-main">
      <h3 class="event-title"><a target="_blank" rel="noopener" href="${esc(ev.url || "#")}">${esc(ev.title)}</a></h3>
      <p class="event-meta"><span>${esc(whenText)}</span><span class="dot">·</span>
        <a class="event-dist" target="_blank" rel="noopener" title="Open in Google Maps" href="${esc(mapsUrl(ev))}">${ev.distance_km} km${ev.direction ? " " + esc(ev.direction) : ""}</a>${ev.locality ? `<span>· ${esc(ev.locality)}</span>` : ""}</p>
      ${descText ? `<p class="event-desc">${esc(descText)}</p>` : ""}
    </div><div class="event-tags"><span class="type-tag">${esc(type.label)}</span></div>`;
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
buildTypeFilters();
el("#types-all").onclick = () => setAllTypes(true);
el("#types-none").onclick = () => setAllTypes(false);
["#only-kids", "#show-events", "#show-permanent"].forEach((id) => el(id).addEventListener("change", render));

function onDaySlide(e) {
  const mn = el("#day-min"), mx = el("#day-max");
  let a = Number(mn.value), b = Number(mx.value);
  if (a > b) { if (e.target === mn) mx.value = a; else mn.value = b; }
  updateDateUI();
  render();
}
el("#day-min").addEventListener("input", onDaySlide);
el("#day-max").addEventListener("input", onDaySlide);
const extendEl = el("#extend-year");
if (extendEl) extendEl.addEventListener("change", () => setViewWindow(extendEl.checked ? 365 : 14));
setViewWindow(14);   // default to a two-week view
document.querySelectorAll("[data-app-version]").forEach((n) => (n.textContent = "v" + APP_VERSION));
setStatus("Share your location or type a place to start.");

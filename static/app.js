"use strict";

const TAGS = window.APP_TAGS || [];
const TAG_LABELS = window.APP_TAG_LABELS || {};

const el = (sel) => document.querySelector(sel);
const statusEl = el("#status");
const resultsEl = el("#results");
const rangeEl = el("#range");
const rangeVal = el("#range-val");
const logEl = el("#log");
const dayMinEl = el("#day-min");
const dayMaxEl = el("#day-max");
const dateFillEl = el("#date-fill");
const dateLabelEl = el("#date-label");
const WINDOW_DAYS = 14;

let allEvents = [];      // everything the last search returned
let lastSearchRange = 40;

// ---------------------------------------------------------------- helpers
function setStatus(msg, isError = false, busy = false) {
  statusEl.classList.toggle("error", isError);
  statusEl.innerHTML = (busy ? '<span class="spinner"></span>' : "") + msg;
}

function mapsUrl(ev) {
  // drop a pin at the venue; fall back to searching the name if no coords
  if (ev.lat != null && ev.lon != null) {
    return `https://www.google.com/maps/search/?api=1&query=${ev.lat}%2C${ev.lon}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.title)}`;
}

function fmtWhen(iso) {
  if (!iso) return "Date TBC";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const opts = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  return d.toLocaleString(undefined, opts);
}

function activeTagFilters() {
  const on = new Set();
  document.querySelectorAll(".tag-filter:checked").forEach((c) => on.add(c.value));
  return on;
}

// ---- date range (dual slider, day offsets within the 2-week window) ----
function dayOffset(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return Math.floor((t - start.getTime()) / 86400000);
}
function labelForDay(offset) {
  if (offset <= 0) return "today";
  if (offset === 1) return "tomorrow";
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
function updateDateUI() {
  const a = Number(dayMinEl.value), b = Number(dayMaxEl.value);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  dateFillEl.style.left = (lo / WINDOW_DAYS) * 100 + "%";
  dateFillEl.style.width = ((hi - lo) / WINDOW_DAYS) * 100 + "%";
  dateLabelEl.textContent =
    lo === 0 && hi === WINDOW_DAYS ? "next 2 weeks" : `${labelForDay(lo)} → ${labelForDay(hi)}`;
}
function inDateRange(ev) {
  if (ev.permanent) return true;          // any-day places always qualify
  const off = dayOffset(ev.start);
  if (off === null) return true;          // undated / recurring listings
  const lo = Math.min(Number(dayMinEl.value), Number(dayMaxEl.value));
  const hi = Math.max(Number(dayMinEl.value), Number(dayMaxEl.value));
  return Math.max(off, 0) >= lo && Math.max(off, 0) <= hi;
}

// --------------------------------------------------------------- rendering
function passesFilter(ev, filters, maxRange) {
  if (ev.distance_km != null && ev.distance_km > maxRange) return false;
  if (!inDateRange(ev)) return false;
  const tags = ev.tags || [];
  if (tags.length === 0) return filters.has("__untagged__");
  return tags.some((t) => filters.has(t));
}

function render() {
  const filters = activeTagFilters();
  const maxRange = Number(rangeEl.value);
  resultsEl.innerHTML = "";

  const shown = allEvents.filter((ev) => passesFilter(ev, filters, maxRange));
  if (allEvents.length === 0) {
    return; // nothing searched yet, keep results empty
  }
  if (shown.length === 0) {
    resultsEl.innerHTML =
      '<p class="empty">Nothing matches these filters. Try widening the distance or date range, or turning on more tags.</p>';
    return;
  }

  const tpl = el("#card-tpl");
  for (const ev of shown) {
    const node = tpl.content.cloneNode(true);
    const a = node.querySelector(".event-title a");
    a.textContent = ev.title;
    a.href = ev.url || "#";
    node.querySelector(".event-when").textContent =
      ev.permanent ? `${ev.category || "Place"} · open any day` : fmtWhen(ev.start);
    const distEl = node.querySelector(".event-dist");
    if (ev.distance_km != null) {
      distEl.textContent = `${ev.distance_km} km away`;
      distEl.href = mapsUrl(ev);
    } else {
      distEl.remove();
    }
    node.querySelector(".event-where").textContent = ev.locality ? `· ${ev.locality}` : "";
    node.querySelector(".event-desc").textContent = ev.description || "";

    const tagWrap = node.querySelector(".event-tags");
    for (const tag of TAGS) {
      const btn = document.createElement("button");
      btn.className = "tag-btn";
      btn.dataset.tag = tag;
      btn.type = "button";
      const on = (ev.tags || []).includes(tag);
      btn.classList.toggle("on", on);
      btn.textContent = (on ? "✓ " : "+ ") + (TAG_LABELS[tag] || tag);
      btn.addEventListener("click", () => toggleTag(ev, tag, btn));
      tagWrap.appendChild(btn);
    }
    resultsEl.appendChild(node);
  }
}

// ------------------------------------------------------------ tag toggling
async function toggleTag(ev, tag, btn) {
  const currentlyOn = (ev.tags || []).includes(tag);
  const wasAuto = (ev.auto_tags || []).includes(tag);
  const newState = !currentlyOn;

  // optimistic UI
  ev.tags = newState
    ? Array.from(new Set([...(ev.tags || []), tag]))
    : (ev.tags || []).filter((t) => t !== tag);
  btn.classList.toggle("on", newState);
  btn.textContent = (newState ? "✓ " : "+ ") + (TAG_LABELS[tag] || tag);

  try {
    await fetch(`/api/events/${ev.id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, state: newState, auto: wasAuto }),
    });
  } catch (e) {
    setStatus("Couldn't save that tag (offline?)", true);
  }
  // If a now-hidden filter excludes it, re-render to respect the filter.
  render();
}

// --------------------------------------------------------------- searching
async function search(payload) {
  setStatus("Searching for events…", false, true);
  el("#btn-search").disabled = true;
  el("#btn-geo").disabled = true;
  try {
    const resp = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, range_km: Number(rangeEl.value) }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setStatus(data.error || "Search failed.", true);
      return;
    }
    allEvents = data.events || [];
    lastSearchRange = data.range_km;
    logEl.innerHTML = (data.log || []).map((l) => `<li>${escapeHtml(l)}</li>`).join("");
    const near = data.place && data.place.label ? data.place.label.split(",").slice(0, 2).join(", ") : "you";
    setStatus(`${allEvents.length} event(s) found within ${data.range_km} km of ${escapeHtml(near)}.`);
    render();
  } catch (e) {
    setStatus("Network error while searching.", true);
  } finally {
    el("#btn-search").disabled = false;
    el("#btn-geo").disabled = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ------------------------------------------------------------------ events
el("#btn-search").addEventListener("click", () => {
  const name = el("#loc-name").value.trim();
  if (!name) {
    setStatus("Type a town or city, or use your device location.", true);
    return;
  }
  search({ location: name });
});

el("#loc-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") el("#btn-search").click();
});

el("#btn-geo").addEventListener("click", () => {
  if (!navigator.geolocation) {
    setStatus("This browser can't share a location. Type a place name instead.", true);
    return;
  }
  setStatus("Asking your device for its location…", false, true);
  navigator.geolocation.getCurrentPosition(
    (pos) => search({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
    (err) => setStatus("Location permission denied. Type a place name instead.", true),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
});

rangeEl.addEventListener("input", () => {
  rangeVal.textContent = rangeEl.value;
  render(); // live client-side range filtering
});

document.querySelectorAll(".tag-filter").forEach((c) =>
  c.addEventListener("change", render)
);

function onDaySlide(e) {
  // keep the two thumbs from crossing
  let a = Number(dayMinEl.value), b = Number(dayMaxEl.value);
  if (a > b) {
    if (e.target === dayMinEl) dayMaxEl.value = a;
    else dayMinEl.value = b;
  }
  updateDateUI();
  render();
}
dayMinEl.addEventListener("input", onDaySlide);
dayMaxEl.addEventListener("input", onDaySlide);

// ------------------------------------------------------------------ startup
(function init() {
  if (window.APP_RANGE) {
    rangeEl.value = Math.min(40, window.APP_RANGE);
    rangeVal.textContent = rangeEl.value;
  }
  updateDateUI();
  if (window.APP_HOME && window.APP_HOME.label) {
    el("#loc-name").value = window.APP_HOME.label.split(",")[0];
    setStatus(`Last time you searched near ${escapeHtml(window.APP_HOME.label.split(",").slice(0,2).join(", "))}. Search again to refresh.`);
  } else {
    setStatus("Share your location or type a place to start.");
  }
})();

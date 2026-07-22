package com.therealdeltrex.localeventfinder.data

import android.text.Html
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

/**
 * The scraping pipeline, ported from the web app's scraper.py.
 *
 * Reads the structured schema.org `Event` data (JSON-LD) that most event sites
 * embed for search engines, so one extractor works across many sites. Offline
 * events with a geocodable address are kept; online-only events are skipped.
 */
class Scraper(private val client: OkHttpClient, private val geo: Geo) {

    private val places = Places(client)

    private val browserUa =
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/125.0 Mobile Safari/537.36"

    // ---- fetching --------------------------------------------------------
    private suspend fun fetch(url: String): String? = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(url)
            .header("User-Agent", browserUa)
            .header("Accept-Language", "en,de")
            .build()
        try {
            client.newCall(req).execute().use { resp ->
                if (resp.code == 200) resp.body?.string() else null
            }
        } catch (e: Exception) {
            null
        }
    }

    // ---- AllEvents city-slug resolution ---------------------------------
    private fun stripDiacritics(s: String): String =
        java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFKD)
            .replace(Regex("\\p{M}+"), "")

    private fun nameToSlugs(name: String): List<String> {
        val base = name.trim().lowercase().replace(" ", "-")
        val out = LinkedHashSet<String>()
        if (base.isNotEmpty()) out.add(base)
        val ascii = stripDiacritics(base)
        if (ascii.isNotEmpty()) out.add(ascii)
        return out.toList()
    }

    private data class LocalityAll(val slug: String?, val html: String?, val near: Int)

    /** Try slug variants of a place name against AllEvents /all. */
    private suspend fun fetchAllEventsAll(
        name: String, olat: Double, olon: Double, rangeKm: Double,
    ): LocalityAll {
        var best = LocalityAll(null, null, 0)
        for (slug in nameToSlugs(name)) {
            val html = fetch("https://allevents.in/${java.net.URLEncoder.encode(slug, "UTF-8")}/all")
                ?: continue
            val near = extractEvents(html, "AllEvents").count {
                it.lat != null && Geo.haversineKm(olat, olon, it.lat!!, it.lon!!) <= rangeKm
            }
            if (near > 0) return LocalityAll(slug, html, near)
            if (best.html == null) best = LocalityAll(slug, html, near)
        }
        return best
    }

    /** Collect AllEvents listings for the origin city AND nearby towns within
     *  the radius, so a remote location still finds events nearby. */
    private suspend fun gatherAllEvents(
        place: Place, olat: Double, olon: Double, rangeKm: Double, log: MutableList<String>,
    ): List<Event> {
        val names = LinkedHashSet<String>()
        for (n in listOf(place.cityLocal, place.city)) if (n.isNotBlank()) names.add(n)
        // A town centre can sit just outside the range while its events fall in.
        for (n in places.nearbyLocalities(olat, olon, rangeKm + 20)) names.add(n)

        val out = ArrayList<Event>()
        val seen = HashSet<String>()
        val scored = ArrayList<Triple<Int, String, String>>()  // near, slug, name
        fun add(events: List<Event>) { for (e in events) if (seen.add(e.id)) out.add(e) }

        for (name in names.take(8)) {
            val r = fetchAllEventsAll(name, olat, olon, rangeKm)
            if (r.html == null) continue
            add(extractEvents(r.html, "AllEvents ($name)"))
            if (r.near > 0 && r.slug != null) {
                scored.add(Triple(r.near, r.slug, name))
                log.add("AllEvents · $name: ${r.near} nearby event(s)")
            }
        }
        scored.sortByDescending { it.first }
        scored.take(1).forEach { (_, slug, name) ->
            for (cat in listOf("music", "theatre", "comedy", "arts", "nightlife")) {
                val html = fetch("https://allevents.in/${java.net.URLEncoder.encode(slug, "UTF-8")}/$cat")
                if (html != null) add(extractEvents(html, "AllEvents ($name/$cat)"))
            }
        }
        return out
    }

    // ---- JSON-LD extraction ---------------------------------------------
    /** Collect every JSON object node, unwrapping @graph and arrays. */
    private fun collectNodes(root: Any, out: MutableList<JSONObject>) {
        when (root) {
            is JSONArray -> for (i in 0 until root.length()) collectNodes(root.get(i), out)
            is JSONObject -> {
                out.add(root)
                val graph = root.opt("@graph")
                if (graph is JSONArray) collectNodes(graph, out)
            }
        }
    }

    private fun isEvent(node: JSONObject): Boolean {
        val t = node.opt("@type") ?: return false
        val types = if (t is JSONArray) (0 until t.length()).map { t.getString(it) } else listOf(t.toString())
        return types.any { it.contains("Event") }
    }

    private fun text(value: Any?): String {
        val v = when (value) {
            is JSONArray -> if (value.length() > 0) value.get(0) else ""
            else -> value
        }
        val s = when (v) {
            is JSONObject -> v.optString("name", v.optString("url", ""))
            null -> ""
            else -> v.toString()
        }
        return Html.fromHtml(s, Html.FROM_HTML_MODE_LEGACY).toString().trim()
    }

    private data class Loc(
        val address: String, val locality: String, val lat: Double?, val lon: Double?,
    )

    private fun locationFields(node: JSONObject): Loc {
        val raw = node.opt("location")
        val loc = when (raw) {
            is JSONArray -> if (raw.length() > 0) raw.optJSONObject(0) else null
            is JSONObject -> raw
            else -> null
        } ?: return Loc("", "", null, null)

        if (loc.optString("@type", "").contains("Virtual")) return Loc("", "", null, null)

        var lat: Double? = null
        var lon: Double? = null
        loc.optJSONObject("geo")?.let { g ->
            lat = g.optString("latitude").toDoubleOrNull()
            lon = g.optString("longitude").toDoubleOrNull()
        }

        var locality = ""
        val parts = ArrayList<String>()
        when (val addr = loc.opt("address")) {
            is JSONObject -> {
                locality = addr.optString("addressLocality", "")
                for (key in listOf("streetAddress", "addressLocality", "postalCode", "addressCountry")) {
                    val v = addr.optString(key, "")
                    if (v.isNotEmpty() && v !in parts) parts.add(v)
                }
            }
            is String -> if (addr.isNotEmpty()) parts.add(addr)
        }
        val name = loc.optString("name", "")
        val address = (if (name.isNotEmpty()) listOf(name) else emptyList()).plus(parts)
            .filter { it.isNotEmpty() }.joinToString(", ")
        return Loc(unescape(address), unescape(locality), lat, lon)
    }

    private fun unescape(s: String) =
        Html.fromHtml(s, Html.FROM_HTML_MODE_LEGACY).toString()

    fun extractEvents(html: String, sourceName: String): List<Event> {
        val doc = Jsoup.parse(html)
        val events = ArrayList<Event>()
        val seen = HashSet<String>()
        for (script in doc.select("script[type=application/ld+json]")) {
            val raw = script.data().trim()
            if (raw.isEmpty()) continue
            val parsed: Any = runCatching { JSONObject(raw) }.getOrNull()
                ?: runCatching { JSONArray(raw) }.getOrNull()
                ?: continue
            val nodes = ArrayList<JSONObject>()
            collectNodes(parsed, nodes)
            for (node in nodes) {
                if (!isEvent(node)) continue
                val title = text(node.opt("name"))
                if (title.isEmpty()) continue
                val url = text(node.opt("url"))
                val start = text(node.opt("startDate"))
                val eid = eventId(url, title, start)
                if (!seen.add(eid)) continue
                val loc = locationFields(node)
                val description = text(node.opt("description"))
                events.add(
                    Event(
                        id = eid,
                        title = title,
                        url = url,
                        source = sourceName,
                        description = description,
                        start = start,
                        end = text(node.opt("endDate")),
                        image = text(node.opt("image")),
                        address = loc.address,
                        locality = loc.locality,
                        lat = loc.lat,
                        lon = loc.lon,
                        autoTags = Tagging.autoTags(title, description),
                    )
                )
            }
        }
        return events
    }

    // ---- full run --------------------------------------------------------
    /**
     * Scrape enabled sources, geocode, distance-filter to [rangeKm], and apply
     * the user's manual tag overrides. [log] receives human-readable progress.
     */
    suspend fun runSearch(
        place: Place,
        sources: List<Source>,
        rangeKm: Double,
        overrides: Map<String, TagOverride>,
        log: MutableList<String>,
        windowDays: Long = 365,
        includePlaces: Boolean = true,
    ): List<Event> {
        val enabled = sources.filter { it.enabled }
        val collected = LinkedHashMap<String, Event>()

        // Non-AllEvents sources (e.g. Meetup) — queried by the origin city.
        for (src in enabled) {
            if (src.url.contains("allevents.in")) continue
            val html = fetch(Sources.buildUrl(src.url, place))
            if (html == null) {
                log.add("${src.name}: could not fetch")
                continue
            }
            val found = extractEvents(html, src.name)
            log.add("${src.name}: ${found.size} event(s) with structured data")
            for (ev in found) collected.putIfAbsent(ev.id, ev)
        }

        // AllEvents: origin city AND nearby towns within the radius.
        if (enabled.any { it.url.contains("allevents.in") }) {
            for (ev in gatherAllEvents(place, place.lat, place.lon, rangeKm, log)) {
                collected.putIfAbsent(ev.id, ev)
            }
        }

        val now = Instant.now()
        val windowStart = now.minus(1, ChronoUnit.DAYS)
        val windowEnd = now.plus(windowDays, ChronoUnit.DAYS)
        val results = ArrayList<Event>()
        var droppedOld = 0
        for (ev in collected.values) {
            // Keep events in the next `windowDays`; undated listings are kept.
            val dt = parseStart(ev.start)
            if (dt != null && (dt.isBefore(windowStart) || dt.isAfter(windowEnd))) {
                droppedOld++
                continue
            }
            if (ev.lat == null || ev.lon == null) {
                val query = ev.address.ifEmpty { ev.locality }
                if (query.isEmpty()) continue
                val loc = geo.geocode(query) ?: continue
                ev.lat = loc.lat
                ev.lon = loc.lon
            }
            val d = Geo.haversineKm(place.lat, place.lon, ev.lat!!, ev.lon!!)
            ev.distanceKm = Math.round(d * 10) / 10.0
            if (ev.distanceKm!! > rangeKm) continue
            ev.direction = if (ev.distanceKm!! > 0) Geo.compass16(place.lat, place.lon, ev.lat!!, ev.lon!!) else ""
            ev.tags = effectiveTags(ev, overrides[ev.id])
            results.add(ev)
        }
        if (droppedOld > 0) log.add("skipped $droppedOld event(s) outside the next $windowDays days")

        // Permanent places you can visit any day (OpenStreetMap).
        if (includePlaces) {
            val existing = results.map { it.id }.toHashSet()
            var added = 0
            for (ev in places.fetch(place.lat, place.lon, rangeKm)) {
                if (ev.id in existing) continue
                val d = Geo.haversineKm(place.lat, place.lon, ev.lat!!, ev.lon!!)
                ev.distanceKm = Math.round(d * 10) / 10.0
                if (ev.distanceKm!! > rangeKm) continue
                ev.direction = if (ev.distanceKm!! > 0) Geo.compass16(place.lat, place.lon, ev.lat!!, ev.lon!!) else ""
                ev.tags = effectiveTags(ev, overrides[ev.id])
                results.add(ev)
                added++
            }
            log.add("$added permanent place(s) from OpenStreetMap")
        }

        // Upcoming dated events first (by date), then undated events, then
        // permanent places (nearest first).
        results.sortWith(compareBy({ sortGroup(it) }, { sortValue(it) }))
        log.add("${results.size} thing(s) to do within ${rangeKm.toInt()} km")
        return results
    }

    private fun parseStart(s: String): Instant? {
        if (s.isBlank()) return null
        return try {
            OffsetDateTime.parse(s).toInstant()
        } catch (e: Exception) {
            try {
                LocalDate.parse(s.take(10)).atStartOfDay(ZoneOffset.UTC).toInstant()
            } catch (e2: Exception) {
                null
            }
        }
    }

    private fun sortGroup(e: Event): Int =
        if (e.permanent) 2 else if (parseStart(e.start) == null) 1 else 0

    private fun sortValue(e: Event): Double {
        val dt = if (e.permanent) null else parseStart(e.start)
        return dt?.toEpochMilli()?.toDouble() ?: (e.distanceKm ?: 0.0)
    }

    private fun effectiveTags(ev: Event, override: TagOverride?): Set<String> {
        val tags = ev.autoTags.toMutableSet()
        if (override != null) {
            tags.addAll(override.add)
            tags.removeAll(override.remove)
        }
        return tags
    }
}

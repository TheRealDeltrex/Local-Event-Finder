package com.therealdeltrex.localeventfinder.data

import com.therealdeltrex.localeventfinder.BuildConfig
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * Permanent "things to do" from OpenStreetMap via the Overpass API — museums,
 * parks, zoos, galleries, cinemas, castles, mini-golf, beaches and so on.
 * Ported from places.py.
 *
 * Uses `nwr` (nodes + ways + relations) because many attractions are mapped as
 * areas, not points (e.g. the Rømø labyrinth). The three types are output
 * separately so a single result cap can't drop all the areas. The public
 * servers are slow/flaky, so all mirrors are queried in parallel and the first
 * to answer wins.
 */
class Places(client: OkHttpClient) {

    // Overpass can take ~30–40s; give these calls their own generous timeouts.
    private val client = client.newBuilder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(60, TimeUnit.SECONDS)
        .build()

    private val endpoints = listOf(
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    )

    private val keys = listOf("tourism", "leisure", "amenity", "historic", "natural")

    /** label, type and whether it's aimed at kids (a playground, not a park). */
    data class PlaceCat(val label: String, val type: String, val kids: Boolean)

    // "key|value" -> category
    private val cats: Map<String, PlaceCat> = linkedMapOf(
        "tourism|museum" to PlaceCat("Museum", "museum", false),
        "tourism|gallery" to PlaceCat("Gallery", "art", false),
        "tourism|zoo" to PlaceCat("Zoo", "animals", true),
        "tourism|theme_park" to PlaceCat("Theme park", "attraction", true),
        "tourism|aquarium" to PlaceCat("Aquarium", "animals", true),
        "tourism|attraction" to PlaceCat("Attraction", "attraction", false),
        "tourism|viewpoint" to PlaceCat("Viewpoint", "park", false),
        "tourism|artwork" to PlaceCat("Public art", "art", false),
        "leisure|park" to PlaceCat("Park", "park", false),
        "leisure|garden" to PlaceCat("Garden", "park", false),
        "leisure|nature_reserve" to PlaceCat("Nature reserve", "park", false),
        "leisure|water_park" to PlaceCat("Water park", "water", true),
        "leisure|miniature_golf" to PlaceCat("Mini golf", "attraction", false),
        "leisure|golf_course" to PlaceCat("Golf course", "sport", false),
        "leisure|sports_centre" to PlaceCat("Sports centre", "sport", false),
        "leisure|swimming_pool" to PlaceCat("Swimming pool", "water", false),
        "leisure|bathing_place" to PlaceCat("Bathing spot", "water", false),
        "leisure|horse_riding" to PlaceCat("Horse riding", "sport", false),
        "leisure|playground" to PlaceCat("Playground", "play", true),
        "leisure|bird_hide" to PlaceCat("Bird hide", "park", false),
        "amenity|cinema" to PlaceCat("Cinema", "film", false),
        "amenity|theatre" to PlaceCat("Theatre", "theatre", false),
        "amenity|arts_centre" to PlaceCat("Arts centre", "art", false),
        "amenity|public_bath" to PlaceCat("Swimming pool", "water", false),
        "historic|castle" to PlaceCat("Castle", "museum", false),
        "historic|monument" to PlaceCat("Monument", "museum", false),
        "historic|memorial" to PlaceCat("Memorial", "museum", false),
        "historic|ruins" to PlaceCat("Ruins", "museum", false),
        "natural|beach" to PlaceCat("Beach", "water", false),
    )

    private fun query(lat: Double, lon: Double, radiusM: Int): String {
        val byKey = LinkedHashMap<String, MutableList<String>>()
        for (k in cats.keys) {
            val (key, value) = k.split("|")
            byKey.getOrPut(key) { mutableListOf() }.add(value)
        }
        val body = byKey.entries.joinToString("") { (key, vals) ->
            "nwr(around:$radiusM,$lat,$lon)[\"$key\"~\"^(${vals.joinToString("|")})$\"];"
        }
        return "[out:json][timeout:60];($body)->.a;" +
            "node.a;out 300;way.a;out center 300;relation.a;out center 100;"
    }

    private fun categoryOf(tags: JSONObject): PlaceCat? {
        // Public pools are tagged inconsistently — label any of them "Swimming pool".
        // Water parks keep their own label (they're aimed at kids).
        val sport = tags.optString("sport", "").lowercase()
        val leisure = tags.optString("leisure", "")
        if (leisure == "water_park") return cats["leisure|water_park"]
        if (sport.contains("swimming") || leisure == "swimming_pool" ||
            tags.optString("amenity", "") == "public_bath") {
            return PlaceCat("Swimming pool", "water", false)
        }
        for (key in keys) {
            val v = tags.optString(key, "")
            if (v.isNotEmpty()) cats["$key|$v"]?.let { return it }
        }
        return null
    }

    /** POST to one mirror; returns the elements array, or null on any failure. */
    private suspend fun queryOne(endpoint: String, body: String): JSONArray? =
        suspendCancellableCoroutine { cont ->
            val req = Request.Builder()
                .url(endpoint)
                .post(FormBody.Builder().add("data", body).build())
                .header("User-Agent", "LocalEventsFinder-Android/${BuildConfig.VERSION_NAME}")
                .build()
            val call = client.newCall(req)
            cont.invokeOnCancellation { runCatching { call.cancel() } }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (cont.isActive) cont.resume(null)
                }

                override fun onResponse(call: Call, response: Response) {
                    val arr = response.use {
                        try {
                            if (it.code == 200)
                                JSONObject(it.body?.string() ?: "").optJSONArray("elements")
                            else null
                        } catch (e: Exception) {
                            null
                        }
                    }
                    if (cont.isActive) cont.resume(arr)
                }
            })
        }

    /** Race all mirrors; return the first non-null response, cancel the rest. */
    private suspend fun race(body: String): JSONArray? = coroutineScope {
        val deferreds = endpoints.map { ep -> async { queryOne(ep, body) } }
        var result: JSONArray? = null
        val remaining = deferreds.toMutableList()
        while (remaining.isNotEmpty() && result == null) {
            val (winner, res) = select<Pair<Deferred<JSONArray?>, JSONArray?>> {
                remaining.forEach { d -> d.onAwait { d to it } }
            }
            remaining.remove(winner)
            if (res != null) result = res
        }
        deferreds.forEach { it.cancel() }
        result
    }

    /** Nearest named towns/cities within the radius (for querying event sites). */
    suspend fun nearbyLocalities(lat: Double, lon: Double, radiusKm: Double, limit: Int = 8): List<String> {
        val radiusM = (radiusKm * 1000).toInt()
        val q = "[out:json][timeout:40];(node(around:$radiusM,$lat,$lon)[place~\"^(city|town)$\"];);out 200;"
        val elements = race(q) ?: return emptyList()
        val scored = ArrayList<Pair<Double, String>>()
        for (i in 0 until elements.length()) {
            val el = elements.optJSONObject(i) ?: continue
            val name = el.optJSONObject("tags")?.optString("name", "").orEmpty()
            if (name.isEmpty() || !el.has("lat") || !el.has("lon")) continue
            scored.add(Geo.haversineKm(lat, lon, el.optDouble("lat"), el.optDouble("lon")) to name)
        }
        scored.sortBy { it.first }
        val seen = HashSet<String>()
        val names = ArrayList<String>()
        for ((_, n) in scored) if (seen.add(n.lowercase())) names.add(n)
        return names.take(limit)
    }

    suspend fun fetch(lat: Double, lon: Double, radiusKm: Double, limit: Int = 120): List<Event> {
        val elements = race(query(lat, lon, (radiusKm * 1000).toInt())) ?: return emptyList()

        val seen = HashSet<String>()
        val out = ArrayList<Event>()
        for (i in 0 until elements.length()) {
            val el = elements.optJSONObject(i) ?: continue
            val tags = el.optJSONObject("tags") ?: continue
            val name = tags.optString("name", "")
            if (name.isEmpty()) continue
            val cat = categoryOf(tags) ?: continue
            val center = el.optJSONObject("center")
            val plat = if (el.has("lat")) el.optDouble("lat") else center?.optDouble("lat") ?: continue
            val plon = if (el.has("lon")) el.optDouble("lon") else center?.optDouble("lon") ?: continue
            // dedupe by name + coarse location (~1 km) so a twice-mapped place collapses
            val key = "${name.lowercase()}|${"%.2f".format(plat)}|${"%.2f".format(plon)}"
            if (!seen.add(key)) continue
            val osmUrl = "https://www.openstreetmap.org/${el.optString("type")}/${el.optString("id")}"
            val website = tags.optString("website").ifEmpty {
                tags.optString("contact:website").ifEmpty { osmUrl }
            }
            out.add(
                Event(
                    id = "poi-${el.optString("type")}-${el.optString("id")}",
                    title = name,
                    url = website,
                    source = "OpenStreetMap",
                    description = cat.label,
                    permanent = true,
                    category = cat.label,
                    type = cat.type,
                    hours = tags.optString("opening_hours", ""),
                    locality = tags.optString("addr:city", ""),
                    lat = plat,
                    lon = plon,
                    autoTags = if (cat.kids) setOf(Tagging.TAG_KIDS) else emptySet(),
                )
            )
        }
        // nearest first, then cap — so a close area is never truncated away
        out.sortBy { Geo.haversineKm(lat, lon, it.lat!!, it.lon!!) }
        return out.take(limit)
    }
}

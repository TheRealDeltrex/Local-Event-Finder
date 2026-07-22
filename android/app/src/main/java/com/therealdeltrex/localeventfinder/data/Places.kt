package com.therealdeltrex.localeventfinder.data

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

    // "key|value" -> (label, tags)
    private val cats: Map<String, Pair<String, List<String>>> = linkedMapOf(
        "tourism|museum" to ("Museum" to listOf(Tagging.TAG_FAMILY)),
        "tourism|gallery" to ("Gallery" to listOf(Tagging.TAG_DATE)),
        "tourism|zoo" to ("Zoo" to listOf(Tagging.TAG_FAMILY)),
        "tourism|theme_park" to ("Theme park" to listOf(Tagging.TAG_FAMILY)),
        "tourism|aquarium" to ("Aquarium" to listOf(Tagging.TAG_FAMILY)),
        "tourism|attraction" to ("Attraction" to emptyList()),
        "tourism|viewpoint" to ("Viewpoint" to listOf(Tagging.TAG_DATE)),
        "tourism|artwork" to ("Public art" to listOf(Tagging.TAG_DATE)),
        "leisure|park" to ("Park" to listOf(Tagging.TAG_FAMILY)),
        "leisure|garden" to ("Garden" to listOf(Tagging.TAG_DATE)),
        "leisure|nature_reserve" to ("Nature reserve" to emptyList()),
        "leisure|water_park" to ("Water park" to listOf(Tagging.TAG_FAMILY)),
        "leisure|miniature_golf" to ("Mini golf" to listOf(Tagging.TAG_FAMILY)),
        "leisure|golf_course" to ("Golf course" to emptyList()),
        "leisure|sports_centre" to ("Sports centre" to listOf(Tagging.TAG_FAMILY)),
        "leisure|swimming_pool" to ("Swimming pool" to listOf(Tagging.TAG_FAMILY)),
        "leisure|bathing_place" to ("Bathing spot" to listOf(Tagging.TAG_FAMILY)),
        "leisure|horse_riding" to ("Horse riding" to listOf(Tagging.TAG_FAMILY)),
        "leisure|playground" to ("Playground" to listOf(Tagging.TAG_FAMILY)),
        "leisure|bird_hide" to ("Bird hide" to listOf(Tagging.TAG_DATE)),
        "amenity|cinema" to ("Cinema" to listOf(Tagging.TAG_DATE)),
        "amenity|theatre" to ("Theatre" to listOf(Tagging.TAG_DATE)),
        "amenity|arts_centre" to ("Arts centre" to listOf(Tagging.TAG_DATE)),
        "amenity|public_bath" to ("Swimming pool" to listOf(Tagging.TAG_FAMILY)),
        "historic|castle" to ("Castle" to listOf(Tagging.TAG_DATE)),
        "historic|monument" to ("Monument" to emptyList()),
        "historic|memorial" to ("Memorial" to emptyList()),
        "historic|ruins" to ("Ruins" to listOf(Tagging.TAG_DATE)),
        "natural|beach" to ("Beach" to listOf(Tagging.TAG_FAMILY)),
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

    private fun categoryOf(tags: JSONObject): Pair<String, List<String>>? {
        // Public pools are tagged inconsistently — label any of them "Swimming pool".
        val sport = tags.optString("sport", "").lowercase()
        val leisure = tags.optString("leisure", "")
        if (sport.contains("swimming") || leisure == "swimming_pool" ||
            leisure == "water_park" || tags.optString("amenity", "") == "public_bath") {
            return "Swimming pool" to listOf(Tagging.TAG_FAMILY)
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
                .header("User-Agent", "LocalEventsFinder-Android/1.0")
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
                    description = cat.first,
                    permanent = true,
                    category = cat.first,
                    hours = tags.optString("opening_hours", ""),
                    locality = tags.optString("addr:city", ""),
                    lat = plat,
                    lon = plon,
                    autoTags = cat.second.toSet(),
                )
            )
        }
        // nearest first, then cap — so a close area is never truncated away
        out.sortBy { Geo.haversineKm(lat, lon, it.lat!!, it.lon!!) }
        return out.take(limit)
    }
}

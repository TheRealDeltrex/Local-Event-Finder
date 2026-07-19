package com.therealdeltrex.localeventfinder.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/**
 * Permanent "things to do" from OpenStreetMap via the Overpass API — museums,
 * parks, zoos, galleries, cinemas, castles and so on. Ported from places.py.
 *
 * Nodes only: point POIs resolve quickly and reliably on the public servers,
 * whereas querying ways/relations over a 40 km radius routinely times out.
 */
class Places(private val client: OkHttpClient) {

    private val endpoints = listOf(
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    )

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
        "amenity|cinema" to ("Cinema" to listOf(Tagging.TAG_DATE)),
        "amenity|theatre" to ("Theatre" to listOf(Tagging.TAG_DATE)),
        "amenity|arts_centre" to ("Arts centre" to listOf(Tagging.TAG_DATE)),
        "historic|castle" to ("Castle" to listOf(Tagging.TAG_DATE)),
        "historic|monument" to ("Monument" to emptyList()),
        "historic|memorial" to ("Memorial" to emptyList()),
        "historic|ruins" to ("Ruins" to listOf(Tagging.TAG_DATE)),
    )

    private fun query(lat: Double, lon: Double, radiusM: Int): String {
        val byKey = LinkedHashMap<String, MutableList<String>>()
        for (k in cats.keys) {
            val (key, value) = k.split("|")
            byKey.getOrPut(key) { mutableListOf() }.add(value)
        }
        val body = byKey.entries.joinToString("") { (key, vals) ->
            "node(around:$radiusM,$lat,$lon)[\"$key\"~\"^(${vals.joinToString("|")})$\"];"
        }
        return "[out:json][timeout:25];($body);out 80;"
    }

    private fun categoryOf(tags: JSONObject): Pair<String, List<String>>? {
        for (key in listOf("tourism", "leisure", "amenity", "historic")) {
            val v = tags.optString(key, "")
            if (v.isNotEmpty()) cats["$key|$v"]?.let { return it }
        }
        return null
    }

    suspend fun fetch(lat: Double, lon: Double, radiusKm: Double): List<Event> =
        withContext(Dispatchers.IO) {
            val q = query(lat, lon, (radiusKm * 1000).toInt())
            var elements: org.json.JSONArray? = null
            for (ep in endpoints) {
                try {
                    val req = Request.Builder()
                        .url(ep)
                        .post(FormBody.Builder().add("data", q).build())
                        .header("User-Agent", "LocalEventsFinder-Android/1.0")
                        .build()
                    client.newCall(req).execute().use { resp ->
                        if (resp.code == 200) {
                            val body = resp.body?.string() ?: return@use
                            elements = JSONObject(body).optJSONArray("elements")
                        }
                    }
                    if (elements != null) break
                } catch (e: Exception) {
                    continue
                }
            }
            val els = elements ?: return@withContext emptyList()

            val seen = HashSet<String>()
            val out = ArrayList<Event>()
            for (i in 0 until els.length()) {
                val el = els.optJSONObject(i) ?: continue
                val tags = el.optJSONObject("tags") ?: continue
                val name = tags.optString("name", "")
                if (name.isEmpty()) continue
                val cat = categoryOf(tags) ?: continue
                val plat = if (el.has("lat")) el.optDouble("lat")
                else el.optJSONObject("center")?.optDouble("lat") ?: continue
                val plon = if (el.has("lon")) el.optDouble("lon")
                else el.optJSONObject("center")?.optDouble("lon") ?: continue
                val key = "${name.lowercase()}|${cat.first}"
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
                        locality = tags.optString("addr:city", ""),
                        lat = plat,
                        lon = plon,
                        autoTags = cat.second.toSet(),
                    )
                )
            }
            out
        }
}

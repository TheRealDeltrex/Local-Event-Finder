package com.therealdeltrex.localeventfinder.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** A resolved place: coordinates plus the bits needed to build source URLs. */
data class Place(
    val lat: Double,
    val lon: Double,
    val label: String,
    val city: String = "",
    val cc: String = "",
)

/**
 * Geocoding via OpenStreetMap / Nominatim (no API key). Nominatim asks for a
 * descriptive User-Agent and ~1 request/second, so calls are serialized and
 * throttled, and results are cached in memory for the session.
 */
class Geo(private val client: OkHttpClient) {
    private val base = "https://nominatim.openstreetmap.org"
    private val userAgent =
        "LocalEventsFinder-Android/1.0 (https://github.com/TheRealDeltrex/Local-Event-Finder)"
    private val minIntervalMs = 1100L

    private val throttle = Mutex()
    private var lastCall = 0L
    private val cache = HashMap<String, Place?>()

    private suspend fun request(path: String): String? = withContext(Dispatchers.IO) {
        throttle.withLock {
            val wait = minIntervalMs - (System.currentTimeMillis() - lastCall)
            if (wait > 0) delay(wait)
            lastCall = System.currentTimeMillis()
        }
        val req = Request.Builder()
            .url("$base/$path")
            .header("User-Agent", userAgent)
            .header("Accept-Language", "en,de")
            .build()
        try {
            client.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) resp.body?.string() else null
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun cityFromAddress(addr: JSONObject?): String {
        if (addr == null) return ""
        for (key in listOf("city", "town", "village", "municipality", "county", "state")) {
            val v = addr.optString(key, "")
            if (v.isNotEmpty()) return v
        }
        return ""
    }

    /** Geocode an address/place name into coordinates (cached). */
    suspend fun geocode(query: String): Place? {
        val q = query.trim()
        if (q.isEmpty()) return null
        val key = q.lowercase()
        if (cache.containsKey(key)) return cache[key]

        val body = request("search?q=${enc(q)}&format=json&limit=1&addressdetails=0")
        var result: Place? = null
        if (body != null) {
            val arr = runCatching { JSONArray(body) }.getOrNull()
            if (arr != null && arr.length() > 0) {
                val top = arr.getJSONObject(0)
                result = runCatching {
                    Place(
                        lat = top.getString("lat").toDouble(),
                        lon = top.getString("lon").toDouble(),
                        label = top.optString("display_name", q),
                    )
                }.getOrNull()
            }
        }
        cache[key] = result
        return result
    }

    /** Resolve the search origin from a typed place name. */
    suspend fun resolvePlace(query: String): Place? {
        val q = query.trim()
        if (q.isEmpty()) return null
        val body = request("search?q=${enc(q)}&format=json&limit=1&addressdetails=1")
            ?: return null
        val arr = runCatching { JSONArray(body) }.getOrNull() ?: return null
        if (arr.length() == 0) return null
        val top = arr.getJSONObject(0)
        val addr = top.optJSONObject("address")
        return runCatching {
            Place(
                lat = top.getString("lat").toDouble(),
                lon = top.getString("lon").toDouble(),
                label = top.optString("display_name", q),
                city = cityFromAddress(addr).ifEmpty { q },
                cc = addr?.optString("country_code", "")?.lowercase() ?: "",
            )
        }.getOrNull()
    }

    /** Resolve the search origin from device coordinates (reverse geocode). */
    suspend fun resolveCoords(lat: Double, lon: Double): Place {
        val body = request("reverse?lat=$lat&lon=$lon&format=json&zoom=14")
        var label = ""
        var addr: JSONObject? = null
        if (body != null) {
            val obj = runCatching { JSONObject(body) }.getOrNull()
            if (obj != null) {
                label = obj.optString("display_name", "")
                addr = obj.optJSONObject("address")
            }
        }
        return Place(
            lat = lat,
            lon = lon,
            label = label.ifEmpty { "%.4f, %.4f".format(lat, lon) },
            city = cityFromAddress(addr),
            cc = addr?.optString("country_code", "")?.lowercase() ?: "",
        )
    }

    companion object {
        private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")

        /** Great-circle distance between two points, in kilometres. */
        fun haversineKm(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
            val r = 6371.0
            val p1 = Math.toRadians(lat1)
            val p2 = Math.toRadians(lat2)
            val dp = Math.toRadians(lat2 - lat1)
            val dl = Math.toRadians(lon2 - lon1)
            val a = sin(dp / 2) * sin(dp / 2) +
                cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
            return 2 * r * asin(sqrt(a))
        }

        private val COMPASS_16 = arrayOf(
            "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
        )

        /** 16-point compass direction from point 1 to point 2 (e.g. "NNE"). */
        fun compass16(lat1: Double, lon1: Double, lat2: Double, lon2: Double): String {
            val p1 = Math.toRadians(lat1)
            val p2 = Math.toRadians(lat2)
            val dl = Math.toRadians(lon2 - lon1)
            val y = sin(dl) * cos(p2)
            val x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl)
            val bearing = (Math.toDegrees(Math.atan2(y, x)) + 360) % 360
            return COMPASS_16[(Math.round(bearing / 22.5).toInt()) % 16]
        }
    }
}

package com.therealdeltrex.localeventfinder.data

import java.security.MessageDigest

/** A single event, mirroring the web app's Event record. */
data class Event(
    val id: String,
    val title: String,
    val url: String,
    val source: String,
    val description: String = "",
    val start: String = "",
    val end: String = "",
    val image: String = "",
    val address: String = "",
    val locality: String = "",
    var lat: Double? = null,
    var lon: Double? = null,
    var distanceKm: Double? = null,
    val permanent: Boolean = false,   // a place you can visit any day
    val category: String = "",        // e.g. "Museum", "Park"
    val autoTags: Set<String> = emptySet(),
    var tags: Set<String> = emptySet(),
)

/** Stable id so manual tags survive re-scrapes (sha1 of url|title|start). */
fun eventId(url: String, title: String, start: String): String {
    val basis = "${url}|${title}|${start}"
    val digest = MessageDigest.getInstance("SHA-1").digest(basis.toByteArray())
    return digest.joinToString("") { "%02x".format(it) }.take(16)
}

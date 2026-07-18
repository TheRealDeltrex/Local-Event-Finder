package com.therealdeltrex.localeventfinder.data

import java.net.URLEncoder

/** A configurable event source: a name plus a URL template. */
data class Source(
    val name: String,
    val url: String,
    val enabled: Boolean = true,
)

object Sources {
    /** Same defaults as the web app. */
    val DEFAULTS = listOf(
        Source(
            name = "Meetup",
            url = "https://www.meetup.com/find/?location={cc}--{city}&source=EVENTS",
        ),
        Source(
            name = "AllEvents",
            url = "https://allevents.in/{city_lower}/all",
        ),
    )

    /** Fill a source template from the resolved search location. */
    fun buildUrl(template: String, place: Place): String {
        val city = place.city.ifEmpty { place.label.substringBefore(",") }.trim()
        val citySlug = enc(city.lowercase().replace(" ", "-"))
        return template
            .replace("{city}", enc(city))
            .replace("{city_lower}", citySlug)
            .replace("{cc}", enc(place.cc.trim()))
            .replace("{label}", enc(place.label))
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

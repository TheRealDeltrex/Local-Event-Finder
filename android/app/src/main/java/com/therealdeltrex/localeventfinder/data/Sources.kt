package com.therealdeltrex.localeventfinder.data

import java.net.URLEncoder

/** A configurable event source: a name plus a URL template. */
data class Source(
    val name: String,
    val url: String,
    val enabled: Boolean = true,
)

object Sources {
    /** Same defaults as the web app. AllEvents per-category pages surface
     *  different events (concerts, theatre, comedy, shows), so pull several. */
    val DEFAULTS = listOf(
        Source("Meetup", "https://www.meetup.com/find/?location={cc}--{city}&source=EVENTS"),
        Source("AllEvents", "https://allevents.in/{city_lower}/all"),
        Source("AllEvents · Music", "https://allevents.in/{city_lower}/music"),
        Source("AllEvents · Theatre", "https://allevents.in/{city_lower}/theatre"),
        Source("AllEvents · Comedy", "https://allevents.in/{city_lower}/comedy"),
        Source("AllEvents · Arts", "https://allevents.in/{city_lower}/arts"),
        Source("AllEvents · Nightlife", "https://allevents.in/{city_lower}/nightlife"),
    )

    /** Fill a source template from the resolved search location. When
     *  [cityLowerOverride] is given (a proximity-validated slug) it is used for
     *  {city_lower} instead of deriving one from the city name. */
    fun buildUrl(template: String, place: Place, cityLowerOverride: String? = null): String {
        val city = place.city.ifEmpty { place.label.substringBefore(",") }.trim()
        val citySlug = if (cityLowerOverride != null) enc(cityLowerOverride)
        else enc(city.lowercase().replace(" ", "-"))
        return template
            .replace("{city}", enc(city))
            .replace("{city_lower}", citySlug)
            .replace("{cc}", enc(place.cc.trim()))
            .replace("{label}", enc(place.label))
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

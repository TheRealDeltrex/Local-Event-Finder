package com.therealdeltrex.localeventfinder.data

/**
 * Auto-tagging heuristics, ported from the web app's tagging.py.
 *
 * Every result gets one primary **type** (music, park, theatre, …, or
 * [TYPE_UNKNOWN] when nothing fits) and, separately, may get the [TAG_KIDS]
 * tag when it's actually aimed at children (a playground or a puppet show, not
 * just any park).
 *
 * Events are typed from their schema.org @type when it's specific, then from
 * keywords in the title, then from the AllEvents feed they came from, then from
 * keywords in the description. Places are typed from their OSM category.
 * The user can turn the kid friendly tag on or off by hand (see TagStore).
 *
 * scripts/check_parity.py keeps these tables in step with Python and JS.
 */
data class TypeInfo(val key: String, val label: String, val color: Long)

object Tagging {
    const val TAG_KIDS = "kids"
    val ALL_TAGS = listOf(TAG_KIDS)
    val TAG_LABELS = mapOf(TAG_KIDS to "Kid friendly")

    const val TYPE_UNKNOWN = "unknown"

    /** Order is the order of the filter chips. */
    val TYPES = listOf(
        TypeInfo("music", "Music", 0xFF8E24AA),
        TypeInfo("theatre", "Theatre & shows", 0xFFC62828),
        TypeInfo("comedy", "Comedy", 0xFFEF6C00),
        TypeInfo("film", "Film", 0xFF455A64),
        TypeInfo("art", "Art", 0xFFD81B60),
        TypeInfo("museum", "Museum & history", 0xFF6D4C41),
        TypeInfo("park", "Park & nature", 0xFF2E7D32),
        TypeInfo("water", "Swimming & beach", 0xFF0288D1),
        TypeInfo("animals", "Zoo & animals", 0xFF00897B),
        TypeInfo("sport", "Sport", 0xFF3949AB),
        TypeInfo("play", "Playground", 0xFFF4511E),
        TypeInfo("attraction", "Attraction", 0xFFC0A000),
        TypeInfo("food", "Food & drink", 0xFFA1541B),
        TypeInfo("nightlife", "Nightlife", 0xFF5E35B1),
        TypeInfo("festival", "Festival & market", 0xFFE91E63),
        TypeInfo("workshop", "Class & talk", 0xFF00838F),
        TypeInfo("community", "Meetup & social", 0xFF607D8B),
        TypeInfo("unknown", "Unknown", 0xFF757575),
    )
    private val TYPE_BY_KEY = TYPES.associateBy { it.key }
    fun typeInfo(key: String): TypeInfo = TYPE_BY_KEY[key] ?: TYPE_BY_KEY.getValue(TYPE_UNKNOWN)

    /** schema.org event @type -> type (plain "Event" says nothing). */
    private val LD_TYPES = mapOf(
        "MusicEvent" to "music",
        "TheaterEvent" to "theatre",
        "DanceEvent" to "theatre",
        "ComedyEvent" to "comedy",
        "ScreeningEvent" to "film",
        "VisualArtsEvent" to "art",
        "ExhibitionEvent" to "art",
        "SportsEvent" to "sport",
        "FoodEvent" to "food",
        "Festival" to "festival",
        "SaleEvent" to "festival",
        "EducationEvent" to "workshop",
        "LiteraryEvent" to "workshop",
        "SocialEvent" to "community",
    )

    /** AllEvents category feed -> type. */
    private val SOURCE_TYPES = mapOf(
        "music" to "music",
        "theatre" to "theatre",
        "comedy" to "comedy",
        "arts" to "art",
        "nightlife" to "nightlife",
    )

    /** Whole-word keyword hints per type; the one appearing first in the text wins. */
    private val TYPE_HINTS = linkedMapOf(
        "music" to listOf(
            "concert", "concerts", "live music", "gig", "band", "bands", "jazz", "blues",
            "orchestra", "symphony", "philharmonic", "choir", "recital", "acoustic",
            "open mic", "singer", "songwriter", "rock", "punk", "metal", "hip hop", "rap",
            "folk", "musik", "konzert", "chor", "music",
        ),
        "theatre" to listOf(
            "theatre", "theater", "musical", "opera", "ballet", "drama", "cabaret", "circus",
            "magic show", "dance show", "puppet", "puppet show", "pantomime", "oper",
            "schauspiel", "zirkus", "theaterstück",
        ),
        "comedy" to listOf(
            "comedy", "stand-up", "standup", "stand up", "comedian", "comedians", "improv",
            "kabarett", "satire",
        ),
        "film" to listOf(
            "film", "films", "movie", "movies", "cinema", "screening", "open air cinema",
            "kino", "filmabend",
        ),
        "art" to listOf(
            "art", "arts", "gallery", "exhibition", "painting", "sculpture", "art walk",
            "vernissage", "photography", "paint and sip", "ausstellung", "kunst", "galerie",
        ),
        "museum" to listOf(
            "museum", "museums", "heritage", "history tour", "historic", "castle",
            "museumsnacht", "burg", "schloss",
        ),
        "park" to listOf(
            "park", "garden", "gardens", "hike", "hiking", "nature walk", "forest",
            "botanical", "nature", "wandern", "wanderung", "naturpark",
        ),
        "water" to listOf(
            "swim", "swimming", "pool", "beach", "lido", "schwimmen", "strand", "freibad",
            "hallenbad",
        ),
        "animals" to listOf(
            "zoo", "aquarium", "petting zoo", "wildlife", "animals", "farm animals",
            "tierpark", "wildpark",
        ),
        "sport" to listOf(
            "run", "running", "marathon", "5k", "10k", "football", "soccer", "yoga", "fitness",
            "cycling", "bike ride", "climbing", "bouldering", "tennis", "match", "tournament",
            "volleyball", "basketball", "hockey", "handball", "sport", "sports", "lauf",
            "fußball", "turnier",
        ),
        "play" to listOf(
            "playground", "soft play", "bouncy castle", "spielplatz", "play area",
        ),
        "attraction" to listOf(
            "theme park", "funfair", "amusement", "escape room", "mini golf", "minigolf",
            "kirmes", "freizeitpark",
        ),
        "food" to listOf(
            "food", "dinner", "brunch", "breakfast", "tasting", "wine", "wine tasting", "beer",
            "brewery", "distillery", "whisky", "whiskey", "gin", "street food", "bbq",
            "barbecue", "coffee", "cocktail", "cocktails", "supper club", "weinprobe", "essen",
        ),
        "nightlife" to listOf(
            "club night", "dance party", "afterparty", "dj", "rave", "techno", "house music",
            "nightlife", "disco", "pub crawl", "karaoke", "quiz night", "pub quiz",
            "salsa night", "silent disco",
        ),
        "festival" to listOf(
            "festival", "fest", "market", "flea market", "christmas market", "carnival",
            "parade", "fair", "street party", "markt", "flohmarkt", "weihnachtsmarkt",
            "volksfest", "stadtfest",
        ),
        "workshop" to listOf(
            "workshop", "class", "classes", "course", "lesson", "lessons", "seminar",
            "lecture", "talk", "tutorial", "bootcamp", "masterclass", "pottery", "craft", "crafts", "kurs",
            "vortrag", "reading", "lesung",
        ),
        "community" to listOf(
            "meetup", "meet-up", "networking", "social", "meet and greet", "language exchange",
            "board games", "board game", "stammtisch", "volunteer", "volunteering",
            "community", "get together",
        ),
    )

    /** Things actually aimed at children, not just "fine to bring kids to". */
    private val KID_HINTS = listOf(
        "kids", "kid", "children", "child", "childrens", "children's", "toddler", "toddlers",
        "baby", "babies", "little ones", "junior", "juniors", "family day", "family fun",
        "family-friendly", "family friendly", "for families", "puppet", "puppet show",
        "storytime", "story time", "fairy tale", "petting zoo", "face painting",
        "bouncy castle", "lego", "soft play", "playground", "school holiday",
        "school holidays", "half term", "easter egg hunt", "kinder", "kinderfest",
        "kindertheater", "familienfest", "spielplatz", "märchen", "kinderprogramm",
    )

    private fun buildRegex(hints: List<String>): Regex {
        // longest first; word-boundary match so "art" doesn't fire inside "start"
        val alternation = hints.sortedByDescending { it.length }
            .joinToString("|") { Regex.escape(it) }
        return Regex("(?<!\\w)(?:$alternation)(?!\\w)", RegexOption.IGNORE_CASE)
    }

    private val typeRegexes = TYPE_HINTS.mapValues { buildRegex(it.value) }
    private val kidRegex = buildRegex(KID_HINTS)
    private val sourceRegex = Regex("[·/]\\s*(\\w+)\\)?\\s*$")

    private fun ldName(t: String) = t.substringAfterLast('/')

    private fun typeFromText(text: String): String? {
        var best: Triple<Int, Int, String>? = null
        TYPES.forEachIndexed { order, info ->
            val m = typeRegexes[info.key]?.find(text.lowercase()) ?: return@forEachIndexed
            val b = best
            if (b == null || m.range.first < b.first || (m.range.first == b.first && order < b.second)) {
                best = Triple(m.range.first, order, info.key)
            }
        }
        return best?.third
    }

    private fun sourceType(source: String): String? =
        sourceRegex.find(source)?.groupValues?.get(1)?.lowercase()?.let { SOURCE_TYPES[it] }

    fun eventType(
        title: String,
        description: String = "",
        ldTypes: List<String> = emptyList(),
        source: String = "",
    ): String =
        ldTypes.firstNotNullOfOrNull { LD_TYPES[ldName(it)] }
            ?: typeFromText(title)
            ?: sourceType(source)
            ?: typeFromText(description)
            ?: (if (source.lowercase().startsWith("meetup")) "community" else null)
            ?: TYPE_UNKNOWN

    fun autoTags(title: String, description: String = "", ldTypes: List<String> = emptyList()): Set<String> {
        val kids = ldTypes.any { ldName(it) == "ChildrensEvent" } ||
            kidRegex.containsMatchIn("$title \n $description")
        return if (kids) setOf(TAG_KIDS) else emptySet()
    }
}

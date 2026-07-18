package com.therealdeltrex.localeventfinder.data

/**
 * Auto-tagging heuristics, ported from the web app's tagging.py.
 *
 * Two categories the user cares about:
 *  - [TAG_DATE]   "possible date" ideas (date-night / romantic outings)
 *  - [TAG_FAMILY] child- or family-friendly things to do
 *
 * Tags are guessed from title + description via whole-word keyword matching.
 * The user can add/remove a tag by hand; those overrides win (see TagStore).
 */
object Tagging {
    const val TAG_DATE = "date"
    const val TAG_FAMILY = "family"
    val ALL_TAGS = listOf(TAG_DATE, TAG_FAMILY)
    val TAG_LABELS = mapOf(TAG_DATE to "Possible date", TAG_FAMILY to "Family friendly")

    private val DATE_HINTS = listOf(
        "date night", "romantic", "couples", "wine", "wine tasting", "tasting",
        "cocktail", "cocktails", "speakeasy", "rooftop", "candlelight", "candlelit",
        "dinner", "brunch", "jazz", "live music", "concert", "acoustic", "vinyl",
        "comedy", "stand-up", "standup", "theatre", "theater", "opera", "ballet",
        "gallery", "art walk", "exhibition", "gin", "whisky", "whiskey", "brewery",
        "distillery", "tapas", "salsa", "tango", "dance class", "sunset", "cruise",
        "pottery", "paint and sip", "quiz night", "wine bar",
    )

    private val FAMILY_HINTS = listOf(
        "family", "families", "family-friendly", "kid", "kids", "child", "children",
        "toddler", "toddlers", "baby", "babies", "all ages", "all-ages",
        "playground", "puppet", "storytime", "story time", "fairy tale",
        "petting zoo", "zoo", "aquarium", "science museum", "planetarium",
        "craft", "crafts", "lego", "face painting", "bouncy castle", "funfair",
        "kinder", "familien", "familie", "spielplatz", "märchen",
        "workshop for kids", "school holiday", "half term", "easter egg",
    )

    private val dateRegex = buildRegex(DATE_HINTS)
    private val familyRegex = buildRegex(FAMILY_HINTS)

    private fun buildRegex(hints: List<String>): Regex {
        // word-boundary match so "art" doesn't fire inside "start"
        val alternation = hints.sortedByDescending { it.length }
            .joinToString("|") { Regex.escape(it) }
        return Regex("(?<!\\w)(?:$alternation)(?!\\w)", RegexOption.IGNORE_CASE)
    }

    fun autoTags(title: String, description: String = ""): Set<String> {
        val text = "$title \n $description"
        val tags = mutableSetOf<String>()
        if (dateRegex.containsMatchIn(text)) tags.add(TAG_DATE)
        if (familyRegex.containsMatchIn(text)) tags.add(TAG_FAMILY)
        return tags
    }
}

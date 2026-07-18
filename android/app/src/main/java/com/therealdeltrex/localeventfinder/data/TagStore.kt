package com.therealdeltrex.localeventfinder.data

import android.content.Context
import org.json.JSONObject

/** A per-event manual override, relative to the auto-guess. */
data class TagOverride(val add: Set<String> = emptySet(), val remove: Set<String> = emptySet()) {
    fun isEmpty() = add.isEmpty() && remove.isEmpty()
}

/**
 * Local persistence in SharedPreferences — nothing leaves the device.
 * Stores manual tag overrides and the last-used location + range.
 */
class TagStore(context: Context) {
    private val prefs = context.getSharedPreferences("local_event_finder", Context.MODE_PRIVATE)

    // ---- manual tag overrides -------------------------------------------
    fun loadOverrides(): MutableMap<String, TagOverride> {
        val json = prefs.getString(KEY_TAGS, null) ?: return HashMap()
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return HashMap()
        val out = HashMap<String, TagOverride>()
        for (id in obj.keys()) {
            val e = obj.getJSONObject(id)
            out[id] = TagOverride(
                add = e.optJSONArray("add").toStringSet(),
                remove = e.optJSONArray("remove").toStringSet(),
            )
        }
        return out
    }

    fun saveOverrides(map: Map<String, TagOverride>) {
        val obj = JSONObject()
        for ((id, ov) in map) {
            if (ov.isEmpty()) continue
            obj.put(id, JSONObject().apply {
                put("add", org.json.JSONArray(ov.add.sorted()))
                put("remove", org.json.JSONArray(ov.remove.sorted()))
            })
        }
        prefs.edit().putString(KEY_TAGS, obj.toString()).apply()
    }

    /**
     * Toggle one tag for one event. [wasAuto] is whether the auto-guess already
     * included the tag, so we only record a genuine deviation from the guess.
     */
    fun toggle(
        map: MutableMap<String, TagOverride>,
        eventId: String,
        tag: String,
        newState: Boolean,
        wasAuto: Boolean,
    ) {
        val cur = map[eventId] ?: TagOverride()
        val add = cur.add.toMutableSet()
        val remove = cur.remove.toMutableSet()
        add.remove(tag)
        remove.remove(tag)
        if (newState && !wasAuto) add.add(tag)
        else if (!newState && wasAuto) remove.add(tag)
        val next = TagOverride(add, remove)
        if (next.isEmpty()) map.remove(eventId) else map[eventId] = next
        saveOverrides(map)
    }

    // ---- settings --------------------------------------------------------
    fun loadRangeKm(): Int = prefs.getInt(KEY_RANGE, 40)
    fun saveRangeKm(km: Int) = prefs.edit().putInt(KEY_RANGE, km).apply()

    fun loadHomeLabel(): String? = prefs.getString(KEY_HOME, null)
    fun saveHomeLabel(label: String) = prefs.edit().putString(KEY_HOME, label).apply()

    private fun org.json.JSONArray?.toStringSet(): Set<String> {
        if (this == null) return emptySet()
        return (0 until length()).map { getString(it) }.toSet()
    }

    companion object {
        private const val KEY_TAGS = "manual_tags"
        private const val KEY_RANGE = "range_km"
        private const val KEY_HOME = "home_label"
    }
}

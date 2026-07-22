package com.therealdeltrex.localeventfinder

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.therealdeltrex.localeventfinder.data.Event
import com.therealdeltrex.localeventfinder.data.Geo
import com.therealdeltrex.localeventfinder.data.Place
import com.therealdeltrex.localeventfinder.data.Scraper
import com.therealdeltrex.localeventfinder.data.Sources
import com.therealdeltrex.localeventfinder.data.TagOverride
import com.therealdeltrex.localeventfinder.data.TagStore
import com.therealdeltrex.localeventfinder.data.Tagging
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

const val UNTAGGED = "__untagged__"
const val PERMANENT = "__permanent__"

data class UiState(
    val loading: Boolean = false,
    val status: String = "Share your location or type a place to start.",
    val events: List<Event> = emptyList(),
    val rangeKm: Int = 40,
    val dayMin: Int = 0,        // date-window start (days from today)
    val dayMax: Int = WINDOW_DAYS,
    val filters: Set<String> = setOf(Tagging.TAG_DATE, Tagging.TAG_FAMILY, UNTAGGED, PERMANENT),
    val log: List<String> = emptyList(),
) {
    /** Events after live tag + distance + date + always-open filtering. */
    val visible: List<Event>
        get() = events.filter { ev ->
            val within = (ev.distanceKm ?: Double.MAX_VALUE) <= rangeKm
            val tagOk = if (ev.tags.isEmpty()) UNTAGGED in filters
            else ev.tags.any { it in filters }
            val permanentOk = !ev.permanent || PERMANENT in filters
            within && tagOk && permanentOk && inDateRange(ev, dayMin, dayMax)
        }
}

const val WINDOW_DAYS = 14

/** Whole days from local midnight today to the event's start, or null. */
private fun dayOffset(start: String): Long? {
    if (start.isBlank()) return null
    val instant = try {
        java.time.OffsetDateTime.parse(start).toInstant()
    } catch (e: Exception) {
        try { java.time.LocalDate.parse(start.take(10)).atStartOfDay(java.time.ZoneOffset.UTC).toInstant() }
        catch (e2: Exception) { return null }
    }
    val zone = java.time.ZoneId.systemDefault()
    val today = java.time.LocalDate.now(zone)
    val evDay = instant.atZone(zone).toLocalDate()
    return java.time.temporal.ChronoUnit.DAYS.between(today, evDay)
}

private fun inDateRange(ev: Event, dayMin: Int, dayMax: Int): Boolean {
    if (ev.permanent) return true              // any-day places always qualify
    val off = dayOffset(ev.start) ?: return true  // undated / recurring
    val clamped = off.coerceAtLeast(0)
    return clamped in dayMin..dayMax
}

class EventsViewModel(app: Application) : AndroidViewModel(app) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(25, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .build()
    private val geo = Geo(client)
    private val scraper = Scraper(client, geo)
    private val store = TagStore(app)
    private val overrides: MutableMap<String, TagOverride> = store.loadOverrides()

    private val _state = MutableStateFlow(UiState(rangeKm = store.loadRangeKm()))
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        store.loadHomeLabel()?.let { label ->
            _state.update {
                it.copy(status = "Last searched near ${shorten(label)}. Search again to refresh.")
            }
        }
    }

    fun setRange(km: Int) {
        _state.update { it.copy(rangeKm = km) }
        store.saveRangeKm(km)
    }

    fun setDayRange(min: Int, max: Int) {
        _state.update { it.copy(dayMin = min.coerceIn(0, WINDOW_DAYS), dayMax = max.coerceIn(0, WINDOW_DAYS)) }
    }

    fun toggleFilter(tag: String, on: Boolean) {
        _state.update {
            val f = it.filters.toMutableSet()
            if (on) f.add(tag) else f.remove(tag)
            it.copy(filters = f)
        }
    }

    fun searchByName(name: String) {
        val q = name.trim()
        if (q.isEmpty()) {
            _state.update { it.copy(status = "Type a town or city, or use your location.") }
            return
        }
        runSearch { geo.resolvePlace(q) }
    }

    fun searchByCoords(lat: Double, lon: Double) {
        runSearch { geo.resolveCoords(lat, lon) }
    }

    private fun runSearch(resolve: suspend () -> Place?) {
        _state.update { it.copy(loading = true, status = "Searching for events…") }
        viewModelScope.launch {
            val place = resolve()
            if (place == null) {
                _state.update {
                    it.copy(loading = false, status = "Could not resolve that location. Try a nearby town.")
                }
                return@launch
            }
            val range = _state.value.rangeKm.toDouble()
            val log = ArrayList<String>()
            val events = scraper.runSearch(place, Sources.DEFAULTS, range, overrides, log)
            store.saveHomeLabel(place.label)
            _state.update {
                it.copy(
                    loading = false,
                    events = events,
                    log = log,
                    status = "${events.size} event(s) within ${range.toInt()} km of ${shorten(place.label)}.",
                )
            }
        }
    }

    fun toggleTag(event: Event, tag: String) {
        val currentlyOn = tag in event.tags
        val wasAuto = tag in event.autoTags
        val newState = !currentlyOn
        store.toggle(overrides, event.id, tag, newState, wasAuto)
        // rebuild the event list with the updated tag set
        _state.update { st ->
            val updated = st.events.map { ev ->
                if (ev.id != event.id) ev
                else ev.also {
                    it.tags = if (newState) it.tags + tag else it.tags - tag
                }
            }
            st.copy(events = updated)
        }
    }

    private fun shorten(label: String) = label.split(",").take(2).joinToString(",").trim()
}

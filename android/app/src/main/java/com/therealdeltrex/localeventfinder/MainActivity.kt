package com.therealdeltrex.localeventfinder

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.therealdeltrex.localeventfinder.data.Event
import com.therealdeltrex.localeventfinder.data.Tagging
import com.therealdeltrex.localeventfinder.ui.theme.DatePink
import com.therealdeltrex.localeventfinder.ui.theme.FamilyGreen
import com.therealdeltrex.localeventfinder.ui.theme.LocalEventFinderTheme
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

class MainActivity : ComponentActivity() {
    private val vm: EventsViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            LocalEventFinderTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    AppScreen(vm, ::requestDeviceLocation)
                }
            }
        }
    }

    /** Ask the fused location provider for a fresh fix, then kick off a search. */
    private fun requestDeviceLocation() {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (fine != PackageManager.PERMISSION_GRANTED && coarse != PackageManager.PERMISSION_GRANTED) {
            return
        }
        val client = LocationServices.getFusedLocationProviderClient(this)
        client.getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, null)
            .addOnSuccessListener { loc ->
                if (loc != null) vm.searchByCoords(loc.latitude, loc.longitude)
                else client.lastLocation.addOnSuccessListener { last ->
                    if (last != null) vm.searchByCoords(last.latitude, last.longitude)
                }
            }
    }
}

@Composable
fun AppScreen(vm: EventsViewModel, onUseLocation: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var locName by rememberSaveable { mutableStateOf("") }

    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        if (result.values.any { it }) onUseLocation()
    }

    fun useLocation() {
        val granted = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) onUseLocation()
        else permLauncher.launch(
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        )
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp)
    ) {
        Text("📍 Local Events Finder", style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text(
            "Find things to do near you. Pick a spot, set a range, and mark events as date ideas or family friendly.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(16.dp))

        // ---- location controls ----
        OutlinedTextField(
            value = locName,
            onValueChange = { locName = it },
            label = { Text("Town or city (e.g. Cologne)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { vm.searchByName(locName) }),
        )
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = ::useLocation, modifier = Modifier.weight(1f)) {
                Text("📡 Use my location")
            }
            Button(
                onClick = { vm.searchByName(locName) },
                enabled = !state.loading,
                modifier = Modifier.weight(1f),
            ) { Text("Search") }
        }

        Spacer(Modifier.height(12.dp))
        Text("Range: ${state.rangeKm} km", color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium)
        Slider(
            value = state.rangeKm.toFloat(),
            onValueChange = { vm.setRange(it.toInt()) },
            valueRange = 1f..40f,
            steps = 38,
        )

        // ---- date window (drag both ends) ----
        Text("When: ${dateRangeLabel(state.dayMin, state.dayMax)}",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium)
        RangeSlider(
            value = state.dayMin.toFloat()..state.dayMax.toFloat(),
            onValueChange = { r -> vm.setDayRange(r.start.toInt(), r.endInclusive.toInt()) },
            valueRange = 0f..WINDOW_DAYS.toFloat(),
            steps = 0,  // continuous; day precision comes from toInt()
        )

        // ---- tag filters ----
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Tagging.ALL_TAGS.forEach { tag ->
                FilterChip(
                    selected = tag in state.filters,
                    onClick = { vm.toggleFilter(tag, tag !in state.filters) },
                    label = { Text(Tagging.TAG_LABELS[tag] ?: tag) },
                )
            }
            FilterChip(
                selected = UNTAGGED in state.filters,
                onClick = { vm.toggleFilter(UNTAGGED, UNTAGGED !in state.filters) },
                label = { Text("Untagged") },
            )
            FilterChip(
                selected = PERMANENT in state.filters,
                onClick = { vm.toggleFilter(PERMANENT, PERMANENT !in state.filters) },
                label = { Text("Permanent") },
            )
        }

        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text(state.status, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        Spacer(Modifier.height(12.dp))

        // ---- results ----
        val visible = state.visible
        if (state.events.isNotEmpty() && visible.isEmpty()) {
            Text(
                "No events match these filters. Widen the range or turn on more tags.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 24.dp).fillMaxWidth(),
            )
        }
        LazyColumn(
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.heightIn(max = 4000.dp),
        ) {
            items(visible, key = { it.id }) { ev ->
                EventCard(ev) { tag -> vm.toggleTag(ev, tag) }
            }
        }

        Spacer(Modifier.height(20.dp))
        Text(
            "Created by Deltrex",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

@Composable
private fun EventCard(ev: Event, onToggleTag: (String) -> Unit) {
    val uriHandler = LocalUriHandler.current
    val context = LocalContext.current
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(14.dp)) {
            // Title links to the event/place homepage.
            Text(
                ev.title,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
                textDecoration = if (ev.url.isNotEmpty()) TextDecoration.Underline else null,
                modifier = Modifier.clickableIf(ev.url.isNotEmpty()) {
                    runCatching { uriHandler.openUri(ev.url) }
                },
            )
            Spacer(Modifier.height(4.dp))
            val muted = MaterialTheme.colorScheme.onSurfaceVariant
            val small = MaterialTheme.typography.bodySmall
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (ev.permanent) "${ev.category.ifEmpty { "Place" }} · permanent"
                    else formatWhenRange(ev.start, ev.end),
                    style = small, color = muted,
                )
                ev.distanceKm?.let { km ->
                    Text("  ·  ", style = small, color = muted)
                    // Distance opens the location in Google Maps.
                    Text(
                        "$km km" + if (ev.direction.isNotEmpty()) " ${ev.direction}" else "",
                        style = small,
                        color = MaterialTheme.colorScheme.primary,
                        textDecoration = TextDecoration.Underline,
                        modifier = Modifier.clickable { openMaps(context, ev) },
                    )
                }
                if (ev.locality.isNotEmpty()) {
                    Text("  ·  ${ev.locality}", style = small, color = muted,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (ev.permanent && ev.hours.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                Text("🕒 ${prettyHours(ev.hours)}", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2, overflow = TextOverflow.Ellipsis)
            } else if (!ev.permanent && ev.description.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                Text(ev.description, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Tagging.ALL_TAGS.forEach { tag ->
                    val on = tag in ev.tags
                    val color = if (tag == Tagging.TAG_DATE) DatePink else FamilyGreen
                    AssistChip(
                        onClick = { onToggleTag(tag) },
                        label = { Text((if (on) "✓ " else "+ ") + (Tagging.TAG_LABELS[tag] ?: tag)) },
                        colors = if (on) AssistChipDefaults.assistChipColors(
                            containerColor = color, labelColor = Color(0xFF10121A)
                        ) else AssistChipDefaults.assistChipColors(),
                    )
                }
            }
        }
    }
}

/** Format an ISO-8601 start string for display; falls back to the raw text. */
private fun formatWhen(iso: String): String {
    if (iso.isBlank()) return "Date TBC"
    return runCatching {
        val dt = OffsetDateTime.parse(iso)
        dt.format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT))
    }.getOrElse { iso }
}

/** Start time, plus the end time when it's known and on the same day. */
private fun formatWhenRange(start: String, end: String): String {
    val base = formatWhen(start)
    if (end.isBlank()) return base
    return runCatching {
        val s = OffsetDateTime.parse(start)
        val e = OffsetDateTime.parse(end)
        if (!e.isAfter(s) || s.toLocalDate() != e.toLocalDate()) base
        else base + " – " + e.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT))
    }.getOrElse { base }
}

/** Lightly tidy an OSM opening_hours string for display. */
private fun prettyHours(s: String): String = s.replace(Regex("\\s*;\\s*"), " · ").trim()

private fun Modifier.clickableIf(enabled: Boolean, onClick: () -> Unit): Modifier =
    if (enabled) this.clickable(onClick = onClick) else this

/** Open the event's location in Google Maps (by coordinates, else by name). */
private fun openMaps(context: android.content.Context, ev: Event) {
    val query = if (ev.lat != null && ev.lon != null) "${ev.lat},${ev.lon}"
    else android.net.Uri.encode(ev.title)
    val uri = android.net.Uri.parse("https://www.google.com/maps/search/?api=1&query=$query")
    runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, uri)) }
}

/** Friendly label for the selected day window, e.g. "today → Sat, 2 Aug". */
private fun dateRangeLabel(dayMin: Int, dayMax: Int): String {
    if (dayMin <= 0 && dayMax >= WINDOW_DAYS) return "next 12 months"
    fun lbl(off: Int): String = when {
        off <= 0 -> "today"
        off == 1 -> "tomorrow"
        else -> java.time.LocalDate.now().plusDays(off.toLong())
            .format(DateTimeFormatter.ofPattern("EEE, d MMM"))
    }
    return "${lbl(dayMin)} → ${lbl(dayMax)}"
}

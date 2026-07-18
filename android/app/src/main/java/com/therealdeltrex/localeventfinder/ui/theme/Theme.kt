package com.therealdeltrex.localeventfinder.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Ice = Color(0xFF5EB8E0)
val IceHover = Color(0xFF8AD0F0)
val DatePink = Color(0xFFE07EA8)
val FamilyGreen = Color(0xFF7EE0A0)

private val DarkColors = darkColorScheme(
    primary = Ice,
    onPrimary = Color(0xFF061018),
    secondary = IceHover,
    background = Color(0xFF0B1220),
    surface = Color(0xFF121C2E),
    onSurface = Color(0xFFE8EEF8),
    surfaceVariant = Color(0xFF1A2740),
    onSurfaceVariant = Color(0xFF8FA3C1),
    outline = Color(0xFF2A3D5C),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF1E7FA8),
    secondary = Color(0xFF2A6E8C),
)

@Composable
fun LocalEventFinderTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, content = content)
}

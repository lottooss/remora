// Fixture for scripts/check-no-stubs.test.mjs (docs/tasks/P7-G3.md).
import io.github.lottooss.remora.core.ui.PlaceholderScreen

class Stubs {
    // TODO: send token to relay
    val label = "Unlock (placeholder)"
    val shell = PlaceholderScreen(
        title = "Stubs",
    )
    fun notDone(): Nothing = error("not implemented")
}

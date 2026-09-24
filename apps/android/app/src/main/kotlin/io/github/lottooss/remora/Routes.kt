package io.github.lottooss.remora

/**
 * Navigation routes for the P1-K2 app shell (blueprint §10.6 screens).
 * `sessionId` arguments are single path segments; callers must [android.net.Uri.encode]
 * ids that are not already URL-safe (real ids arrive with P2-K2).
 */
object Routes {
    const val PAIR = "pair"
    const val HOSTS = "hosts"
    const val SESSIONS = "sessions"
    const val NEW_SESSION = "new_session"
    const val APPROVALS = "approvals"
    const val SETTINGS = "settings"
    const val DIAGNOSTICS = "settings/diagnostics"

    const val CONVERSATION = "conversation/{sessionId}"
    const val FILES = "files/{sessionId}"
    const val SESSION_ID_ARG = "sessionId"

    /** Destinations shown with the bottom navigation bar. */
    val TOP_LEVEL = setOf(PAIR, HOSTS, SESSIONS, APPROVALS, SETTINGS)

    fun conversation(sessionId: String): String = "conversation/$sessionId"
    fun files(sessionId: String): String = "files/$sessionId"
}

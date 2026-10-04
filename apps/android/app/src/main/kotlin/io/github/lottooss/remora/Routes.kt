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
    const val NEW_SESSION = "new_session/{hostId}"
    const val APPROVALS = "approvals"
    const val SETTINGS = "settings"
    const val DIAGNOSTICS = "settings/diagnostics"

    const val CONVERSATION = "host/{hostId}/conversation/{sessionId}"
    const val FILES = "host/{hostId}/files/{sessionId}"
    const val HOST_APPROVALS = "host/{hostId}/approvals"
    const val HOST_ID_ARG = "hostId"
    const val SESSION_ID_ARG = "sessionId"

    /** Destinations shown with the bottom navigation bar. */
    val TOP_LEVEL = setOf(PAIR, HOSTS, SESSIONS, APPROVALS, SETTINGS)

    fun conversation(hostId: String, sessionId: String): String =
        "host/${android.net.Uri.encode(hostId)}/conversation/${android.net.Uri.encode(sessionId)}"
    fun files(hostId: String, sessionId: String): String =
        "host/${android.net.Uri.encode(hostId)}/files/${android.net.Uri.encode(sessionId)}"
    fun newSession(hostId: String): String = "new_session/${android.net.Uri.encode(hostId)}"
}

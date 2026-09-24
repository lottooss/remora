package io.github.lottooss.remora.core.data

/** Repositories, SyncEngine, Room cache, DataStore. Implementation: tasks P2-K1 and P2-K2. */
object Data {
    /** Upper bound of cached events per session (blueprint §12). */
    const val MAX_CACHED_EVENTS_PER_SESSION = 2_000
}

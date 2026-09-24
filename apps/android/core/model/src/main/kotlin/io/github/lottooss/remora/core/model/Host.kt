package io.github.lottooss.remora.core.model

/**
 * Represents a paired PC host and its current connection/reachability state.
 */
data class Host(
    val id: HostId,
    val name: String,
    val relayOrigin: String,
    val hostNoisePub: ByteArray,
    val isOnline: Boolean = false,
    val lastSeenAt: Long = 0L,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as Host
        return id == other.id &&
            name == other.name &&
            relayOrigin == other.relayOrigin &&
            hostNoisePub.contentEquals(other.hostNoisePub) &&
            isOnline == other.isOnline &&
            lastSeenAt == other.lastSeenAt
    }

    override fun hashCode(): Int {
        var result = id.hashCode()
        result = 31 * result + name.hashCode()
        result = 31 * result + relayOrigin.hashCode()
        result = 31 * result + hostNoisePub.contentHashCode()
        result = 31 * result + isOnline.hashCode()
        result = 31 * result + lastSeenAt.hashCode()
        return result
    }
}

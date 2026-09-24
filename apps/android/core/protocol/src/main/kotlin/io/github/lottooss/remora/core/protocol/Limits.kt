package io.github.lottooss.remora.core.protocol

/**
 * Protocol limits and constants for RCP/1 and RLY/1.
 * Normative specifications: docs/specs/rcp-v1.md and docs/specs/relay-v1.md.
 */
object Limits {
    /** Largest serialized RCP message (one SC/1 transport record plaintext), in bytes. */
    const val MAX_RCP_MESSAGE_BYTES: Int = 49_152

    /** Largest relay data frame including its 28-byte header, in bytes. */
    const val MAX_DATA_FRAME_BYTES: Int = 65_536

    /** Fixed size of the relay binary data frame header, in bytes (RLY/1 §6). */
    const val DATA_FRAME_HEADER_BYTES: Int = 28

    /** Maximum payload size inside a single relay data frame, in bytes. */
    const val MAX_DATA_FRAME_PAYLOAD_BYTES: Int = MAX_DATA_FRAME_BYTES - DATA_FRAME_HEADER_BYTES

    /** Maximum number of linked endpoints per account in the relay. */
    const val MAX_ENDPOINTS: Int = 32

    /** Time-to-live for a device enrollment ticket, in milliseconds (10 minutes). */
    const val TICKET_TTL_MS: Long = 600_000L

    /** Allowed time for an endpoint to complete in-band authentication, in milliseconds. */
    const val AUTH_TIMEOUT_MS: Long = 10_000L

    /** Delay before relay dispatches a host_offline push notification, in milliseconds (2 minutes). */
    const val HOST_OFFLINE_ALERT_MS: Long = 120_000L

    /** Minimum interval between writing lastSeenAt to persistent storage, in milliseconds. */
    const val LAST_SEEN_WRITE_INTERVAL_MS: Long = 60_000L

    /** Maximum burst frames per second for rate limiting. */
    const val RATE_BURST: Int = 100

    /** Sustained frames per second for rate limiting. */
    const val RATE_FRAMES_PER_SEC: Int = 50
}

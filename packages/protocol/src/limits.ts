/**
 * Protocol limits and constants for RCP/1 and RLY/1.
 * Normative specifications: docs/specs/rcp-v1.md and docs/specs/relay-v1.md.
 */

/** Largest serialized RCP message (one SC/1 transport record plaintext), in bytes. */
export const MAX_RCP_MESSAGE_BYTES = 49_152

/** Largest relay data frame including its 28-byte header, in bytes. */
export const MAX_DATA_FRAME_BYTES = 65_536

/** Fixed size of the relay binary data frame header, in bytes (RLY/1 §6). */
export const DATA_FRAME_HEADER_BYTES = 28

/** Maximum payload size inside a single relay data frame, in bytes. */
export const MAX_DATA_FRAME_PAYLOAD_BYTES = MAX_DATA_FRAME_BYTES - DATA_FRAME_HEADER_BYTES

/** Maximum number of linked endpoints per account in the relay. */
export const MAX_ENDPOINTS = 32

/** Time-to-live for a device enrollment ticket, in milliseconds (10 minutes). */
export const TICKET_TTL_MS = 600_000

/** Allowed time for an endpoint to complete in-band authentication, in milliseconds. */
export const AUTH_TIMEOUT_MS = 10_000

/** Delay before relay dispatches a host_offline push notification, in milliseconds (2 minutes). */
export const HOST_OFFLINE_ALERT_MS = 120_000

/** Minimum interval between writing lastSeenAt to persistent storage, in milliseconds. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

/** Maximum burst frames per second for rate limiting. */
export const RATE_BURST = 100

/** Sustained frames per second for rate limiting. */
export const RATE_FRAMES_PER_SEC = 50

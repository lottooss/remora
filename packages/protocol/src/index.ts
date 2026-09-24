/**
 * @remora/protocol — wire contracts shared by the host, the relay, the testkit,
 * and (through conformance vectors) the Kotlin client.
 *
 * Normative specs: docs/specs/rcp-v1.md (RCP/1) and docs/specs/relay-v1.md (RLY/1).
 * Implementation: task P1-P1. Runtime-neutral: no `node:*` imports, no `Buffer`.
 */

/** Remora Control Protocol major version spoken between phone and host. */
export const RCP_VERSION = 1

/** Relay protocol major version (path prefix `/v1`, control frame `v`, data frame version byte). */
export const RLY_VERSION = 1

/** Largest serialized RCP message (one SC/1 transport record plaintext), in bytes. */
export const MAX_RCP_MESSAGE_BYTES = 49_152

/** Largest relay data frame including its header, in bytes. */
export const MAX_DATA_FRAME_BYTES = 65_536

/** Fixed size of the relay data frame header, in bytes (RLY/1 §6). */
export const DATA_FRAME_HEADER_BYTES = 28

/** WebSocket subprotocol negotiated on `GET /v1/connect`. */
export const RLY_SUBPROTOCOL = 'remora.rly.v1'

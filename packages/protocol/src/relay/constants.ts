/**
 * Constants, error codes, and close codes for RLY/1 (Relay Protocol).
 * Normative spec: docs/specs/relay-v1.md.
 */

export const RLY_VERSION = 1
export const RLY_SUBPROTOCOL = 'remora.rly.v1'

/**
 * WebSocket close codes defined in RLY/1 §9.
 */
export const CloseCodes = {
  NORMAL: 1000,
  MALFORMED: 4400,
  AUTH_FAILED: 4401,
  FORBIDDEN: 4403,
  NOT_FOUND: 4404,
  AUTH_TIMEOUT: 4408,
  CLIENT_REPLACED: 4409,
  RATE_LIMITED: 4429,
} as const

export type CloseCode = (typeof CloseCodes)[keyof typeof CloseCodes]

/**
 * Relay error codes defined in RLY/1.
 */
export const RelayErrorCodes = {
  BAD_REQUEST: 'bad_request',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  NOT_LINKED: 'not_linked',
  PEER_OFFLINE: 'peer_offline',
  RATE_LIMITED: 'rate_limited',
  TOO_LARGE: 'too_large',
  TICKET_INVALID: 'ticket_invalid',
  INTERNAL_ERROR: 'internal_error',
} as const

export type RelayErrorCode = (typeof RelayErrorCodes)[keyof typeof RelayErrorCodes]

/**
 * Peer kind enumeration in binary data frames (RLY/1 §6).
 */
export const PeerKind = {
  HOST: 0x01,
  DEVICE: 0x02,
} as const

export type PeerKind = (typeof PeerKind)[keyof typeof PeerKind]

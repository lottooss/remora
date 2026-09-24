/**
 * @remora/relay-link — RLY/1 client for Node: connect, authenticate, reconnect
 * with jitter, send and receive data frames, correlate control requests, track
 * presence. Used by `@remora/host` and `@remora/testkit`.
 *
 * Implementation: task P1-L1. Never parses SC/1 or RCP payloads.
 */

/** Connection states exposed to consumers (P1-L1 implements the transitions). */
export type RelayLinkState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'backoff' | 'stopped'

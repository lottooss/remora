/**
 * @remora/protocol — wire contracts shared by the host, the relay, the testkit,
 * and (through conformance vectors) the Kotlin client.
 *
 * Normative specs: docs/specs/rcp-v1.md (RCP/1) and docs/specs/relay-v1.md (RLY/1).
 * Implementation: task P1-P1. Runtime-neutral: no `node:*` imports, no `Buffer`.
 */

export const RCP_VERSION = 1

export * from './limits.js'
export * from './rcp/index.js'
export * from './relay/index.js'

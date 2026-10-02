/**
 * Bridge from dsh's real Cordis event shapes to Remora actions (blueprint
 * §8.10, task P7-H5). The handlers are typed against the event signatures of
 * the dsh build this bundle runs with (upstream.lock.json 0.1.5-rc.3, verified
 * in .upstream/deepseek-harness): `session/event` is emitted as
 * `(session, event)`, `agent/error` as `{ agent, turn, step, error }` — with
 * no `sessionId` field, because the failing agent's id IS the session id — and
 * `agent/status` as `{ agent, status }`.
 *
 * The dsh packages are type-only imports pinned by upstream.lock.json; the
 * runtime side of this module is plain Cordis listener registration. Session
 * ids reach the log truncated to 6 characters (AGENTS.md §1.8); event payload
 * content other than the ids and turn/step numbers never reaches the log.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'

/** Text pushed when an `agent/error` failure carries no usable message. */
const FALLBACK_ERROR_TEXT = 'Agent encountered an error'

/** What the bridge routes each dsh event to; each target is the other side of this seam. */
export interface DshEventBridge {
  /** A turn ended in `sessionId` (dsh `session/event` `turn/end`). */
  onTurnEnded(sessionId: string): void
  /** A turn errored in `sessionId` (dsh `agent/error`), with the phone-facing error text. */
  onTurnErrored(sessionId: string, errorText: string): void
  /** An agent changed its running state (dsh `agent/status`). */
  onAgentStatus(agentId: string, status: string): void
}

/**
 * Extracts the phone-facing text from dsh's `agent/error` failure. The failure
 * is `unknown` by contract: a string passes through, an `Error` contributes its
 * message, anything else falls back to a fixed text. The result travels only
 * inside the per-device encrypted push payload — it is never logged.
 */
export function describeTurnError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error && error.message !== '') return error.message
  return FALLBACK_ERROR_TEXT
}

/**
 * Registers the dsh event handlers on the plugin context. Listeners live on
 * the plugin's fiber, so Cordis removes them when the plugin unloads.
 */
export function registerDshEventBridge(ctx: Context, bridge: DshEventBridge): void {
  // dsh emits `session/event` with the owning session as the FIRST argument
  // and the appended event as the second (upstream session/src/index.ts).
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    ctx.logger.info('remora: turn ended in session %s', session.id.slice(0, 6))
    bridge.onTurnEnded(session.id)
  })
  ctx.on('agent/error', (payload) => {
    ctx.logger.info(
      'remora: agent error in session %s (turn %d, step %d)',
      payload.agent.id.slice(0, 6),
      payload.turn,
      payload.step,
    )
    bridge.onTurnErrored(payload.agent.id, describeTurnError(payload.error))
  })
  ctx.on('agent/status', (payload) => {
    bridge.onAgentStatus(payload.agent.id, payload.status)
  })
}

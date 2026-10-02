/**
 * Real dsh event shapes for the host tests (task P7-H5).
 *
 * The session events below are copied verbatim from the P0-S1 fixture
 * recordings of real dsh (packages/host/test/fixtures/dsh-0.1.5-rc.3/
 * follow-live.jsonl, session `session-8d4eacb4-0e4e-4e83-bf6a-00321a631694`);
 * only the `seq` goes through the runtime brand dsh applies to log positions,
 * which does not change the value. The agent helper satisfies the full runtime
 * `Agent` face of the dsh build pinned by upstream.lock.json (0.1.5-rc.3), so
 * `agent/*` event payloads type-check exactly as real dsh emits them, without
 * casts. Only dsh's side of the plugin boundary is faked here (SWARM.md §1.3).
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'

/** The recorded session the fixture events belong to. */
export const FIXTURE_SESSION_ID = 'session-8d4eacb4-0e4e-4e83-bf6a-00321a631694'

/**
 * `{"type":"turn/end","seq":17,"time":1790267652581,"data":{"turn":1,"reason":{"kind":"completed"}}}`
 * — follow-live.jsonl, seq 17.
 */
export const FIXTURE_TURN_END: SessionEvent = {
  type: 'turn/end',
  seq: SessionSeq(17),
  time: 1790267652581,
  data: { turn: 1, reason: { kind: 'completed' } },
}

/**
 * `{"type":"turn/start","seq":4,"time":1790267652498,"data":{"turn":1}}`
 * — follow-live.jsonl, seq 4.
 */
export const FIXTURE_TURN_START: SessionEvent = {
  type: 'turn/start',
  seq: SessionSeq(4),
  time: 1790267652498,
  data: { turn: 1 },
}

/** A real detached dsh `Session` for the recorded fixture session id. */
export function createFixtureSession(): Session {
  return Session.create(SessionId(FIXTURE_SESSION_ID))
}

/**
 * A minimal structural dsh `Agent`: the full runtime face dsh's `agent/*`
 * payloads carry (upstream agent/src/runtime-types.ts declares the extra
 * members by merging into the base interface), with only the members the
 * event wiring must not depend on stubbed to inert no-ops.
 */
export function createTestAgent(sessionId: string): Agent {
  return {
    id: SessionId(sessionId),
    options: {},
    session: Session.create(SessionId(sessionId)),
    inbox: {
      nextTurn: [],
      nextStep: [],
      clear: () => {},
      append: () => {},
      prepend: () => {},
      replace: () => false,
      remove: () => false,
      splice: () => [],
    },
    status: 'idle',
    ctx: new Context(),
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> =>
      task(new AbortController().signal),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
  }
}

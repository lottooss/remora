/**
 * Unit tests for the dsh event bridge (task P7-H5): the handlers are driven
 * through a real Cordis Context with the exact event shapes real dsh emits —
 * a real detached dsh `Session`, the `turn/end` verbatim from the P0-S1
 * fixture recording, and `agent/*` payloads matching the pinned dsh types.
 * The bridge targets are spies: they are the other side of the seam the
 * bridge owns (SWARM.md §1.3), not a mock of the unit under test.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { describeTurnError, registerDshEventBridge } from '../../src/notify/dsh-events.ts'
import { createFixtureSession, createTestAgent, FIXTURE_SESSION_ID, FIXTURE_TURN_END, FIXTURE_TURN_START } from './dsh-test-events.ts'

/** Registers the bridge with spies and returns them. */
function registerSpyBridge() {
  const bridge = {
    onTurnEnded: vi.fn(),
    onTurnErrored: vi.fn(),
    onAgentStatus: vi.fn(),
  }
  const ctx = new Context()
  registerDshEventBridge(ctx, bridge)
  return { ctx, bridge }
}

describe('P7-H5: dsh event bridge', () => {
  it('routes a real (session, event) turn/end emit to onTurnEnded with the session id', () => {
    const { ctx, bridge } = registerSpyBridge()

    ctx.emit('session/event', createFixtureSession(), FIXTURE_TURN_END)

    expect(bridge.onTurnEnded).toHaveBeenCalledTimes(1)
    expect(bridge.onTurnEnded).toHaveBeenCalledWith(FIXTURE_SESSION_ID)
    expect(bridge.onTurnErrored).not.toHaveBeenCalled()
    expect(bridge.onAgentStatus).not.toHaveBeenCalled()
  })

  it('ignores session events that are not turn/end', () => {
    const { ctx, bridge } = registerSpyBridge()

    ctx.emit('session/event', createFixtureSession(), FIXTURE_TURN_START)

    expect(bridge.onTurnEnded).not.toHaveBeenCalled()
    expect(bridge.onTurnErrored).not.toHaveBeenCalled()
    expect(bridge.onAgentStatus).not.toHaveBeenCalled()
  })

  it('routes a real agent/error payload to onTurnErrored with agent.id as the session id', () => {
    const { ctx, bridge } = registerSpyBridge()
    const agent = createTestAgent(FIXTURE_SESSION_ID)

    ctx.emit('agent/error', { agent, turn: 3, step: 1, error: new Error('provider dropped the connection') })

    expect(bridge.onTurnErrored).toHaveBeenCalledTimes(1)
    expect(bridge.onTurnErrored).toHaveBeenCalledWith(FIXTURE_SESSION_ID, 'provider dropped the connection')
    expect(bridge.onTurnEnded).not.toHaveBeenCalled()
  })

  it('passes a string failure through to onTurnErrored', () => {
    const { ctx, bridge } = registerSpyBridge()

    ctx.emit('agent/error', { agent: createTestAgent(FIXTURE_SESSION_ID), turn: 1, step: 2, error: 'rate limited' })

    expect(bridge.onTurnErrored).toHaveBeenCalledWith(FIXTURE_SESSION_ID, 'rate limited')
  })

  it('falls back to a fixed text for a failure that is neither Error nor string', () => {
    const { ctx, bridge } = registerSpyBridge()

    ctx.emit('agent/error', { agent: createTestAgent(FIXTURE_SESSION_ID), turn: 1, step: 2, error: { code: 'E_UNKNOWN' } })

    expect(bridge.onTurnErrored).toHaveBeenCalledWith(FIXTURE_SESSION_ID, 'Agent encountered an error')
  })

  it('routes a real agent/status payload to onAgentStatus with agent.id and the status', () => {
    const { ctx, bridge } = registerSpyBridge()

    ctx.emit('agent/status', { agent: createTestAgent(FIXTURE_SESSION_ID), status: 'running' })

    expect(bridge.onAgentStatus).toHaveBeenCalledTimes(1)
    expect(bridge.onAgentStatus).toHaveBeenCalledWith(FIXTURE_SESSION_ID, 'running')
    expect(bridge.onTurnEnded).not.toHaveBeenCalled()
  })
})

describe('P7-H5: describeTurnError', () => {
  it('uses an Error message, accepts strings, and falls back otherwise', () => {
    expect(describeTurnError(new Error('boom'))).toBe('boom')
    expect(describeTurnError('plain')).toBe('plain')
    expect(describeTurnError(undefined)).toBe('Agent encountered an error')
    expect(describeTurnError(new Error(''))).toBe('Agent encountered an error')
    expect(describeTurnError({ code: 'E_UNKNOWN' })).toBe('Agent encountered an error')
  })
})

/**
 * P7-H10: the AnswerBridge startup self-check must not leak its probe.
 *
 * On main before the fix the self-check dispatched a fake `approval/request`
 * (tool `remora-selfcheck-probe`) through dsh's REAL waterfall and its own
 * ordinary sentinel called `next()` — so every other listener on the event
 * (api-remotes browser forwarding, a real paired bridge) received the bogus
 * request. With a paired bridge the self-check even created a bogus pending
 * approval and pushed a notification for it.
 *
 * The fix (this packet): the prepend probe records the call and RETURNS a
 * result without calling `next()`, so no other listener can ever observe the
 * probe; both probes are disposed in `finally`; the check passes only if the
 * prepend probe ran and no ordinary listener ran first.
 */
import { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { describe, expect, it } from 'vitest'
import { runAnswerBridgeSelfCheck } from '../../src/index.ts'
import { createReplayAgent } from './fixtures.ts'

/**
 * An ordinary `approval/request` listener, shaped exactly like dsh's
 * api-remotes browser forwarding: record what it was handed, then delegate.
 */
function createSpy(received: string[]) {
  return async (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
    received.push(req.toolName)
    return next()
  }
}

describe('P7-H10: AnswerBridge self-check cannot leak the probe', () => {
  it('an ordinary listener never receives the self-check probe', async () => {
    const ctx = new Context()
    const received: string[] = []
    ctx.on('approval/request', createSpy(received))

    const result = await runAnswerBridgeSelfCheck(ctx)

    expect(result).toBe(true)
    expect(received).toEqual([])
  })

  it('disposes both self-check listeners: a later dispatch reaches ordinary listeners only', async () => {
    const ctx = new Context()
    const received: string[] = []
    ctx.on('approval/request', createSpy(received))

    const result = await runAnswerBridgeSelfCheck(ctx)
    expect(result).toBe(true)
    expect(received).toEqual([])

    // The probes are gone — an ordinary dispatch now reaches the spy, and
    // only the spy (no probe/sentinel listener fires a second time).
    await ctx.waterfall(
      'approval/request',
      {
        toolName: 'remora-after-selfcheck',
        agent: createReplayAgent('session-selfcheck-after', 'session-selfcheck-after', []),
      },
      async () => 'unavailable',
    )
    expect(received).toEqual(['remora-after-selfcheck'])
  })
})

/**
 * P7-H10: confirm ADR-0008's withdrawal mechanism against `race.ts`.
 *
 * ADR-0008 (finalized by P0-S2 E3a): when the phone answers first, the bridge
 * withdraws the PC chain by substituting a DERIVED `AbortSignal`
 * (`AbortSignal.any([original, withdrawController.signal])`) on the request
 * before calling `next()`, then aborting the derived signal — which cancels a
 * forwarded browser card via the gateway without aborting the parent turn.
 * `approval/decided` is deliberately NOT a withdrawal path (P0-S2 E3b: it is
 * not forwarded to remote-event clients).
 */
import { describe, expect, it } from 'vitest'
import { PendingRegistry, raceApproval, type DshApprovalRequest } from '../../src/index.ts'
import { loadFollowEvents } from './fixtures.ts'

describe('P7-H10: race.ts withdraws the PC chain via the substituted derived signal', () => {
  it('phone answers first: the request signal is substituted and the derived signal aborts', async () => {
    const pendingRegistry = new PendingRegistry()
    const originalSignal = new AbortController().signal

    const events = loadFollowEvents('follow-tool-approval.jsonl')
    const req: DshApprovalRequest = {
      toolName: 'bash',
      callId: 'mock-call-1',
      agent: { id: 'session-replay', session: { id: 'session-replay', snapshotEvents: () => events } },
      signal: originalSignal,
    }

    let substituted: AbortSignal | undefined
    const next = (): Promise<string> =>
      new Promise((_resolve, reject) => {
        // The PC chain observes the request it was handed — the same object
        // dsh's forwarding chain holds. The bridge must have replaced its
        // signal with a derived one before next() ran (ADR-0008).
        if (req.signal === undefined || req.signal === originalSignal) {
          reject(new Error('raceApproval did not substitute a derived AbortSignal on the request'))
          return
        }
        substituted = req.signal
        req.signal.addEventListener('abort', () => reject(new Error('withdrawn by the bridge')), { once: true })
      })

    const racePromise = raceApproval(req, next, pendingRegistry, {
      approvalTimeoutMs: 10_000,
      hasPairedDevices: () => true,
    })
    await new Promise((resolve) => { setTimeout(resolve, 10) })

    const pending = pendingRegistry.list()[0]
    if (pending?.kind !== 'approval') throw new Error('no pending approval was created')
    pendingRegistry.resolveApproval(pending.id, 'allowed-once', 'phone', 'd_replay1')

    expect(await racePromise).toBe('allowed-once')
    expect(substituted).toBeDefined()
    expect(substituted === originalSignal).toBe(false)
    // Aborting the bridge's controller aborted the derived signal the PC
    // chain observes — the withdrawal actually reaches it.
    expect(substituted?.aborted).toBe(true)
    // The original turn signal is untouched: the parent turn survives.
    expect(originalSignal.aborted).toBe(false)
  })
})

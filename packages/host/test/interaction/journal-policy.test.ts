import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { computeArgsDigest } from '@remora/crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryDeviceRegistry } from '../../src/devices/index.ts'
import { PendingRegistry, type PendingApproval } from '../../src/interaction/pending.ts'
import { registerAnswerBridge } from '../../src/interaction/dsh-waterfalls.ts'
import { DefaultPolicyGuard } from '../../src/policy/index.ts'
import { createTestAgent } from '../notify/dsh-test-events.ts'
import { createApprovalJournalAgent } from './approval-journal.ts'

/** Runs the real bridge and policy guard over a real dsh Session journal. */
async function inspectApproval(
  agent: Agent,
  inspect: (pending: PendingApproval) => void,
  callId: string | null = 'mock-call-1',
): Promise<void> {
  const ctx = new Context()
  const registry = new InMemoryDeviceRegistry()
  registry.addDevice({
    deviceId: 'd_abcdefghijklmnopqrstuvwxyz',
    name: 'Journal test device',
    noisePublicKey: new Uint8Array(32).fill(1),
    devicePsk: new Uint8Array(32).fill(2),
    pushKey: new Uint8Array(32).fill(3),
    createdAt: 1,
    lastSeenAt: 1,
    revoked: false,
  })
  const pendingRegistry = new PendingRegistry()
  const requested = new Promise<PendingApproval>((resolve) => {
    pendingRegistry.subscribe((event) => {
      if (event.type === 'requested' && event.pending.kind === 'approval') resolve(event.pending)
    })
  })
  const dispose = registerAnswerBridge(ctx, {
    registry,
    pendingRegistry,
    policyGuard: new DefaultPolicyGuard({ approvalBiometric: 'high' }),
  })
  const controller = new AbortController()
  const req: ApprovalRequestEvent = {
    toolName: 'bash',
    agent,
    ...(callId === null ? {} : { callId: ToolCallId(callId) }),
    signal: controller.signal,
  }
  const outcome = ctx.waterfall('approval/request', req, async (): Promise<ApprovalOutcome> => 'unavailable')
  try {
    inspect(await requested)
  } finally {
    controller.abort()
    await outcome
    dispose()
  }
}

describe('P7-H10: approval journal receiver and full-argument policy', () => {
  it('preserves the real Session receiver when reading the recorded approval preview', async () => {
    await inspectApproval(createApprovalJournalAgent(), (pending) => {
      expect(pending.preview).toEqual({
        text: 'echo remora-p7-h10 && uptime',
        json: '{"command":"echo remora-p7-h10 && uptime"}',
      })
      expect(pending.argsDigest).toBe(computeArgsDigest(pending.preview))
      expect(pending.risk).toBe('normal')
      expect(pending.requiresSignature).toBe(false)
    })
  })

  it('classifies a destructive command from the journal when the real request has no arguments field', async () => {
    await inspectApproval(createApprovalJournalAgent('{"command":"git reset --hard"}'), (pending) => {
      expect(pending.risk).toBe('high')
      expect(pending.requiresSignature).toBe(true)
    })
  })

  it('classifies the complete arguments even when the destructive suffix is beyond the preview limit', async () => {
    const command = `echo ${'x'.repeat(2_500)}; git reset --hard`
    await inspectApproval(createApprovalJournalAgent(JSON.stringify({ command })), (pending) => {
      expect(pending.risk).toBe('high')
      expect(pending.requiresSignature).toBe(true)
      expect(pending.preview.text.startsWith('echo ')).toBe(true)
      expect(new TextEncoder().encode(pending.preview.text).byteLength).toBeLessThanOrEqual(2_048)
      expect(pending.preview.text).not.toContain('git reset --hard')
      expect(pending.preview.json).not.toContain('git reset --hard')
      expect(pending.argsDigest).toBe(computeArgsDigest(pending.preview))
    })
  })

  it.each([
    ['malformed JSON', '{"command":'],
    ['null arguments', 'null'],
    ['array arguments', '[]'],
    ['string arguments', '"git reset --hard"'],
    ['missing command', '{}'],
    ['non-string command', '{"command":42}'],
    ['empty command', '{"command":"  "}'],
  ])('fails closed to high risk for %s', async (_label, rawArguments) => {
    await inspectApproval(createApprovalJournalAgent(rawArguments), (pending) => {
      expect(pending.risk).toBe('high')
      expect(pending.requiresSignature).toBe(true)
    })
  })

  it('fails closed when the matching tool call is missing', async () => {
    await inspectApproval(createTestAgent('session-missing-call'), (pending) => {
      expect(pending.risk).toBe('high')
      expect(pending.requiresSignature).toBe(true)
    })
  })

  it('fails closed when the journal tool name does not match the approval', async () => {
    await inspectApproval(createApprovalJournalAgent('{"command":"echo safe"}', 'read_file'), (pending) => {
      expect(pending.risk).toBe('high')
      expect(pending.requiresSignature).toBe(true)
    })
  })

  it('fails closed when the approval has no call id to bind to its arguments', async () => {
    await inspectApproval(createApprovalJournalAgent(), (pending) => {
      expect(pending.risk).toBe('high')
      expect(pending.requiresSignature).toBe(true)
    }, null)
  })
})

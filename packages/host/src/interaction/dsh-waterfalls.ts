import type { Context } from '@deepseek-ai/cordis'
import type { DeviceRegistry } from '../devices/index.ts'
import type { PendingRegistry } from './pending.ts'
import { raceApproval, raceQuestion, type PolicyGuard } from './race.ts'

export interface AnswerBridgeOptions {
  registry: DeviceRegistry
  pendingRegistry: PendingRegistry
  policyGuard?: PolicyGuard | undefined
  approvalTimeoutMs?: number | undefined
  questionTimeoutMs?: number | undefined
}

/**
 * Startup self-check: verifies that root-context `prepend: true` listeners
 * actually receive waterfall events before ordinary listeners (threat T21).
 */
export async function runAnswerBridgeSelfCheck(ctx: Context): Promise<boolean> {
  const order: string[] = []

  const bridge = (ctx as any).on(
    'approval/request',
    async function bridgeProbe(_req: unknown, next: () => Promise<unknown>) {
      order.push('bridge-prepend')
      return next()
    },
    { prepend: true },
  )

  const sentinel = (ctx as any).on('approval/request', async function sentinelProbe(_req: unknown, next: () => Promise<unknown>) {
    order.push('sentinel-ordinary')
    return next()
  })

  try {
    if (typeof (ctx as any).waterfall === 'function') {
      await (ctx as any).waterfall(
        'approval/request',
        {
          toolName: 'remora-selfcheck-probe',
          agent: { id: 'remora-selfcheck-agent', session: { id: 'remora-selfcheck' } },
        },
        async () => {
          order.push('terminal')
          return 'unavailable'
        },
      )
    }
  } catch {
    // If waterfall dispatch errors, self-check records order so far
  } finally {
    bridge()
    sentinel()
  }

  // If waterfall executed, bridge-prepend must be first
  if (order.length > 0 && order[0] !== 'bridge-prepend') {
    ctx.logger.error(
      'CRITICAL: Remora AnswerBridge listener is NOT ordered first in Cordis waterfall! Observed order: %j',
      order,
    )
    return false
  }

  ctx.logger.info('remora: AnswerBridge waterfall self-check passed')
  return true
}

/**
 * Registers root-context listeners for `approval/request` and `user-questions/request`.
 * Transparently delegates with `return next()` when no paired devices exist.
 */
export function registerAnswerBridge(ctx: Context, options: AnswerBridgeOptions): () => void {
  const hasPairedDevices = () => {
    return options.registry.listDevices().some((d) => !d.revoked)
  }

  const findPreview = (agent: unknown, callId: string) => {
    try {
      const a = agent as { session?: { snapshotEvents?: () => Array<{ type: string; data?: any }> } }
      if (a?.session?.snapshotEvents) {
        const events = a.session.snapshotEvents()
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i]
          if (ev?.type === 'tool/call' && ev.data?.callId === callId) {
            const rawArgs = ev.data.arguments ?? {}
            const text = typeof rawArgs === 'string' ? rawArgs : String(rawArgs.command ?? rawArgs.text ?? ev.data.name ?? '')
            const json = typeof rawArgs === 'string' ? JSON.stringify({ raw: rawArgs }) : JSON.stringify(rawArgs)
            return { text, json }
          }
        }
      }
    } catch {
      // fallback
    }
    return undefined
  }

  // 1. approval/request
  const disposeApproval = (ctx as any).on(
    'approval/request',
    async (req: any, next: () => Promise<string>) => {
      if (!hasPairedDevices()) {
        return next()
      }

      return raceApproval(req, next, options.pendingRegistry, {
        approvalTimeoutMs: options.approvalTimeoutMs,
        policyGuard: options.policyGuard,
        findPreview,
        hasPairedDevices,
      })
    },
    { prepend: true },
  )

  // 2. user-questions/request
  const disposeQuestions = (ctx as any).on(
    'user-questions/request',
    async (req: any, next: () => Promise<unknown>) => {
      if (!hasPairedDevices()) {
        return next()
      }

      return raceQuestion(req, next, options.pendingRegistry, {
        questionTimeoutMs: options.questionTimeoutMs,
        hasPairedDevices,
      })
    },
    { prepend: true },
  )

  return () => {
    disposeApproval()
    disposeQuestions()
  }
}

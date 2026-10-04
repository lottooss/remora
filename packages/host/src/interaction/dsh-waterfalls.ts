/**
 * The AnswerBridge (ADR-0008): root-context `prepend: true` listeners on dsh's
 * real `approval/request` and `user-questions/request` answerer waterfalls.
 * With paired devices it registers a pending item (RCP/1 §8) and races the
 * phone against the PC chain (`race.ts`); without any it delegates
 * transparently, so dsh behaves exactly as without Remora.
 *
 * The listeners are typed against the real upstream event declarations
 * (type-only devDependencies pinned to `upstream.lock.json`): the
 * `declare module '@deepseek-ai/cordis'` blocks inside
 * `@deepseek-ai/dsh-user-approval/types` and `@deepseek-ai/dsh-user-questions/types`
 * augment the Context events, so every listener below is declared by the
 * compiler — no untyped context casts and no loosely typed request remain.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequestEvent,
} from '@deepseek-ai/dsh-user-questions/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { truncateUtf8 } from '../adapter/event-map.ts'
import type { DeviceRegistry } from '../devices/index.ts'
import type { PendingRegistry } from './pending.ts'
import { raceApproval, raceQuestion, isDshQuestionAnswer } from './race.ts'
import type { PolicyGuard } from '../policy/index.ts'

export interface AnswerBridgeOptions {
  registry: DeviceRegistry
  pendingRegistry: PendingRegistry
  policyGuard?: PolicyGuard | undefined
  approvalTimeoutMs?: number | undefined
  questionTimeoutMs?: number | undefined
}

/**
 * Largest pending-item preview text/json, UTF-8 bytes. RCP/1 §8 defines no
 * numeric cap for `preview`; the §5 `tool.call.args` budget (2 KiB) keeps one
 * pending item far inside the 48 KiB RCP message cap while still showing a
 * usable summary on the phone.
 */
const PREVIEW_MAX_BYTES = 2_048

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Startup self-check: verifies that root-context `prepend: true` listeners
 * actually receive waterfall events before ordinary listeners (threat T21).
 *
 * The probe claims the request by RETURNING a result — it never calls
 * `next()` — so no listener behind it (api-remotes browser forwarding, a real
 * paired bridge) can ever observe the probe, and with paired devices no bogus
 * pending approval is created. The ordinary-position sentinel also returns
 * without delegating, so even a broken ordering cannot leak the probe further.
 * Both probes are disposed in `finally`.
 */
export async function runAnswerBridgeSelfCheck(ctx: Context): Promise<boolean> {
  const order: string[] = []

  const bridge = ctx.on(
    'approval/request',
    async function bridgeProbe(_req: ApprovalRequestEvent): Promise<ApprovalOutcome> {
      order.push('bridge-prepend')
      return 'unavailable'
    },
    { prepend: true },
  )

  const sentinel = ctx.on(
    'approval/request',
    async function sentinelProbe(_req: ApprovalRequestEvent): Promise<ApprovalOutcome> {
      order.push('sentinel-ordinary')
      return 'unavailable'
    },
  )

  try {
    await ctx.waterfall(
      'approval/request',
      {
        toolName: 'remora-selfcheck-probe',
        // The probe is dispatched before any real agent exists, so the
        // synthetic agent is only the identity the type demands. Every
        // listener that could observe it is registered in this function and
        // ignores the payload; the probe never reaches other listeners.
        agent: { id: 'remora-selfcheck-agent' as SessionId } as Agent,
      },
      async (): Promise<ApprovalOutcome> => {
        order.push('terminal')
        return 'unavailable'
      },
    )
  } catch {
    // A dispatch error counts as a failed check; the observed order decides.
  } finally {
    bridge()
    sentinel()
  }

  // Pass only if the prepend probe ran first and no ordinary listener ran:
  // an empty order (waterfall could not dispatch at all) fails closed.
  const passed = order[0] === 'bridge-prepend' && !order.includes('sentinel-ordinary')
  if (!passed) {
    ctx.logger.error(
      'CRITICAL: Remora AnswerBridge listener is NOT ordered first in Cordis waterfall (or the probe leaked): observed order: %j',
      order,
    )
    return false
  }

  ctx.logger.info('remora: AnswerBridge waterfall self-check passed')
  return true
}

/**
 * Builds the pending-item preview from one `tool/call` event's data. Real dsh
 * logs the model-produced arguments as a raw JSON STRING
 * (`{ turn, step, callId, name, arguments }`, verified against the recorded
 * `dsh-0.1.5-rc.3` fixtures): the string is parsed here so shell tools preview
 * the actual command instead of the JSON wrapper. `preview.json` is the
 * parsed-and-re-serialized arguments, truncated per the RCP/1 §5 args budget;
 * malformed JSON falls back to the raw string on both fields.
 */
function buildPreview(rawArguments: unknown, toolName: unknown): { text: string; json: string } {
  if (rawArguments === undefined || rawArguments === null) {
    return { text: typeof toolName === 'string' ? toolName : '', json: '{}' }
  }

  let parsed: unknown = rawArguments
  if (typeof rawArguments === 'string') {
    try {
      parsed = JSON.parse(rawArguments)
    } catch {
      // Malformed model JSON: both preview fields carry the raw string.
      const raw = truncateUtf8(rawArguments, PREVIEW_MAX_BYTES)
      return { text: raw, json: raw }
    }
  }

  let serialized: string
  try {
    serialized = JSON.stringify(parsed) ?? ''
  } catch {
    // Non-JSON arguments (cycle or bigint): the raw text is the best preview.
    const raw = typeof rawArguments === 'string' ? rawArguments : ''
    return { text: truncateUtf8(raw, PREVIEW_MAX_BYTES), json: '{}' }
  }

  const command = isRecord(parsed) ? parsed['command'] : undefined
  const text = typeof command === 'string' && command.length > 0 ? command : serialized
  return { text: truncateUtf8(text, PREVIEW_MAX_BYTES), json: truncateUtf8(serialized, PREVIEW_MAX_BYTES) }
}

/**
 * Looks up the preview of one tool call in the agent's live session journal.
 * dsh augments the wire `Agent` (`{ id }`) with the runtime `session` handle
 * at dispatch time (verified by P0-S2 Q7), so the access is structural
 * narrowing over `unknown` — the type-level `Agent` carries no `session`.
 */
function findPreview(agent: unknown, callId: string): { text: string; json: string } | undefined {
  if (!isRecord(agent)) return undefined
  const session = agent['session']
  if (!isRecord(session)) return undefined
  const snapshotEvents = session['snapshotEvents']
  if (typeof snapshotEvents !== 'function') return undefined

  let snapshot: unknown
  try {
    snapshot = snapshotEvents()
  } catch {
    return undefined
  }
  if (!Array.isArray(snapshot)) return undefined
  const events: readonly unknown[] = snapshot

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!isRecord(event) || event['type'] !== 'tool/call') continue
    const data = event['data']
    if (!isRecord(data) || data['callId'] !== callId) continue
    return buildPreview(data['arguments'], data['name'])
  }
  return undefined
}

/**
 * Registers root-context listeners for `approval/request` and `user-questions/request`.
 * Transparently delegates with `return next()` when no paired devices exist.
 */
export function registerAnswerBridge(ctx: Context, options: AnswerBridgeOptions): () => void {
  const hasPairedDevices = () => {
    return options.registry.listDevices().some((d) => !d.revoked)
  }

  // 1. approval/request
  const disposeApproval = ctx.on(
    'approval/request',
    async (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
      if (!hasPairedDevices()) {
        return next()
      }

      const outcome = await raceApproval(req, next, options.pendingRegistry, {
        approvalTimeoutMs: options.approvalTimeoutMs,
        policyGuard: options.policyGuard,
        findPreview,
        hasPairedDevices,
      })
      // dsh's approval waterfall closes over the ApprovalOutcome vocabulary.
      // The bridge's outcome is that vocabulary in every production path; a
      // foreign string from a non-conforming PC chain is not a grant — fail
      // closed to 'unavailable' (AGENTS.md §1.4).
      return outcome === 'allowed-once' || outcome === 'rejected' || outcome === 'cancelled' || outcome === 'unavailable'
        ? outcome
        : 'unavailable'
    },
    { prepend: true },
  )

  // 2. user-questions/request
  const disposeQuestions = ctx.on(
    'user-questions/request',
    async (req: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>) => {
      if (!hasPairedDevices()) {
        return next()
      }

      const outcome: unknown = await raceQuestion(req, next, options.pendingRegistry, {
        questionTimeoutMs: options.questionTimeoutMs,
        hasPairedDevices,
      })
      // The typed waterfall must resolve with a structured answer. The real
      // dsh chain does; a non-conforming PC listener's bare string (e.g.
      // 'unavailable') must not reach dsh as a fabricated user answer — fail
      // closed instead (AGENTS.md §1.4).
      if (!isDshQuestionAnswer(outcome)) {
        throw new Error('remora: the question answerer chain returned no structured answer')
      }
      return outcome
    },
    { prepend: true },
  )

  return () => {
    disposeApproval()
    disposeQuestions()
  }
}

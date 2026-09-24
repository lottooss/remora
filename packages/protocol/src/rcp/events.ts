import { z } from 'zod'
import {
  EpochMsSchema,
  ModelRefSchema,
  PreviewSchema,
  SeqSchema,
  SessionIdSchema,
  UuidSchema,
} from './shared.ts'
import type { ModelRef, Preview } from './shared.ts'

/**
 * SessionEvent union (RCP/1 §5 and the interaction lifecycle kinds). Decoding
 * must never fail on unknown kinds or unknown enum values: unknown kinds fall
 * back to `{ kind: 'unknown', dshType }` and open enums fall back to
 * `'unknown'` (or the conservative `'high'` risk) per RCP/1 §1.
 */

export const SESSION_EVENT_KINDS = [
  'session.created',
  'session.status',
  'turn.start',
  'turn.end',
  'agent.error',
  'assistant.message',
  'assistant.delta',
  'tool.call',
  'tool.result',
  'approval.asked',
  'approval.decided',
  'question.asked',
  'question.decided',
  'unknown',
] as const

export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number]

export type SessionStatus = 'idle' | 'running' | 'error' | 'unknown'
export type TurnEndStatus = 'completed' | 'cancelled' | 'error' | 'interrupted' | 'unknown'
export type ToolResultStatus = 'ok' | 'error' | 'denied' | 'cancelled' | 'timeout' | 'unknown'
export type ApprovalRisk = 'normal' | 'high'
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'unknown'
export type AnsweredBy = 'phone' | 'pc' | 'system'

/** Common frame carried by every known-kind event. */
export interface SessionEventCommon {
  seq: number
  at: number
}

export type SessionEvent =
  | (SessionEventCommon & { kind: 'session.created'; sessionId: string })
  | (SessionEventCommon & { kind: 'session.status'; sessionId: string; status: SessionStatus })
  | (SessionEventCommon & { kind: 'turn.start' })
  | (SessionEventCommon & { kind: 'turn.end'; status: TurnEndStatus; error?: string })
  | (SessionEventCommon & { kind: 'agent.error'; message: string; code?: string })
  | (SessionEventCommon & {
      kind: 'assistant.message'
      text: string
      reasoning?: string
      model?: ModelRef
    })
  | (SessionEventCommon & {
      kind: 'assistant.delta'
      index: number
      text?: string
      reasoning?: string
      attempt?: string
    })
  | (SessionEventCommon & {
      kind: 'tool.call'
      callId: string
      tool: string
      title: string
      args: Preview
    })
  | (SessionEventCommon & {
      kind: 'tool.result'
      callId: string
      status: ToolResultStatus
      output: Preview
    })
  | (SessionEventCommon & {
      kind: 'approval.asked'
      id: string
      toolName: string
      callId?: string
      risk?: ApprovalRisk
    })
  | (SessionEventCommon & {
      kind: 'approval.decided'
      toolName: string
      callId?: string
      outcome: ApprovalOutcome
    })
  | (SessionEventCommon & { kind: 'question.asked'; id: string; text: string })
  | (SessionEventCommon & { kind: 'question.decided'; id: string; outcome: string; by?: AnsweredBy })
  | { kind: 'unknown'; dshType: string; [key: string]: unknown }

const commonFields = {
  seq: SeqSchema,
  at: EpochMsSchema,
} as const

const knownSessionEventSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('session.created'), ...commonFields, sessionId: SessionIdSchema })
    .passthrough(),
  z
    .object({
      kind: z.literal('session.status'),
      ...commonFields,
      sessionId: SessionIdSchema,
      status: z.enum(['idle', 'running', 'error', 'unknown']).catch('unknown'),
    })
    .passthrough(),
  z.object({ kind: z.literal('turn.start'), ...commonFields }).passthrough(),
  z
    .object({
      kind: z.literal('turn.end'),
      ...commonFields,
      status: z
        .enum(['completed', 'cancelled', 'error', 'interrupted', 'unknown'])
        .catch('unknown'),
      error: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('agent.error'),
      ...commonFields,
      message: z.string(),
      code: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('assistant.message'),
      ...commonFields,
      text: z.string(),
      reasoning: z.string().optional(),
      model: ModelRefSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('assistant.delta'),
      ...commonFields,
      index: z.number().int().min(0),
      text: z.string().optional(),
      reasoning: z.string().optional(),
      attempt: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('tool.call'),
      ...commonFields,
      callId: z.string().min(1),
      tool: z.string().min(1),
      title: z.string(),
      args: PreviewSchema,
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('tool.result'),
      ...commonFields,
      callId: z.string().min(1),
      status: z.enum(['ok', 'error', 'denied', 'cancelled', 'timeout', 'unknown']).catch('unknown'),
      output: PreviewSchema,
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('approval.asked'),
      ...commonFields,
      id: UuidSchema,
      toolName: z.string().min(1),
      callId: z.string().optional(),
      risk: z.enum(['normal', 'high']).catch('high'),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('approval.decided'),
      ...commonFields,
      toolName: z.string().min(1),
      callId: z.string().optional(),
      outcome: z
        .enum(['allowed-once', 'rejected', 'cancelled', 'unavailable', 'unknown'])
        .catch('unknown'),
    })
    .passthrough(),
  z
    .object({ kind: z.literal('question.asked'), ...commonFields, id: UuidSchema, text: z.string() })
    .passthrough(),
  z
    .object({
      kind: z.literal('question.decided'),
      ...commonFields,
      id: UuidSchema,
      outcome: z.string(),
      by: z.enum(['phone', 'pc', 'system']).optional(),
    })
    .passthrough(),
  z.object({ kind: z.literal('unknown'), dshType: z.string() }).passthrough(),
])

const knownSessionEventKinds = new Set<string>(SESSION_EVENT_KINDS)

const unknownSessionEventSchema = z
  .object({
    kind: z
      .string()
      .refine((kind) => !knownSessionEventKinds.has(kind), { message: 'known kind, must validate against its strict shape' }),
  })
  .passthrough()
  .transform((value) => ({ ...value, kind: 'unknown' as const, dshType: value.kind }))

/**
 * Validates one session event. Known kinds are strictly shaped (with open-enum
 * fallbacks); any other `kind` decodes to the `unknown` fallback carrying the
 * original dsh type, so one novel event never fails the enclosing message.
 */
export const SessionEventSchema = z.union([knownSessionEventSchema, unknownSessionEventSchema])

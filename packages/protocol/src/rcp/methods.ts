import { z } from 'zod'

import { SessionEventSchema } from './events.ts'
import {
  B64uSchema,
  DeviceIdSchema,
  EpochMsSchema,
  HostIdSchema,
  ModelRefSchema,
  RequestIdSchema,
  SeqSchema,
  SessionIdSchema,
  U32Schema,
  UuidSchema,
  WorkspaceIdSchema,
} from './shared.ts'

/**
 * Params and result schemas for every RCP/1 method (spec §4–§11), plus the
 * shared payload shapes they compose. Request params validate strictly (a
 * malformed request fails closed → `invalid_params`); results and embedded
 * events tolerate unknown fields and decode open enums to their documented
 * fallbacks per RCP/1 §1.
 */

/** Capability flag announced by `hello` (RCP/1 §4). */
export const FeatureSchema = z.enum([
  'sessions',
  'interaction',
  'workspaces',
  'files',
  'diffs.git',
  'notify',
  'models',
])
export type Feature = z.infer<typeof FeatureSchema>

/** Parameter object for methods that take no arguments (`{}` in RCP/1). */
export const EmptyParamsSchema = z.object({}).passthrough()

/** Success result of opening a stream: the server-allocated stream id (RCP/1 §2). */
export const StreamOpenResultSchema = z.object({ sid: U32Schema }).passthrough()
export type StreamOpenResult = z.infer<typeof StreamOpenResultSchema>

/** Base64url without padding, allowing the empty string for zero-length payloads (Crypto/1 §2). */
const B64uDataSchema = z.string().regex(/^[A-Za-z0-9_-]*$/)

export const SessionSummarySchema = z
  .object({
    id: SessionIdSchema,
    title: z.string().nullable(),
    workspace: z
      .object({
        id: WorkspaceIdSchema.nullable(),
        path: z.string().nullable(),
        title: z.string().nullable(),
      })
      .passthrough(),
    status: z.enum(['idle', 'running', 'error', 'unknown']).catch('unknown'),
    updatedAt: EpochMsSchema,
    model: ModelRefSchema.optional(),
    parentId: SessionIdSchema.optional(),
    archived: z.boolean().optional(),
  })
  .passthrough()
export type SessionSummary = z.infer<typeof SessionSummarySchema>

export const WorkspaceSchema = z
  .object({
    id: WorkspaceIdSchema,
    title: z.string(),
    path: z.string(),
    remoteAllowed: z.boolean(),
  })
  .passthrough()
export type Workspace = z.infer<typeof WorkspaceSchema>

export const NotifyPrefsSchema = z
  .object({
    approval: z.boolean(),
    question: z.boolean(),
    turnDone: z.boolean(),
    turnError: z.boolean(),
  })
  .passthrough()
export type NotifyPrefs = z.infer<typeof NotifyPrefsSchema>

/** One frame of `sessions.follow` (RCP/1 §5). */
export const FollowItemSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('snapshot'),
      session: SessionSummarySchema,
      events: z.array(SessionEventSchema),
      hasOlder: z.boolean(),
    })
    .passthrough(),
  z
    .object({ type: z.literal('events'), events: z.array(SessionEventSchema) })
    .passthrough(),
  z
    .object({ type: z.literal('live.start'), attempt: z.string(), afterSeq: SeqSchema })
    .passthrough(),
  z
    .object({
      type: z.literal('live.delta'),
      attempt: z.string(),
      index: z.number().int().min(0),
      text: z.string().optional(),
      reasoning: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('live.end'),
      attempt: z.string(),
      outcome: z.enum(['settled', 'abandoned']),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('reset'),
      reason: z.enum(['cursor_unavailable', 'session_replaced']),
    })
    .passthrough(),
])
export type FollowItem = z.infer<typeof FollowItemSchema>

export const ControlStateSchema = z
  .object({
    sessionId: SessionIdSchema,
    running: z.boolean(),
    queue: z.array(
      z
        .object({
          itemId: z.string().min(1),
          text: z.string(),
          delivery: z.enum(['queue', 'steer']),
        })
        .passthrough(),
    ),
    jobs: z.array(
      z
        .object({ id: z.string().min(1), title: z.string(), state: z.string() })
        .passthrough(),
    ),
  })
  .passthrough()
export type ControlState = z.infer<typeof ControlStateSchema>

/** One frame of `sessions.control` (RCP/1 §5). */
export const ControlItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('baseline'), sessions: z.array(ControlStateSchema) }).passthrough(),
  z.object({ type: z.literal('update'), session: ControlStateSchema }).passthrough(),
  z.object({ type: z.literal('removed'), sessionId: SessionIdSchema }).passthrough(),
])
export type ControlItem = z.infer<typeof ControlItemSchema>

export const PendingApprovalSchema = z
  .object({
    kind: z.literal('approval'),
    id: UuidSchema,
    sessionId: SessionIdSchema,
    sessionTitle: z.string().nullable(),
    toolName: z.string().min(1),
    callId: z.string().optional(),
    reason: z.string().optional(),
    preview: z.object({ text: z.string(), json: z.string() }).passthrough(),
    argsDigest: z.string().min(1),
    risk: z.enum(['normal', 'high']),
    requiresSignature: z.boolean(),
    createdAt: EpochMsSchema,
    expiresAt: EpochMsSchema,
  })
  .passthrough()
export type PendingApproval = z.infer<typeof PendingApprovalSchema>

export const PendingQuestionSchema = z
  .object({
    kind: z.literal('question'),
    id: UuidSchema,
    sessionId: SessionIdSchema,
    sessionTitle: z.string().nullable(),
    questions: z.array(
      z
        .object({
          id: z.string().min(1),
          question: z.string(),
          detail: z.string().optional(),
          header: z.string().optional(),
          options: z
            .array(z.object({ label: z.string(), description: z.string().optional() }).passthrough())
            .optional(),
          multiSelect: z.boolean().optional(),
          intent: z
            .object({ kind: z.literal('plan-review'), approve: z.string() })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
    createdAt: EpochMsSchema,
    expiresAt: EpochMsSchema,
  })
  .passthrough()
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>

export const PendingSchema = z.discriminatedUnion('kind', [
  PendingApprovalSchema,
  PendingQuestionSchema,
])
export type Pending = z.infer<typeof PendingSchema>

/** One frame of `interaction.follow` (RCP/1 §8). */
export const InteractionItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('baseline'), pending: z.array(PendingSchema) }).passthrough(),
  z.object({ type: z.literal('requested'), pending: PendingSchema }).passthrough(),
  z
    .object({
      type: z.literal('resolved'),
      id: UuidSchema,
      outcome: z.string(),
      by: z.enum(['phone', 'pc', 'system']),
      deviceId: DeviceIdSchema.optional(),
    })
    .passthrough(),
])
export type InteractionItem = z.infer<typeof InteractionItemSchema>

export const HelloParamsSchema = z
  .object({
    rcp: z.array(z.number().int().min(0)),
    app: z
      .object({
        name: z.enum(['remora-android', 'remora-testkit']),
        version: z.string().min(1),
        build: z.number().int().optional(),
      })
      .passthrough(),
  })
  .passthrough()
export const HelloResultSchema = z
  .object({
    rcp: z.literal(1),
    host: z
      .object({
        id: HostIdSchema,
        name: z.string(),
        os: z.enum(['win32', 'darwin', 'linux']),
        pathSeparator: z.enum(['\\', '/']),
        versions: z.object({ remora: z.string(), dsh: z.string() }).passthrough(),
      })
      .passthrough(),
    features: z.array(FeatureSchema),
    roots: z.array(z.string()),
    policy: z
      .object({
        approvalBiometric: z.enum(['high', 'all', 'never']),
        allowRemoteSessionStart: z.boolean(),
      })
      .passthrough(),
    limits: z
      .object({ maxMessageBytes: z.number().int().min(0), maxStreams: z.number().int().min(0) })
      .passthrough(),
    time: EpochMsSchema,
  })
  .passthrough()

export const PingParamsSchema = z.object({ t: z.number() }).passthrough()
export const PingResultSchema = z
  .object({ t: z.number(), hostTime: EpochMsSchema })
  .passthrough()

export const HostStatusParamsSchema = EmptyParamsSchema
export const HostStatusResultSchema = z
  .object({
    uptimeMs: z.number().min(0),
    agentsRunning: z.number().int().min(0),
    keepAwake: z.boolean(),
    dsh: z.object({ version: z.string(), profile: z.string() }).passthrough(),
  })
  .passthrough()

export const SessionsListParamsSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    includeArchived: z.boolean().optional(),
  })
  .passthrough()
export const SessionsListResultSchema = z
  .object({ items: z.array(SessionSummarySchema), next: z.string().optional() })
  .passthrough()

export const SessionsSearchSchema = z
  .object({
    sessionId: SessionIdSchema,
    title: z.string().nullable(),
    snippet: z.string(),
    at: EpochMsSchema,
  })
  .passthrough()
export type SessionsSearchHit = z.infer<typeof SessionsSearchSchema>

export const SessionsSearchParamsSchema = z
  .object({ query: z.string().min(1).max(200) })
  .passthrough()
export const SessionsSearchResultSchema = z
  .object({ results: z.array(SessionsSearchSchema) })
  .passthrough()

/**
 * `sessions.get` is not part of RCP/1 §4–§11; P7-C1 removed it from the method
 * registry. The host still registers a handler until P7-H7 deletes it, so the
 * schemas stay exported for that handler. Do not build new methods on them.
 */
export const SessionsGetParamsSchema = z.object({ sessionId: SessionIdSchema }).passthrough()
export const SessionsGetResultSchema = z
  .object({
    session: SessionSummarySchema,
    events: z.array(SessionEventSchema),
    hasOlder: z.boolean(),
  })
  .passthrough()

export const SessionsCreateParamsSchema = z
  .object({
    requestId: RequestIdSchema,
    workspace: z.union([
      z.object({ id: WorkspaceIdSchema }).passthrough(),
      z.object({ path: z.string().min(1) }).passthrough(),
    ]),
    model: ModelRefSchema.optional(),
    preset: z.string().optional(),
  })
  .passthrough()
export const SessionsCreateResultSchema = z
  .object({ sessionId: SessionIdSchema, workspaceId: WorkspaceIdSchema })
  .passthrough()

export const SessionsPromptParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    requestId: RequestIdSchema,
    text: z.string().min(1).max(32_768),
    delivery: z.enum(['queue', 'steer']),
  })
  .passthrough()
export const SessionsPromptResultSchema = z
  .object({ accepted: z.literal(true), duplicate: z.boolean() })
  .passthrough()

export const SessionsCancelParamsSchema = z
  .object({ sessionId: SessionIdSchema, requestId: RequestIdSchema })
  .passthrough()
export const SessionsCancelResultSchema = z.object({ requested: z.literal(true) }).passthrough()

export const SessionsFollowParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    afterSeq: SeqSchema.optional(),
    live: z.boolean().optional(),
  })
  .passthrough()

export const SessionsPageParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    beforeSeq: SeqSchema,
    limit: z.number().int().min(1).max(100).optional(),
  })
  .passthrough()
export const SessionsPageResultSchema = z
  .object({ events: z.array(SessionEventSchema), hasOlder: z.boolean() })
  .passthrough()

export const SessionsEventTextParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    seq: SeqSchema,
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(32_768).optional(),
  })
  .passthrough()
export const SessionsEventTextResultSchema = z
  .object({
    text: z.string(),
    offset: z.number().int().min(0),
    eof: z.boolean(),
  })
  .passthrough()

export const SessionsToolOutputParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    callId: z.string().min(1),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(32_768).optional(),
  })
  .passthrough()
export const SessionsToolOutputResultSchema = z
  .object({
    text: z.string(),
    offset: z.number().int().min(0),
    total: z.number().int().min(0),
    eof: z.boolean(),
  })
  .passthrough()

export const SessionsControlParamsSchema = EmptyParamsSchema

export const SessionsQueueUpdateParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    itemId: z.string().min(1),
    action: z.enum(['edit', 'remove', 'steer']),
    text: z.string().optional(),
    requestId: RequestIdSchema,
  })
  .passthrough()
export const SessionsQueueUpdateResultSchema = z.object({ ok: z.literal(true) }).passthrough()

export const SessionsRenameParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    title: z.string().min(1).max(120),
    requestId: RequestIdSchema,
  })
  .passthrough()
export const SessionsRenameResultSchema = z.object({ title: z.string() }).passthrough()

export const SessionsSelectModelParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    model: ModelRefSchema,
    requestId: RequestIdSchema,
  })
  .passthrough()
export const SessionsSelectModelResultSchema = z
  .object({ model: ModelRefSchema })
  .passthrough()

export const WorkspacesListParamsSchema = EmptyParamsSchema
export const WorkspacesListResultSchema = z
  .object({ workspaces: z.array(WorkspaceSchema) })
  .passthrough()

/** Params of `workspaces.follow` (RCP/1 §6). */
export const WorkspacesFollowParamsSchema = EmptyParamsSchema

/** One frame of `workspaces.follow` (RCP/1 §6). */
export const WorkspacesFollowItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('baseline'), workspaces: z.array(WorkspaceSchema) }).passthrough(),
  z.object({ type: z.literal('upsert'), workspace: WorkspaceSchema }).passthrough(),
  z.object({ type: z.literal('removed'), id: WorkspaceIdSchema }).passthrough(),
])
export type WorkspacesFollowItem = z.infer<typeof WorkspacesFollowItemSchema>

export const WorkspacesCreateParamsSchema = z
  .object({ path: z.string().min(1), requestId: RequestIdSchema })
  .passthrough()
export const WorkspacesCreateResultSchema = z
  .object({ workspace: WorkspaceSchema, created: z.boolean() })
  .passthrough()

export const FsBrowseParamsSchema = z.object({ path: z.string().optional() }).passthrough()
export const FsBrowseResultSchema = z
  .object({
    path: z.string().nullable(),
    parent: z.string().nullable(),
    entries: z.array(
      z
        .object({ name: z.string().min(1), kind: z.enum(['dir', 'file', 'link']) })
        .passthrough(),
    ),
    truncated: z.boolean(),
  })
  .passthrough()

export const FsMkdirParamsSchema = z
  .object({
    parent: z.string().min(1),
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..', {
        message: 'must be a single path segment',
      }),
    requestId: RequestIdSchema,
  })
  .passthrough()
export const FsMkdirResultSchema = z.object({ path: z.string().min(1) }).passthrough()

export const FilesListParamsSchema = z
  .object({ sessionId: SessionIdSchema, path: z.string().min(1) })
  .passthrough()
export const FilesListResultSchema = z
  .object({
    path: z.string(),
    entries: z.array(
      z
        .object({
          name: z.string().min(1),
          kind: z.enum(['dir', 'file', 'link']),
          bytes: z.number().int().min(0).optional(),
        })
        .passthrough(),
    ),
    truncated: z.boolean(),
  })
  .passthrough()

export const FilesStatParamsSchema = z
  .object({ sessionId: SessionIdSchema, path: z.string().min(1) })
  .passthrough()
export const FilesStatResultSchema = z
  .object({
    path: z.string(),
    bytes: z.number().int().min(0).optional(),
    version: z.string(),
  })
  .passthrough()

export const FilesReadParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(400).optional(),
  })
  .passthrough()
export const FilesReadResultSchema = z
  .object({
    path: z.string(),
    version: z.string(),
    offset: z.number().int().min(1),
    text: z.string(),
    lines: z.number().int().min(0),
    eof: z.boolean(),
    bytes: z.number().int().min(0).optional(),
  })
  .passthrough()

/**
 * `files.readBytes` is not part of RCP/1 §4–§11; P7-C1 removed it from the
 * method registry. The host still registers a handler until P7-H7 deletes it,
 * so the schemas stay exported for that handler. Do not build new methods on
 * them.
 */
export const FilesReadBytesParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    path: z.string().min(1),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(32_768).optional(),
  })
  .passthrough()
export const FilesReadBytesResultSchema = z
  .object({
    path: z.string(),
    version: z.string(),
    offset: z.number().int().min(0),
    length: z.number().int().min(0),
    data: B64uDataSchema,
    total: z.number().int().min(0),
    eof: z.boolean(),
  })
  .passthrough()

/**
 * `diffs.file` (RCP/1 §9). The host currently serves the same payload shape
 * under the off-spec name `diffs.get` (`DiffsGet*` below); P7-H7 removes that
 * handler and the duplicated schemas with it.
 */
export const DiffsFileParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    path: z.string().min(1),
    fromHunk: z.number().int().min(0).optional(),
  })
  .passthrough()
export const DiffsFileResultSchema = z
  .object({
    path: z.string(),
    binary: z.boolean(),
    hunks: z.array(z.object({ header: z.string(), lines: z.array(z.string()) }).passthrough()),
    nextHunk: z.number().int().optional(),
  })
  .passthrough()

/**
 * `diffs.get` is not part of RCP/1 §4–§11; P7-C1 removed it from the method
 * registry (the spec method is `diffs.file` above). The host still registers a
 * handler until P7-H7 deletes it, so the schemas stay exported for that
 * handler. Do not build new methods on them.
 */
export const DiffsGetParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    path: z.string().min(1),
    fromHunk: z.number().int().min(0).optional(),
  })
  .passthrough()
export const DiffsGetResultSchema = z
  .object({
    path: z.string(),
    binary: z.boolean(),
    hunks: z.array(z.object({ header: z.string(), lines: z.array(z.string()) }).passthrough()),
    nextHunk: z.number().int().optional(),
  })
  .passthrough()

export const DiffsStatusParamsSchema = z.object({ sessionId: SessionIdSchema }).passthrough()
export const DiffsStatusResultSchema = z
  .object({
    source: z.enum(['git', 'session']),
    branch: z.string().optional(),
    files: z.array(
      z
        .object({
          path: z.string(),
          status: z.enum(['M', 'A', 'D', 'R', 'C', 'U', '?']),
          oldPath: z.string().optional(),
          adds: z.number().int().min(0).optional(),
          dels: z.number().int().min(0).optional(),
        })
        .passthrough(),
    ),
    truncated: z.boolean(),
  })
  .passthrough()

/**
 * `diffs.hunk` is not part of RCP/1 §4–§11; P7-C1 removed it from the method
 * registry. The host still registers a handler until P7-H7 deletes it, so the
 * schemas stay exported for that handler. Do not build new methods on them.
 */
export const DiffsHunkParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    path: z.string().min(1),
    hunk: z.number().int().min(0),
  })
  .passthrough()
export const DiffsHunkResultSchema = z
  .object({
    path: z.string(),
    hunk: z.number().int().min(0),
    header: z.string(),
    lines: z.array(z.string()),
    binary: z.boolean(),
  })
  .passthrough()

export const InteractionFollowParamsSchema = EmptyParamsSchema

export const ApprovalsAnswerParamsSchema = z
  .object({
    id: UuidSchema,
    outcome: z.enum(['allowed-once', 'rejected']),
    argsDigest: z.string().min(1),
    issuedAt: EpochMsSchema,
    sig: B64uSchema.optional(),
  })
  .passthrough()
export const ApprovalsAnswerResultSchema = z
  .object({
    accepted: z.boolean(),
    final: z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']),
    by: z.enum(['phone', 'pc', 'system']),
  })
  .passthrough()

export const QuestionsAnswerParamsSchema = z
  .object({
    id: UuidSchema,
    answers: z.array(
      z
        .object({
          id: z.string().min(1),
          selected: z.array(z.string()),
          custom: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough()
export const QuestionsAnswerResultSchema = z
  .object({ accepted: z.boolean(), by: z.enum(['phone', 'pc', 'system']) })
  .passthrough()

/** Params of `files.changes` (RCP/1 §9). */
export const FilesChangesParamsSchema = z.object({ sessionId: SessionIdSchema }).passthrough()

/** One frame of `files.changes` (RCP/1 §9). */
export const FilesChangesItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).passthrough(),
  z.object({ type: z.literal('changed'), paths: z.array(z.string()) }).passthrough(),
])
export type FilesChangesItem = z.infer<typeof FilesChangesItemSchema>

export const DevicesSelfParamsSchema = EmptyParamsSchema
export const DevicesSelfResultSchema = z
  .object({
    id: DeviceIdSchema,
    name: z.string(),
    pairedAt: EpochMsSchema,
    approvalKey: z.object({ hardwareBacked: z.boolean().nullable() }).passthrough(),
  })
  .passthrough()

export const DevicesUnpairParamsSchema = z.object({ requestId: RequestIdSchema }).passthrough()
export const DevicesUnpairResultSchema = z.object({ ok: z.literal(true) }).passthrough()

export const DevicesRotateApprovalKeyParamsSchema = z
  .object({ approvalPub: B64uSchema, requestId: RequestIdSchema })
  .passthrough()
export const DevicesRotateApprovalKeyResultSchema = z
  .object({ status: z.literal('pending_pc_confirmation') })
  .passthrough()

export const NotifyPrefsGetParamsSchema = EmptyParamsSchema
export const NotifyPrefsGetResultSchema = NotifyPrefsSchema

export const NotifyPrefsSetParamsSchema = NotifyPrefsSchema
export const NotifyPrefsSetResultSchema = NotifyPrefsSchema

export const ModelsCatalogParamsSchema = EmptyParamsSchema
export const ModelsCatalogResultSchema = z
  .object({
    providers: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string(),
          models: z.array(
            z
              .object({
                id: z.string().min(1),
                name: z.string(),
                reasoningEfforts: z.array(z.string()).optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
    default: ModelRefSchema.optional(),
  })
  .passthrough()

import type { ZodType } from 'zod'

import {
  ApprovalsAnswerParamsSchema,
  ApprovalsAnswerResultSchema,
  ControlItemSchema,
  DevicesRotateApprovalKeyParamsSchema,
  DevicesRotateApprovalKeyResultSchema,
  DevicesSelfParamsSchema,
  DevicesSelfResultSchema,
  DevicesUnpairParamsSchema,
  DevicesUnpairResultSchema,
  DiffsFileParamsSchema,
  DiffsFileResultSchema,
  DiffsStatusParamsSchema,
  DiffsStatusResultSchema,
  FilesChangesItemSchema,
  FilesChangesParamsSchema,
  FilesListParamsSchema,
  FilesListResultSchema,
  FilesReadParamsSchema,
  FilesReadResultSchema,
  FilesStatParamsSchema,
  FilesStatResultSchema,
  FollowItemSchema,
  FsBrowseParamsSchema,
  FsBrowseResultSchema,
  FsMkdirParamsSchema,
  FsMkdirResultSchema,
  HelloParamsSchema,
  HelloResultSchema,
  HostStatusParamsSchema,
  HostStatusResultSchema,
  InteractionFollowParamsSchema,
  InteractionItemSchema,
  ModelsCatalogParamsSchema,
  ModelsCatalogResultSchema,
  NotifyPrefsGetParamsSchema,
  NotifyPrefsGetResultSchema,
  NotifyPrefsSetParamsSchema,
  NotifyPrefsSetResultSchema,
  PingParamsSchema,
  PingResultSchema,
  QuestionsAnswerParamsSchema,
  QuestionsAnswerResultSchema,
  SessionsCancelParamsSchema,
  SessionsCancelResultSchema,
  SessionsControlParamsSchema,
  SessionsCreateParamsSchema,
  SessionsCreateResultSchema,
  SessionsEventTextParamsSchema,
  SessionsEventTextResultSchema,
  SessionsFollowParamsSchema,
  SessionsListParamsSchema,
  SessionsListResultSchema,
  SessionsPageParamsSchema,
  SessionsPageResultSchema,
  SessionsPromptParamsSchema,
  SessionsPromptResultSchema,
  SessionsQueueUpdateParamsSchema,
  SessionsQueueUpdateResultSchema,
  SessionsRenameParamsSchema,
  SessionsRenameResultSchema,
  SessionsSearchParamsSchema,
  SessionsSearchResultSchema,
  SessionsSelectModelParamsSchema,
  SessionsSelectModelResultSchema,
  SessionsToolOutputParamsSchema,
  SessionsToolOutputResultSchema,
  StreamOpenResultSchema,
  WorkspacesCreateParamsSchema,
  WorkspacesCreateResultSchema,
  WorkspacesFollowItemSchema,
  WorkspacesFollowParamsSchema,
  WorkspacesListParamsSchema,
  WorkspacesListResultSchema,
} from './methods.ts'

/**
 * The RCP/1 method set (spec §11): one entry per method with its shape
 * (`kind`), exactly-once classification (`mutating`), and the zod schemas the
 * boundary validates against. `satisfies` keeps the name list, the record, and
 * the array in lockstep at compile time. The list is asserted equal to the
 * spec's method tables by `test/rcp-spec-methods.test.ts` and exported as
 * `conformance/vectors/rcp/method-list.json` for the Kotlin client.
 *
 * Off-spec methods the host still registers (`sessions.get`, `diffs.get`,
 * `diffs.hunk`, `files.readBytes`) are deliberately absent; P7-H7 deletes the
 * host handlers.
 */

export const RCP_METHOD_NAMES = [
  'hello',
  'ping',
  'host.status',
  'sessions.list',
  'sessions.search',
  'sessions.follow',
  'sessions.page',
  'sessions.eventText',
  'sessions.toolOutput',
  'sessions.prompt',
  'sessions.cancel',
  'sessions.queue.update',
  'sessions.create',
  'sessions.rename',
  'sessions.selectModel',
  'sessions.control',
  'models.catalog',
  'workspaces.follow',
  'workspaces.list',
  'workspaces.create',
  'fs.browse',
  'fs.mkdir',
  'devices.self',
  'devices.unpair',
  'devices.rotateApprovalKey',
  'interaction.follow',
  'approvals.answer',
  'questions.answer',
  'files.list',
  'files.stat',
  'files.read',
  'files.changes',
  'diffs.status',
  'diffs.file',
  'notify.prefs.get',
  'notify.prefs.set',
] as const

export type RcpMethodName = (typeof RCP_METHOD_NAMES)[number]

/** Unary method: one `req` answered by exactly one `res` (RCP/1 §2). */
export interface UnaryRcpMethod {
  name: RcpMethodName
  kind: 'unary'
  mutating: boolean
  paramsSchema: ZodType
  resultSchema: ZodType
}

/** Stream method: `res` yields `{ sid }`, then `item` frames until `end`/`cancel`. */
export interface StreamRcpMethod {
  name: RcpMethodName
  kind: 'stream'
  mutating: boolean
  paramsSchema: ZodType
  resultSchema: ZodType
  itemSchema: ZodType
}

export type RcpMethod = UnaryRcpMethod | StreamRcpMethod

const methodEntries = {
  hello: {
    name: 'hello',
    kind: 'unary',
    mutating: false,
    paramsSchema: HelloParamsSchema,
    resultSchema: HelloResultSchema,
  },
  ping: {
    name: 'ping',
    kind: 'unary',
    mutating: false,
    paramsSchema: PingParamsSchema,
    resultSchema: PingResultSchema,
  },
  'host.status': {
    name: 'host.status',
    kind: 'unary',
    mutating: false,
    paramsSchema: HostStatusParamsSchema,
    resultSchema: HostStatusResultSchema,
  },
  'sessions.list': {
    name: 'sessions.list',
    kind: 'unary',
    mutating: false,
    paramsSchema: SessionsListParamsSchema,
    resultSchema: SessionsListResultSchema,
  },
  'sessions.search': {
    name: 'sessions.search',
    kind: 'unary',
    mutating: false,
    paramsSchema: SessionsSearchParamsSchema,
    resultSchema: SessionsSearchResultSchema,
  },
  'sessions.follow': {
    name: 'sessions.follow',
    kind: 'stream',
    mutating: false,
    paramsSchema: SessionsFollowParamsSchema,
    resultSchema: StreamOpenResultSchema,
    itemSchema: FollowItemSchema,
  },
  'sessions.page': {
    name: 'sessions.page',
    kind: 'unary',
    mutating: false,
    paramsSchema: SessionsPageParamsSchema,
    resultSchema: SessionsPageResultSchema,
  },
  'sessions.eventText': {
    name: 'sessions.eventText',
    kind: 'unary',
    mutating: false,
    paramsSchema: SessionsEventTextParamsSchema,
    resultSchema: SessionsEventTextResultSchema,
  },
  'sessions.toolOutput': {
    name: 'sessions.toolOutput',
    kind: 'unary',
    mutating: false,
    paramsSchema: SessionsToolOutputParamsSchema,
    resultSchema: SessionsToolOutputResultSchema,
  },
  'sessions.prompt': {
    name: 'sessions.prompt',
    kind: 'unary',
    mutating: true,
    paramsSchema: SessionsPromptParamsSchema,
    resultSchema: SessionsPromptResultSchema,
  },
  'sessions.cancel': {
    name: 'sessions.cancel',
    kind: 'unary',
    mutating: true,
    paramsSchema: SessionsCancelParamsSchema,
    resultSchema: SessionsCancelResultSchema,
  },
  'sessions.queue.update': {
    name: 'sessions.queue.update',
    kind: 'unary',
    mutating: true,
    paramsSchema: SessionsQueueUpdateParamsSchema,
    resultSchema: SessionsQueueUpdateResultSchema,
  },
  'sessions.create': {
    name: 'sessions.create',
    kind: 'unary',
    mutating: true,
    paramsSchema: SessionsCreateParamsSchema,
    resultSchema: SessionsCreateResultSchema,
  },
  'sessions.rename': {
    name: 'sessions.rename',
    kind: 'unary',
    mutating: true,
    paramsSchema: SessionsRenameParamsSchema,
    resultSchema: SessionsRenameResultSchema,
  },
  'sessions.selectModel': {
    name: 'sessions.selectModel',
    kind: 'unary',
    mutating: true,
    paramsSchema: SessionsSelectModelParamsSchema,
    resultSchema: SessionsSelectModelResultSchema,
  },
  'sessions.control': {
    name: 'sessions.control',
    kind: 'stream',
    mutating: false,
    paramsSchema: SessionsControlParamsSchema,
    resultSchema: StreamOpenResultSchema,
    itemSchema: ControlItemSchema,
  },
  'models.catalog': {
    name: 'models.catalog',
    kind: 'unary',
    mutating: false,
    paramsSchema: ModelsCatalogParamsSchema,
    resultSchema: ModelsCatalogResultSchema,
  },
  'workspaces.follow': {
    name: 'workspaces.follow',
    kind: 'stream',
    mutating: false,
    paramsSchema: WorkspacesFollowParamsSchema,
    resultSchema: StreamOpenResultSchema,
    itemSchema: WorkspacesFollowItemSchema,
  },
  'workspaces.list': {
    name: 'workspaces.list',
    kind: 'unary',
    mutating: false,
    paramsSchema: WorkspacesListParamsSchema,
    resultSchema: WorkspacesListResultSchema,
  },
  'workspaces.create': {
    name: 'workspaces.create',
    kind: 'unary',
    mutating: true,
    paramsSchema: WorkspacesCreateParamsSchema,
    resultSchema: WorkspacesCreateResultSchema,
  },
  'fs.browse': {
    name: 'fs.browse',
    kind: 'unary',
    mutating: false,
    paramsSchema: FsBrowseParamsSchema,
    resultSchema: FsBrowseResultSchema,
  },
  'fs.mkdir': {
    name: 'fs.mkdir',
    kind: 'unary',
    mutating: true,
    paramsSchema: FsMkdirParamsSchema,
    resultSchema: FsMkdirResultSchema,
  },
  'devices.self': {
    name: 'devices.self',
    kind: 'unary',
    mutating: false,
    paramsSchema: DevicesSelfParamsSchema,
    resultSchema: DevicesSelfResultSchema,
  },
  'devices.unpair': {
    name: 'devices.unpair',
    kind: 'unary',
    mutating: true,
    paramsSchema: DevicesUnpairParamsSchema,
    resultSchema: DevicesUnpairResultSchema,
  },
  'devices.rotateApprovalKey': {
    name: 'devices.rotateApprovalKey',
    kind: 'unary',
    mutating: true,
    paramsSchema: DevicesRotateApprovalKeyParamsSchema,
    resultSchema: DevicesRotateApprovalKeyResultSchema,
  },
  'interaction.follow': {
    name: 'interaction.follow',
    kind: 'stream',
    mutating: false,
    paramsSchema: InteractionFollowParamsSchema,
    resultSchema: StreamOpenResultSchema,
    itemSchema: InteractionItemSchema,
  },
  'approvals.answer': {
    name: 'approvals.answer',
    kind: 'unary',
    mutating: true,
    paramsSchema: ApprovalsAnswerParamsSchema,
    resultSchema: ApprovalsAnswerResultSchema,
  },
  'questions.answer': {
    name: 'questions.answer',
    kind: 'unary',
    mutating: true,
    paramsSchema: QuestionsAnswerParamsSchema,
    resultSchema: QuestionsAnswerResultSchema,
  },
  'files.list': {
    name: 'files.list',
    kind: 'unary',
    mutating: false,
    paramsSchema: FilesListParamsSchema,
    resultSchema: FilesListResultSchema,
  },
  'files.stat': {
    name: 'files.stat',
    kind: 'unary',
    mutating: false,
    paramsSchema: FilesStatParamsSchema,
    resultSchema: FilesStatResultSchema,
  },
  'files.read': {
    name: 'files.read',
    kind: 'unary',
    mutating: false,
    paramsSchema: FilesReadParamsSchema,
    resultSchema: FilesReadResultSchema,
  },
  'files.changes': {
    name: 'files.changes',
    kind: 'stream',
    mutating: false,
    paramsSchema: FilesChangesParamsSchema,
    resultSchema: StreamOpenResultSchema,
    itemSchema: FilesChangesItemSchema,
  },
  'diffs.status': {
    name: 'diffs.status',
    kind: 'unary',
    mutating: false,
    paramsSchema: DiffsStatusParamsSchema,
    resultSchema: DiffsStatusResultSchema,
  },
  'diffs.file': {
    name: 'diffs.file',
    kind: 'unary',
    mutating: false,
    paramsSchema: DiffsFileParamsSchema,
    resultSchema: DiffsFileResultSchema,
  },
  'notify.prefs.get': {
    name: 'notify.prefs.get',
    kind: 'unary',
    mutating: false,
    paramsSchema: NotifyPrefsGetParamsSchema,
    resultSchema: NotifyPrefsGetResultSchema,
  },
  'notify.prefs.set': {
    name: 'notify.prefs.set',
    kind: 'unary',
    mutating: true,
    paramsSchema: NotifyPrefsSetParamsSchema,
    resultSchema: NotifyPrefsSetResultSchema,
  },
} satisfies Record<RcpMethodName, RcpMethod>

/** Methods keyed by name; every `RCP_METHOD_NAMES` entry has an entry here. */
export const RCP_METHODS_BY_NAME: Readonly<Record<RcpMethodName, RcpMethod>> =
  Object.freeze(methodEntries)

/** All RCP/1 methods in spec order. */
export const RCP_METHODS: readonly RcpMethod[] = RCP_METHOD_NAMES.map(
  (name) => methodEntries[name],
)

/** Looks up a method by wire name; `undefined` for unknown methods. */
export function getRcpMethod(name: string): RcpMethod | undefined {
  return Object.hasOwn(methodEntries, name)
    ? methodEntries[name as RcpMethodName]
    : undefined
}

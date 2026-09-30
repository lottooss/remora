/**
 * Gateway adapter (docs/specs/rcp-v1.md §5, blueprint §8.4):
 * Typed wrappers over dsh in-process `ctx.typertGateway` for unary and stream
 * methods in the `session` namespace, with error code mapping.
 */
import {
  RCP_ERROR_CODES,
  createRcpError,
  type RcpError,
} from '@remora/protocol'
import { RcpMethodError } from '../rcp/index.ts'

export interface InvokeRemoteRequest {
  namespace: string
  method: string
  args: Record<string, unknown>
  signal?: AbortSignal | undefined
}

export interface TypertGateway {
  invoke(request: InvokeRemoteRequest): Promise<unknown>
  stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>
}

/** Mapping of upstream dsh RemoteError codes to RCP error codes. */
export const DSH_ERROR_CODE_MAP: Readonly<Record<string, string>> = Object.freeze({
  'session/not-found': RCP_ERROR_CODES.not_found,
  'session/conflict': RCP_ERROR_CODES.conflict,
  'session/agent-busy': 'busy',
  'session/model-unavailable': 'unavailable',
  'session/queue-item-not-found': RCP_ERROR_CODES.not_found,
  'session/steer-unavailable': RCP_ERROR_CODES.conflict,
  'session/attachment-invalid': RCP_ERROR_CODES.invalid_params,
  'session/title-invalid': RCP_ERROR_CODES.invalid_params,
  'session/fork-unavailable': RCP_ERROR_CODES.conflict,
  'session/invalid-time-zone': RCP_ERROR_CODES.invalid_params,
  'session/workspace-attach-failed': RCP_ERROR_CODES.conflict,
  'workspace/invalid-path': RCP_ERROR_CODES.invalid_params,
  'workspace/name-conflict': RCP_ERROR_CODES.conflict,
  'directory-picker/unavailable': RCP_ERROR_CODES.internal_error,
  'directory-picker/unreadable': RCP_ERROR_CODES.forbidden,
  'directory-picker/exists': RCP_ERROR_CODES.conflict,
  'directory-picker/create-failed': RCP_ERROR_CODES.internal_error,
  'workspace-file/not-found': RCP_ERROR_CODES.not_found,
  'workspace-file/outside-workspace': RCP_ERROR_CODES.forbidden,
  'workspace-file/too-large': RCP_ERROR_CODES.too_large,
  'workspace-file/not-text': RCP_ERROR_CODES.invalid_params,
  'workspace-file/not-regular-file': RCP_ERROR_CODES.invalid_params,
  'workspace-file/not-directory': RCP_ERROR_CODES.invalid_params,
  'gateway/cancelled': RCP_ERROR_CODES.cancelled,
  'gateway/not-found': RCP_ERROR_CODES.method_not_found,
  'gateway/signature-invalid': RCP_ERROR_CODES.invalid_params,
  'gateway/endpoint-unknown': RCP_ERROR_CODES.method_not_found,
})

/** Reads the `code` property of an upstream dsh error, if it is a string. */
function upstreamErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Maps any upstream dsh error or RemoteError to a client-safe RcpError
 * with the original code in `details.dsh` (RCP/1 §3).
 */
export function mapDshErrorToRcp(err: unknown): RcpError {
  if (err instanceof RcpMethodError) {
    return err.rcpError
  }

  const dshCode = upstreamErrorCode(err)

  if (dshCode && Object.hasOwn(DSH_ERROR_CODE_MAP, dshCode)) {
    const rcpCode = DSH_ERROR_CODE_MAP[dshCode]!
    const msg = typeof (err as { message?: unknown })?.message === 'string'
      ? (err as { message: string }).message
      : `dsh operation failed (${dshCode})`
    return createRcpError(rcpCode, msg, { dsh: dshCode })
  }

  // Check for cancellation
  if ((err as { name?: unknown })?.name === 'AbortError' || (err as { code?: unknown })?.code === 'ABORT_ERR') {
    return createRcpError(RCP_ERROR_CODES.cancelled, 'operation cancelled')
  }

  return createRcpError(RCP_ERROR_CODES.internal_error, 'internal gateway error', {
    dsh: dshCode ?? 'unknown',
  })
}

/** Wraps an async call with dsh error translation to RcpMethodError. */
export async function withGatewayError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err: unknown) {
    throw new RcpMethodError(mapDshErrorToRcp(err))
  }
}

// ---------------------------------------------------------------------------
// Startup-race retry (docs/tasks/P7-H9.md)
// ---------------------------------------------------------------------------

/** The only upstream error code worth retrying: dsh services start asynchronously. */
export const GATEWAY_SERVICE_UNAVAILABLE_CODE = 'gateway/service-unavailable'

export const DEFAULT_GATEWAY_RETRY_DEADLINE_MS = 30_000

export const DEFAULT_GATEWAY_RETRY_INTERVAL_MS = 250

export interface RetryingGatewayOptions {
  /** Wall-clock budget for retrying, counted from the first attempt. Default 30 000 ms. */
  retryDeadlineMs?: number | undefined
  /** Delay between two attempts. Default 250 ms. */
  retryIntervalMs?: number | undefined
  /** Time source in milliseconds. Injected for deterministic tests; default `Date.now`. */
  clock?: (() => number) | undefined
  /**
   * Wait between attempts; rejects as soon as `signal` aborts. Injected for
   * deterministic tests; default a timer-based wait.
   */
  sleep?: ((ms: number, signal: AbortSignal | undefined) => Promise<void>) | undefined
}

/**
 * Default retry wait: resolves after `ms`, or rejects as soon as `signal`
 * aborts. The rejection carries the signal's abort reason (Node's default is
 * an `AbortError` DOMException), which `mapDshErrorToRcp` maps to the RCP
 * `cancelled` code.
 */
function sleepUntil(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    })
  }
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Wraps the raw dsh `ctx.typertGateway` so that `invoke` and `stream` survive
 * the dsh startup race: until dsh finishes starting, the first gateway calls
 * reject with `code === 'gateway/service-unavailable'` (recorded in
 * `test/fixtures/dsh-0.1.5-rc.3/report.json`; the working retry pattern comes
 * from `spikes/p0-s1-dsh-adapter/src/index.js`, `invokeReady`). Only that exact
 * code is retried — every 250 ms until the deadline (default 30 s, set per
 * instance via {@link RetryingGatewayOptions.retryDeadlineMs}) — and the
 * caller's AbortSignal stops the retries immediately; every other error
 * propagates on the first occurrence with the original error object. The
 * request object reaches dsh untouched, so `signal` passthrough still lets dsh
 * cancel the in-flight call itself.
 */
export class RetryingGateway implements TypertGateway {
  readonly #inner: TypertGateway
  readonly #retryDeadlineMs: number
  readonly #retryIntervalMs: number
  readonly #clock: () => number
  readonly #sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>

  constructor(inner: TypertGateway, options: RetryingGatewayOptions = {}) {
    this.#inner = inner
    this.#retryDeadlineMs = options.retryDeadlineMs ?? DEFAULT_GATEWAY_RETRY_DEADLINE_MS
    this.#retryIntervalMs = options.retryIntervalMs ?? DEFAULT_GATEWAY_RETRY_INTERVAL_MS
    this.#clock = options.clock ?? Date.now
    this.#sleep = options.sleep ?? sleepUntil
    // Fail closed on misconfiguration instead of retrying forever or never.
    if (!Number.isFinite(this.#retryDeadlineMs) || this.#retryDeadlineMs < 0) {
      throw new TypeError(
        `retryDeadlineMs must be a finite non-negative number, got ${String(this.#retryDeadlineMs)}`,
      )
    }
    if (!Number.isFinite(this.#retryIntervalMs) || this.#retryIntervalMs < 0) {
      throw new TypeError(
        `retryIntervalMs must be a finite non-negative number, got ${String(this.#retryIntervalMs)}`,
      )
    }
  }

  invoke(request: InvokeRemoteRequest): Promise<unknown> {
    return this.#callWithRetry((req) => this.#inner.invoke(req), request)
  }

  stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown> {
    // Retries cover opening the stream; errors raised while iterating an
    // already-established stream are the stream consumer's concern.
    return this.#callWithRetry((req) => this.#inner.stream(req), request)
  }

  async #callWithRetry<T>(
    call: (request: InvokeRemoteRequest) => T | Promise<T>,
    request: InvokeRemoteRequest,
  ): Promise<T> {
    const signal = request.signal
    const deadlineAt = this.#clock() + this.#retryDeadlineMs
    for (;;) {
      signal?.throwIfAborted()
      try {
        return await call(request)
      } catch (err: unknown) {
        if (upstreamErrorCode(err) !== GATEWAY_SERVICE_UNAVAILABLE_CODE) {
          throw err
        }
        // The caller's abort wins over both the retry and the deadline, and the
        // deadline gives up with the original error, never a synthetic timeout.
        signal?.throwIfAborted()
        if (this.#clock() >= deadlineAt) {
          throw err
        }
        await this.#sleep(this.#retryIntervalMs, signal)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Typed method wrappers for Session Controller
// ---------------------------------------------------------------------------

export async function gatewaySessionList(
  gateway: TypertGateway,
  args?: { cursor?: string | undefined },
  signal?: AbortSignal,
): Promise<{ items: unknown[] }> {
  return withGatewayError(async () => {
    const res = await gateway.invoke({
      namespace: 'session',
      method: 'list',
      args: args?.cursor !== undefined ? { cursor: args.cursor } : {},
      ...(signal !== undefined ? { signal } : {}),
    })
    const data = res as { items?: unknown[] } | undefined
    return { items: data?.items ?? [] }
  })
}

export async function gatewaySessionSearch(
  gateway: TypertGateway,
  query: string,
  signal?: AbortSignal,
): Promise<{ items: unknown[]; hasMore?: boolean }> {
  return withGatewayError(async () => {
    const res = await gateway.invoke({
      namespace: 'session',
      method: 'search',
      args: { query },
      ...(signal !== undefined ? { signal } : {}),
    })
    const data = res as { items?: unknown[]; hasMore?: boolean } | undefined
    return {
      items: data?.items ?? [],
      ...(data?.hasMore !== undefined ? { hasMore: data.hasMore } : {}),
    }
  })
}

export async function gatewaySessionCreate(
  gateway: TypertGateway,
  args: { workspaceId?: string | undefined; cwd?: string | undefined; sessionId?: string | undefined; agentPreset?: string | undefined },
  signal?: AbortSignal,
): Promise<{ sessionId: string; agentPreset?: string }> {
  return withGatewayError(async () => {
    const payload: Record<string, unknown> = {}
    if (args.workspaceId !== undefined) payload['workspaceId'] = args.workspaceId
    if (args.cwd !== undefined) payload['cwd'] = args.cwd
    if (args.sessionId !== undefined) payload['sessionId'] = args.sessionId
    if (args.agentPreset !== undefined) payload['agentPreset'] = args.agentPreset
    const res = await gateway.invoke({
      namespace: 'session',
      method: 'create',
      args: payload,
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as { sessionId: string; agentPreset?: string }
  })
}

export async function gatewaySessionSelectModel(
  gateway: TypertGateway,
  args: { sessionId: string; provider: string; model: string; reasoningEffort?: string | undefined },
  signal?: AbortSignal,
): Promise<{ selected: { provider: string; model: string; reasoningEffort?: string } }> {
  return withGatewayError(async () => {
    const payload: Record<string, unknown> = {
      sessionId: args.sessionId,
      provider: args.provider,
      model: args.model,
    }
    if (args.reasoningEffort !== undefined) payload['reasoningEffort'] = args.reasoningEffort
    const res = await gateway.invoke({
      namespace: 'session',
      method: 'selectModel',
      args: payload,
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as { selected: { provider: string; model: string; reasoningEffort?: string } }
  })
}

export async function gatewaySessionRename(
  gateway: TypertGateway,
  args: { sessionId: string; title: string },
  signal?: AbortSignal,
): Promise<{ title: string; seq: number }> {
  return withGatewayError(async () => {
    const res = await gateway.invoke({
      namespace: 'session',
      method: 'rename',
      args: { sessionId: args.sessionId, title: args.title },
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as { title: string; seq: number }
  })
}

export async function gatewaySessionPrompt(
  gateway: TypertGateway,
  args: {
    sessionId: string
    requestId: string
    mode: 'queue' | 'steer'
    content: Array<{ type: 'text'; text: string }>
    clientTimeZone?: string | undefined
  },
  signal?: AbortSignal,
): Promise<{ accepted: true }> {
  return withGatewayError(async () => {
    const payload: Record<string, unknown> = {
      address: { kind: 'session', sessionId: args.sessionId },
      requestId: args.requestId,
      mode: args.mode,
      content: args.content,
    }
    if (args.clientTimeZone !== undefined) payload['clientTimeZone'] = args.clientTimeZone
    const res = await gateway.invoke({
      namespace: 'session',
      method: 'prompt',
      args: payload,
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as { accepted: true }
  })
}

export async function gatewaySessionCancel(
  gateway: TypertGateway,
  args: { sessionId: string },
  signal?: AbortSignal,
): Promise<{ accepted: true }> {
  return withGatewayError(async () => {
    const res = await gateway.invoke({
      namespace: 'session',
      method: 'cancel',
      args: { address: { kind: 'session', sessionId: args.sessionId } },
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as { accepted: true }
  })
}

export async function gatewaySessionUpdateQueue(
  gateway: TypertGateway,
  args: {
    sessionId: string
    itemId: string
    action: { kind: 'edit' | 'remove' | 'steer'; content?: Array<{ type: 'text'; text: string }> | undefined }
  },
  signal?: AbortSignal,
): Promise<{ accepted: true }> {
  return withGatewayError(async () => {
    const res = await gateway.invoke({
      namespace: 'session',
      method: 'updateQueue',
      args: {
        address: { kind: 'session', sessionId: args.sessionId },
        itemId: args.itemId,
        action: args.action,
      },
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as { accepted: true }
  })
}

export async function gatewaySessionPage(
  gateway: TypertGateway,
  args: {
    sessionId: string
    throughSeq: number
    beforeSeq?: number | undefined
    maxMessages?: number | undefined
  },
  signal?: AbortSignal,
): Promise<{ records: unknown[]; hasMore: boolean }> {
  return withGatewayError(async () => {
    const payload: Record<string, unknown> = {
      address: { kind: 'session', sessionId: args.sessionId },
      throughSeq: args.throughSeq,
    }
    if (args.beforeSeq !== undefined) payload['beforeSeq'] = args.beforeSeq
    if (args.maxMessages !== undefined) payload['maxMessages'] = args.maxMessages
    const res = await gateway.invoke({
      namespace: 'session',
      method: 'page',
      args: payload,
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as { records: unknown[]; hasMore: boolean }
  })
}

export async function gatewayModelCatalog(
  gateway: TypertGateway,
  signal?: AbortSignal,
): Promise<unknown> {
  return withGatewayError(async () => {
    return await gateway.invoke({
      namespace: 'session',
      method: 'modelCatalog',
      args: {},
      ...(signal !== undefined ? { signal } : {}),
    })
  })
}

export async function gatewaySessionFollow(
  gateway: TypertGateway,
  args: { sessionId: string; maxMessages?: number | undefined; assistantStream?: true | undefined },
  signal?: AbortSignal,
): Promise<AsyncIterable<unknown>> {
  return withGatewayError(async () => {
    const payload: Record<string, unknown> = {
      address: { kind: 'session', sessionId: args.sessionId },
    }
    if (args.maxMessages !== undefined) payload['maxMessages'] = args.maxMessages
    if (args.assistantStream !== undefined) payload['assistantStream'] = args.assistantStream
    return await gateway.stream({
      namespace: 'session',
      method: 'follow',
      args: payload,
      ...(signal !== undefined ? { signal } : {}),
    })
  })
}

export async function gatewaySessionControl(
  gateway: TypertGateway,
  signal?: AbortSignal,
): Promise<AsyncIterable<unknown>> {
  return withGatewayError(async () => {
    return await gateway.stream({
      namespace: 'session',
      method: 'control',
      args: {},
      ...(signal !== undefined ? { signal } : {}),
    })
  })
}

export async function gatewayWorkspaceFollow(
  gateway: TypertGateway,
  signal?: AbortSignal,
): Promise<AsyncIterable<unknown>> {
  return withGatewayError(async () => {
    return await gateway.stream({
      namespace: 'workspace',
      method: 'follow',
      args: {},
      ...(signal !== undefined ? { signal } : {}),
    })
  })
}

export async function gatewayWorkspaceCreate(
  gateway: TypertGateway,
  args: { path: string },
  signal?: AbortSignal,
): Promise<{ workspace: { workspaceId: string; title: string; path: string }; created: boolean }> {
  return withGatewayError(async () => {
    const res = await gateway.invoke({
      namespace: 'workspace',
      method: 'create',
      args: { path: args.path },
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as { workspace: { workspaceId: string; title: string; path: string }; created: boolean }
  })
}

export async function gatewayDirectoryPickerList(
  gateway: TypertGateway,
  args: { path?: string | undefined },
  signal?: AbortSignal,
): Promise<{
  path: string
  crumbs: { name: string; path: string }[]
  entries: { name: string; path: string; hidden: boolean }[]
  truncated: boolean
}> {
  return withGatewayError(async () => {
    const payload: Record<string, unknown> = {}
    if (args.path !== undefined) payload['path'] = args.path
    const res = await gateway.invoke({
      namespace: 'directoryPicker',
      method: 'list',
      args: payload,
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as {
      path: string
      crumbs: { name: string; path: string }[]
      entries: { name: string; path: string; hidden: boolean }[]
      truncated: boolean
    }
  })
}

export async function gatewayDirectoryPickerCreateDirectory(
  gateway: TypertGateway,
  args: { path: string; name: string },
  signal?: AbortSignal,
): Promise<string> {
  return withGatewayError(async () => {
    const res = await gateway.invoke({
      namespace: 'directoryPicker',
      method: 'createDirectory',
      args: { path: args.path, name: args.name },
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as string
  })
}

export async function gatewayWorkspaceFilesRead(
  gateway: TypertGateway,
  args: { sessionId: string; path: string; range?: { offset?: number; limit?: number } },
  signal?: AbortSignal,
): Promise<{
  absolutePath: string
  version: string
  offset: number
  text: string
  lines: number
  eof: boolean
  bytes?: number
}> {
  return withGatewayError(async () => {
    const payload: Record<string, unknown> = {
      workspaceFileScopeId: args.sessionId,
      path: args.path,
    }
    if (args.range !== undefined) payload['range'] = args.range
    const res = await gateway.invoke({
      namespace: 'workspaceFiles',
      method: 'read',
      args: payload,
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as {
      absolutePath: string
      version: string
      offset: number
      text: string
      lines: number
      eof: boolean
      bytes?: number
    }
  })
}

export async function gatewayWorkspaceFilesReadBytes(
  gateway: TypertGateway,
  args: { sessionId: string; path: string; range?: { offset?: number; length?: number } },
  signal?: AbortSignal,
): Promise<{
  absolutePath: string
  version: string
  offset: number
  data: string
  eof: boolean
  bytes?: number
}> {
  return withGatewayError(async () => {
    const payload: Record<string, unknown> = {
      workspaceFileScopeId: args.sessionId,
      path: args.path,
    }
    if (args.range !== undefined) payload['range'] = args.range
    const res = await gateway.invoke({
      namespace: 'workspaceFiles',
      method: 'readBytes',
      args: payload,
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as {
      absolutePath: string
      version: string
      offset: number
      data: string
      eof: boolean
      bytes?: number
    }
  })
}

export async function gatewayWorkspaceFilesStat(
  gateway: TypertGateway,
  args: { sessionId: string; path: string },
  signal?: AbortSignal,
): Promise<{
  absolutePath: string
  version: string
  bytes?: number
}> {
  return withGatewayError(async () => {
    const res = await gateway.invoke({
      namespace: 'workspaceFiles',
      method: 'stat',
      args: {
        workspaceFileScopeId: args.sessionId,
        path: args.path,
      },
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as {
      absolutePath: string
      version: string
      bytes?: number
    }
  })
}

export async function gatewayWorkspaceFilesList(
  gateway: TypertGateway,
  args: { sessionId: string; path: string },
  signal?: AbortSignal,
): Promise<{
  path: string
  entries: { name: string; type: 'file' | 'directory' | 'other'; size?: number }[]
  truncated: boolean
}> {
  return withGatewayError(async () => {
    const res = await gateway.invoke({
      namespace: 'workspaceFiles',
      method: 'list',
      args: {
        workspaceFileScopeId: args.sessionId,
        path: args.path,
      },
      ...(signal !== undefined ? { signal } : {}),
    })
    return res as {
      path: string
      entries: { name: string; type: 'file' | 'directory' | 'other'; size?: number }[]
      truncated: boolean
    }
  })
}

export async function gatewayWorkspaceFilesChanges(
  gateway: TypertGateway,
  args: { sessionId: string },
  signal?: AbortSignal,
): Promise<AsyncIterable<unknown>> {
  return withGatewayError(async () => {
    return await gateway.stream({
      namespace: 'workspaceFiles',
      method: 'changes',
      args: {
        workspaceFileScopeId: args.sessionId,
      },
      ...(signal !== undefined ? { signal } : {}),
    })
  })
}


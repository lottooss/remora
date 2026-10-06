/**
 * Session adapter (docs/specs/rcp-v1.md §5, blueprint §8.4–§8.5):
 * Implements session operations over the dsh TypertGateway:
 * - list, search, follow, page, eventText, toolOutput
 * - prompt, cancel, queue.update, rename, selectModel, control, models.catalog
 * Handles snapshot packing <= 48 KiB, afterSeq resume/reset, deduplication cache,
 * and lifecycle cleanup.
 */
import path from 'node:path'
import {
  RCP_ERROR_CODES,
  createRcpError,
  type ModelRef,
  type SessionEvent,
  type SessionSummary,
} from '@remora/protocol'
import { RcpMethodError, type RcpStreamSink } from '../rcp/index.ts'
import { mapDshEventToRcp, type DshWireEvent } from './event-map.ts'

function getEventSeq(event: SessionEvent): number {
  return typeof (event as { seq?: unknown }).seq === 'number'
    ? (event as { seq: number }).seq
    : 0
}
import {
  gatewayModelCatalog,
  gatewaySessionCancel,
  gatewaySessionCreate,
  gatewaySessionFollow,
  gatewaySessionList,
  gatewaySessionPage,
  gatewaySessionPrompt,
  gatewaySessionRename,
  gatewaySessionSearch,
  gatewaySessionSelectModel,
  gatewaySessionUpdateQueue,
  type TypertGateway,
} from './gateway.ts'
import { LiveCoalescer } from './live.ts'
import { openSessionControl, type SessionActivitySource } from './session-control.ts'
import type { PolicyGuard } from '../policy/index.ts'
import type { WorkspaceAdapter } from './workspaces.ts'

/** Target max serialized byte budget for a snapshot FollowItem frame (40 KiB). */
const SNAPSHOT_BUDGET_BYTES = 40_000

/** Deduplication cache entry for prompt requests. */
interface PromptDedupeEntry {
  accepted: true
  time: number
}

export interface SessionAdapterOptions {
  gateway: TypertGateway
  streamCoalesceMs?: number
  now?: () => number
  policyGuard?: PolicyGuard | undefined
  workspaceAdapter?: WorkspaceAdapter | undefined
  activity?: SessionActivitySource | undefined
}

export class SessionAdapter {
  private readonly gateway: TypertGateway
  private readonly coalesceMs: number
  private readonly now: () => number
  private readonly policyGuard?: PolicyGuard | undefined
  private readonly workspaceAdapter?: WorkspaceAdapter | undefined
  private readonly activity?: SessionActivitySource | undefined
  private readonly promptDedupeCache = new Map<string, PromptDedupeEntry>()
  private readonly sessionCreateDedupeCache = new Map<string, { result: { sessionId: string; workspaceId: string }; time: number }>()
  /** Cache of text events by sessionId:seq for eventText reads. */
  private readonly eventTextCache = new Map<string, string>()
  /** Cache of tool output by sessionId:callId for toolOutput reads. */
  private readonly toolOutputCache = new Map<string, string>()

  constructor(options: SessionAdapterOptions) {
    this.gateway = options.gateway
    this.coalesceMs = options.streamCoalesceMs ?? 50
    this.now = options.now ?? Date.now
    this.policyGuard = options.policyGuard
    this.workspaceAdapter = options.workspaceAdapter
    this.activity = options.activity
  }

  /**
   * sessions.list (RCP/1 §5)
   */
  async list(params?: {
    cursor?: string | undefined
    limit?: number | undefined
    includeArchived?: boolean | undefined
  }): Promise<{ items: SessionSummary[]; next?: string }> {
    const raw = await gatewaySessionList(this.gateway, {
      cursor: params?.cursor,
    })

    const limit = Math.min(100, Math.max(1, params?.limit ?? 50))
    const rawItems = raw.items ?? []
    const summaries: SessionSummary[] = []

    for (const item of rawItems) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      const id = typeof rec['sessionId'] === 'string' ? rec['sessionId'] : ''
      if (!id) continue

      const archived = rec['archived'] === true
      if (archived && !params?.includeArchived) continue

      summaries.push(this.mapToSessionSummary(rec))
      if (summaries.length >= limit) break
    }

    const next = summaries.length >= limit && rawItems.length > limit
      ? summaries[summaries.length - 1]?.id
      : undefined

    return {
      items: summaries,
      ...(next !== undefined ? { next } : {}),
    }
  }

  /**
   * sessions.search (RCP/1 §5)
   */
  async search(params: { query: string }): Promise<{
    results: Array<{ sessionId: string; title: string | null; snippet: string; at: number }>
  }> {
    const raw = await gatewaySessionSearch(this.gateway, params.query)
    const items = raw.items ?? []
    const results: Array<{ sessionId: string; title: string | null; snippet: string; at: number }> = []

    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      const sessionId = typeof rec['sessionId'] === 'string' ? rec['sessionId'] : ''
      const snippet = typeof rec['snippet'] === 'string' ? rec['snippet'] : ''
      const title = typeof rec['title'] === 'string' ? rec['title'] : null
      const at = typeof rec['at'] === 'number' ? rec['at'] : this.now()
      if (sessionId) {
        results.push({ sessionId, title, snippet, at })
      }
    }

    return { results }
  }

  /**
   * sessions.follow (RCP/1 §5)
   * Streams opening snapshot, followed by contiguous events and live assistant frames.
   */
  async follow(
    params: { sessionId: string; afterSeq?: number | undefined; live?: boolean | undefined },
    sink: RcpStreamSink,
  ): Promise<Record<string, unknown>> {
    const streamIterable = await gatewaySessionFollow(
      this.gateway,
      {
        sessionId: params.sessionId,
        assistantStream: params.live !== false ? true : undefined,
      },
      sink.signal,
    )

    // Run the pump loop in background, returning immediately to open the stream
    void this.pumpFollowStream(params, sink, streamIterable)

    return {}
  }

  private async pumpFollowStream(
    params: { sessionId: string; afterSeq?: number | undefined; live?: boolean | undefined },
    sink: RcpStreamSink,
    streamIterable: AsyncIterable<unknown>,
  ): Promise<void> {
    const coalescer = new LiveCoalescer({
      streamCoalesceMs: this.coalesceMs,
      emit: async (item) => {
        if (sink.signal.aborted) return false
        return await sink.sendItem(item as unknown as Record<string, unknown>)
      },
    })

    let initialSnapshotProcessed = false
    let highestDeliveredSeq = params.afterSeq ?? -1

    try {
      for await (const rawFrame of streamIterable) {
        if (sink.signal.aborted) break
        if (typeof rawFrame !== 'object' || rawFrame === null) continue
        const frame = rawFrame as Record<string, unknown>
        const frameType = frame['type']

        if (frameType === 'snapshot' && !initialSnapshotProcessed) {
          initialSnapshotProcessed = true
          await this.handleInitialSnapshot(params, sink, frame)
          continue
        }

        if (frameType === 'event') {
          const wireEvent = frame['event'] as DshWireEvent | undefined
          if (!wireEvent) continue
          const mapped = mapDshEventToRcp(wireEvent)
          if (mapped) {
            this.cacheEventData(params.sessionId, mapped)
            const seq = getEventSeq(mapped)
            if (seq > highestDeliveredSeq) {
              highestDeliveredSeq = seq
              await sink.sendItem({
                type: 'events',
                events: [mapped],
              })
            }
          }
          continue
        }

        if (frameType === 'assistant-stream' && params.live !== false) {
          const streamFrame = frame['frame']
          if (streamFrame) {
            await coalescer.handleFrame(streamFrame)
          }
        }
      }
    } catch {
      // Cancellation or disconnect cleanly stops the pump
    } finally {
      coalescer.dispose()
      if (!sink.signal.aborted) {
        await sink.end(true)
      }
    }
  }

  private async handleInitialSnapshot(
    params: { sessionId: string; afterSeq?: number | undefined },
    sink: RcpStreamSink,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const rawHeader = frame['header'] as Record<string, unknown> | undefined
    const summary = this.mapToSessionSummary({
      sessionId: params.sessionId,
      ...rawHeader,
      projections: frame['projections'],
    })

    const rawRecords = Array.isArray(frame['records']) ? frame['records'] : []
    const allEvents: SessionEvent[] = []

    for (const rec of rawRecords) {
      if (typeof rec === 'object' && rec !== null && rec['type'] === 'event') {
        const wire = rec['event'] as DshWireEvent | undefined
        if (wire) {
          const mapped = mapDshEventToRcp(wire)
          if (mapped) {
            this.cacheEventData(params.sessionId, mapped)
            allEvents.push(mapped)
          }
        }
      }
    }

    allEvents.sort((a, b) => getEventSeq(a) - getEventSeq(b))

    // Case 1: No afterSeq -> send initial snapshot
    if (params.afterSeq === undefined) {
      const { packedEvents, hasOlder } = this.packEventsForSnapshot(allEvents, frame['hasMore'] === true)
      await sink.sendItem({
        type: 'snapshot',
        session: summary,
        events: packedEvents,
        hasOlder,
      })
      return
    }

    // Case 2: Resume with afterSeq
    const requestedSeq = params.afterSeq
    const firstSeq = allEvents[0] ? getEventSeq(allEvents[0]) : 0
    const lastSeq = allEvents.length > 0 ? getEventSeq(allEvents[allEvents.length - 1]!) : -1

    // If contiguous (requestedSeq is within our records window)
    if (requestedSeq >= firstSeq - 1 && requestedSeq <= lastSeq) {
      const newEvents = allEvents.filter((e) => getEventSeq(e) > requestedSeq)
      if (newEvents.length > 0) {
        await sink.sendItem({
          type: 'events',
          events: newEvents,
        })
      }
      return
    }

    // Gap detected or requestedSeq unavailable -> reset then snapshot
    await sink.sendItem({
      type: 'reset',
      reason: 'cursor_unavailable',
    })

    const { packedEvents, hasOlder } = this.packEventsForSnapshot(allEvents, frame['hasMore'] === true)
    await sink.sendItem({
      type: 'snapshot',
      session: summary,
      events: packedEvents,
      hasOlder,
    })
  }

  /**
   * Packs the newest events that fit within the snapshot budget <= 48 KiB.
   */
  private packEventsForSnapshot(
    allEvents: SessionEvent[],
    gatewayHasOlder: boolean,
  ): { packedEvents: SessionEvent[]; hasOlder: boolean } {
    if (allEvents.length === 0) {
      return { packedEvents: [], hasOlder: gatewayHasOlder }
    }

    const packed: SessionEvent[] = []
    let currentBytes = 200 // base overhead

    // Iterate backwards from newest
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const evt = allEvents[i]!
      const evtBytes = new TextEncoder().encode(JSON.stringify(evt)).length
      if (currentBytes + evtBytes > SNAPSHOT_BUDGET_BYTES) {
        break
      }
      currentBytes += evtBytes
      packed.unshift(evt)
    }

    const hasOlder = gatewayHasOlder || packed.length < allEvents.length
    return { packedEvents: packed, hasOlder }
  }

  /**
   * sessions.page (RCP/1 §5)
   */
  async page(params: {
    sessionId: string
    beforeSeq: number
    limit?: number | undefined
  }): Promise<{ events: SessionEvent[]; hasOlder: boolean }> {
    const raw = await gatewaySessionPage(this.gateway, {
      sessionId: params.sessionId,
      throughSeq: params.beforeSeq,
      beforeSeq: params.beforeSeq,
      maxMessages: params.limit ?? 50,
    })

    const records = raw.records ?? []
    const events: SessionEvent[] = []

    for (const rec of records) {
      if (typeof rec === 'object' && rec !== null) {
        const r = rec as Record<string, unknown>
        if (r['type'] === 'event' && r['event']) {
          const mapped = mapDshEventToRcp(r['event'] as DshWireEvent)
          if (mapped) {
            this.cacheEventData(params.sessionId, mapped)
            events.push(mapped)
          }
        }
      }
    }

    events.sort((a, b) => getEventSeq(a) - getEventSeq(b))
    return {
      events,
      hasOlder: raw.hasMore ?? false,
    }
  }

  /**
   * sessions.eventText (RCP/1 §5)
   */
  async eventText(params: {
    sessionId: string
    seq: number
    offset: number
    limit?: number | undefined
  }): Promise<{ text: string; offset: number; eof: boolean }> {
    const key = `${params.sessionId}:${params.seq}`
    let fullText = this.eventTextCache.get(key)

    if (fullText === undefined) {
      // Retrieve page containing this event
      const p = await this.page({
        sessionId: params.sessionId,
        beforeSeq: params.seq + 1,
        limit: 10,
      })
      const found = p.events.find((e) => e.seq === params.seq)
      if (found && found.kind === 'assistant.message') {
        fullText = found.text
        this.eventTextCache.set(key, fullText)
      } else {
        throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.not_found, 'event text not found'))
      }
    }

    const encoder = new TextEncoder()
    const fullBytes = encoder.encode(fullText)
    const offset = Math.max(0, params.offset)
    const limit = Math.min(32768, Math.max(1, params.limit ?? 32768))

    const sliceBytes = fullBytes.subarray(offset, offset + limit)
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const text = decoder.decode(sliceBytes)
    const eof = offset + sliceBytes.length >= fullBytes.length

    return { text, offset, eof }
  }

  /**
   * sessions.toolOutput (RCP/1 §5)
   */
  async toolOutput(params: {
    sessionId: string
    callId: string
    offset: number
    limit?: number | undefined
  }): Promise<{ text: string; offset: number; total: number; eof: boolean }> {
    const key = `${params.sessionId}:${params.callId}`
    const fullText = this.toolOutputCache.get(key) ?? ''

    const encoder = new TextEncoder()
    const fullBytes = encoder.encode(fullText)
    const offset = Math.max(0, params.offset)
    const limit = Math.min(32768, Math.max(1, params.limit ?? 32768))

    const sliceBytes = fullBytes.subarray(offset, offset + limit)
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const text = decoder.decode(sliceBytes)
    const total = fullBytes.length
    const eof = offset + sliceBytes.length >= total

    return { text, offset, total, eof }
  }

  /**
   * sessions.create (RCP/1 §6)
   * Guarded:
   * - allowRemoteSessionStart must be true
   * - if workspace is { path }, must be inside roots and canonicalized
   * - if workspace is { id }, must exist (even if outside roots)
   * Idempotent by requestId.
   */
  async create(params: {
    requestId: string
    workspace: { id: string } | { path: string }
    model?: ModelRef | undefined
    preset?: string | undefined
  }): Promise<{ sessionId: string; workspaceId: string }> {
    if (this.policyGuard && !this.policyGuard.allowRemoteSessionStart) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.forbidden, 'remote session start is disabled'),
      )
    }

    const cached = this.sessionCreateDedupeCache.get(params.requestId)
    if (cached) {
      return cached.result
    }

    let workspaceId: string
    if ('path' in params.workspace) {
      const rawPath = params.workspace.path
      if (this.policyGuard) {
        const canonical = this.policyGuard.canonicalizePath(rawPath)
        if (!this.policyGuard.checkPathAccess(canonical)) {
          throw new RcpMethodError(
            createRcpError(RCP_ERROR_CODES.forbidden, 'path outside roots'),
          )
        }
      }
      if (!this.workspaceAdapter) {
        throw new RcpMethodError(
          createRcpError(RCP_ERROR_CODES.internal_error, 'workspace adapter unavailable'),
        )
      }
      const wsRes = await this.workspaceAdapter.create({
        path: rawPath,
        requestId: `${params.requestId}:ws`,
      })
      workspaceId = wsRes.workspace.id
    } else {
      workspaceId = params.workspace.id
      if (this.workspaceAdapter) {
        const existing = await this.workspaceAdapter.get(workspaceId)
        if (!existing) {
          throw new RcpMethodError(
            createRcpError(RCP_ERROR_CODES.not_found, `workspace '${workspaceId}' not found`),
          )
        }
      }
    }

    const sessionRes = await gatewaySessionCreate(this.gateway, {
      workspaceId,
      agentPreset: params.preset,
    })

    const result = {
      sessionId: sessionRes.sessionId,
      workspaceId,
    }

    this.sessionCreateDedupeCache.set(params.requestId, { result, time: this.now() })
    return result
  }

  /**
   * sessions.prompt (RCP/1 §5)
   * Idempotent: requestId retries return duplicate: true.
   */
  async prompt(params: {
    sessionId: string
    requestId: string
    text: string
    delivery: 'queue' | 'steer'
  }): Promise<{ accepted: true; duplicate: boolean }> {
    const existing = this.promptDedupeCache.get(params.requestId)
    if (existing) {
      return { accepted: true, duplicate: true }
    }

    await gatewaySessionPrompt(this.gateway, {
      sessionId: params.sessionId,
      requestId: params.requestId,
      mode: params.delivery,
      content: [{ type: 'text', text: params.text }],
    })

    this.promptDedupeCache.set(params.requestId, { accepted: true, time: this.now() })

    // Clean old dedupe entries (> 1000 items)
    if (this.promptDedupeCache.size > 1000) {
      const oldest = Array.from(this.promptDedupeCache.keys()).slice(0, 200)
      for (const k of oldest) this.promptDedupeCache.delete(k)
    }

    return { accepted: true, duplicate: false }
  }

  /**
   * sessions.cancel (RCP/1 §5)
   */
  async cancel(params: { sessionId: string; requestId: string }): Promise<{ requested: true }> {
    await gatewaySessionCancel(this.gateway, { sessionId: params.sessionId })
    return { requested: true }
  }

  /**
   * sessions.queue.update (RCP/1 §5)
   */
  async queueUpdate(params: {
    sessionId: string
    itemId: string
    action: 'edit' | 'remove' | 'steer'
    text?: string | undefined
    requestId: string
  }): Promise<{ ok: true }> {
    let actionPayload: { kind: 'edit' | 'remove' | 'steer'; content?: Array<{ type: 'text'; text: string }> }

    if (params.action === 'edit') {
      actionPayload = {
        kind: 'edit',
        content: [{ type: 'text', text: params.text ?? '' }],
      }
    } else {
      actionPayload = { kind: params.action }
    }

    await gatewaySessionUpdateQueue(this.gateway, {
      sessionId: params.sessionId,
      itemId: params.itemId,
      action: actionPayload,
    })

    return { ok: true }
  }

  /**
   * sessions.rename (RCP/1 §5)
   */
  async rename(params: { sessionId: string; title: string; requestId: string }): Promise<{ title: string }> {
    const res = await gatewaySessionRename(this.gateway, {
      sessionId: params.sessionId,
      title: params.title,
    })
    return { title: res.title }
  }

  /**
   * sessions.selectModel (RCP/1 §5)
   */
  async selectModel(params: {
    sessionId: string
    model: ModelRef
    requestId: string
  }): Promise<{ model: ModelRef }> {
    const res = await gatewaySessionSelectModel(this.gateway, {
      sessionId: params.sessionId,
      provider: params.model.provider,
      model: params.model.model,
      reasoningEffort: params.model.reasoningEffort,
    })
    return {
      model: {
        provider: res.selected.provider,
        model: res.selected.model,
        ...(res.selected.reasoningEffort !== undefined ? { reasoningEffort: res.selected.reasoningEffort } : {}),
      },
    }
  }

  /**
   * sessions.control (RCP/1 §5)
   */
  async control(sink: RcpStreamSink): Promise<Record<string, unknown>> {
    return openSessionControl(this.gateway, sink, this.activity)
  }

  /**
   * models.catalog (RCP/1 §5)
   */
  async modelCatalog(): Promise<{
    providers: Array<{
      id: string
      name: string
      models: Array<{ id: string; name: string; reasoningEfforts?: string[] | undefined }>
    }>
    default?: ModelRef | undefined
  }> {
    const raw = (await gatewayModelCatalog(this.gateway)) as Record<string, unknown> | undefined
    const groups = Array.isArray(raw?.['groups']) ? raw['groups'] : []

    const providers = groups.map((g: unknown) => {
      const grp = (typeof g === 'object' && g !== null ? g : {}) as Record<string, unknown>
      const rawModels = Array.isArray(grp['models']) ? grp['models'] : []
      return {
        id: String(grp['id'] ?? ''),
        name: String(grp['name'] ?? ''),
        models: rawModels.map((m: unknown) => {
          const mdl = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>
          const reasoning = mdl['reasoning'] as { efforts?: Array<{ id: string }> } | undefined
          const reasoningEfforts = reasoning?.efforts?.map((e) => e.id)
          return {
            id: String(mdl['id'] ?? ''),
            name: String(mdl['name'] ?? ''),
            ...(reasoningEfforts && reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
          }
        }),
      }
    })

    let def: ModelRef | undefined
    const rawDef = raw?.['default'] as Record<string, unknown> | undefined
    if (typeof rawDef === 'object' && rawDef !== null && typeof rawDef['provider'] === 'string' && typeof rawDef['model'] === 'string') {
      def = {
        provider: rawDef['provider'],
        model: rawDef['model'],
        ...(typeof rawDef['reasoningEffort'] === 'string' ? { reasoningEffort: rawDef['reasoningEffort'] } : {}),
      }
    }

    return {
      providers,
      ...(def !== undefined ? { default: def } : {}),
    }
  }

  private mapToSessionSummary(rec: Record<string, unknown>): SessionSummary {
    const id = String(rec['sessionId'] ?? rec['id'] ?? '')
    const projections = rec['projections'] as { values?: Record<string, unknown> } | undefined
    const pValues = projections?.values ?? {}

    let title: string | null = null
    if (typeof pValues['title'] === 'string' && pValues['title'] !== 'null') {
      title = pValues['title']
    } else if (typeof rec['title'] === 'string' && rec['title'] !== 'null') {
      title = rec['title']
    }

    const cwd = typeof rec['cwd'] === 'string' ? rec['cwd'] : null
    const workspace = {
      id: null,
      path: cwd,
      title: cwd ? path.basename(cwd) : null,
    }

    const status: 'idle' | 'running' | 'error' | 'unknown' = rec['running'] === true ? 'running' : 'idle'
    const updatedAt = typeof rec['updatedAt'] === 'number' ? rec['updatedAt'] : this.now()

    let model: ModelRef | undefined
    const modelSel = pValues['modelSelection'] as { lastUsed?: Record<string, unknown> } | undefined
    if (modelSel?.lastUsed && typeof modelSel.lastUsed['provider'] === 'string' && typeof modelSel.lastUsed['model'] === 'string') {
      model = {
        provider: modelSel.lastUsed['provider'],
        model: modelSel.lastUsed['model'],
        ...(typeof modelSel.lastUsed['reasoningEffort'] === 'string' ? { reasoningEffort: modelSel.lastUsed['reasoningEffort'] } : {}),
      }
    }

    const parentId = typeof rec['parentSessionId'] === 'string' ? rec['parentSessionId'] : undefined
    const archived = rec['archived'] === true ? true : undefined

    return {
      id,
      title,
      workspace,
      status,
      updatedAt,
      ...(model !== undefined ? { model } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(archived !== undefined ? { archived } : {}),
    }
  }

  private cacheEventData(sessionId: string, event: SessionEvent): void {
    if (event.kind === 'assistant.message' && event.text) {
      this.eventTextCache.set(`${sessionId}:${event.seq}`, event.text)
    } else if (event.kind === 'tool.result' && event.output.text) {
      this.toolOutputCache.set(`${sessionId}:${event.callId}`, event.output.text)
    }
  }

  /**
   * Retrieves session workspace path and recent events for file and diff operations.
   */
  async getSessionDetails(sessionId: string): Promise<{
    workspaceRoot: string | null
    events: SessionEvent[]
  } | null> {
    const listRes = await this.list({ limit: 100, includeArchived: true }).catch(() => ({ items: [] }))
    const found = listRes.items.find((s) => s.id === sessionId)
    if (!found) return null

    const page = await this.page({
      sessionId,
      beforeSeq: Number.MAX_SAFE_INTEGER,
      limit: 100,
    }).catch(() => ({ events: [], hasOlder: false }))

    return {
      workspaceRoot: found.workspace.path,
      events: page.events,
    }
  }
}

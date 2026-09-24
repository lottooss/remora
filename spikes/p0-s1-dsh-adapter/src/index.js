/**
 * P0-S1 spike plugin: exercises every DshAdapter seam from an out-of-tree
 * bundle inside a real npm-installed dsh, and writes fixtures under outDir.
 *
 * Config:
 *   outDir    absolute directory for fixtures (required; empty refuses load)
 *   scenario  'full' runs the whole probe; 'routes' only registers /api/remora/ping
 *
 * The scenario is fire-and-forget from apply(): Cordis does not await async
 * work in apply, and inject only guarantees the named services exist.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'p0-s1'

/** Services required before apply runs. */
export const inject = [
  'typertGateway',
  'connection',
  'credentials',
  'storage',
]

/** Plugin config. */
export const Config = z.object({
  outDir: z.string().required(),
  scenario: z.string().default('full'),
})

const REDACT = new Set(['apiKey', 'key', 'secret', 'token', 'password'])

/**
 * Resolve a bare specifier from this module without throwing.
 * @param {string} specifier
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
function tryResolve(specifier) {
  try {
    return { ok: true, url: import.meta.resolve(specifier) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * JSON-safe deep clone that strips obvious secrets and non-JSON values.
 * @param {unknown} value
 * @returns {unknown}
 */
function safe(value) {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    return String(value)
  }
  if (Array.isArray(value)) return value.map(safe)
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: /** @type {any} */ (value).code }
  }
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.has(k) ? '[redacted]' : safe(v)
  }
  return out
}

/**
 * Write one JSON fixture.
 * @param {string} dir
 * @param {string} name
 * @param {unknown} data
 */
async function writeJson(dir, name, data) {
  await writeFile(join(dir, name), `${JSON.stringify(safe(data), null, 2)}\n`, 'utf8')
}

/**
 * Write one JSONL fixture (one safe frame per line).
 * @param {string} dir
 * @param {string} name
 * @param {readonly unknown[]} frames
 */
async function writeJsonl(dir, name, frames) {
  const body = frames.map(frame => JSON.stringify(safe(frame))).join('\n')
  await writeFile(join(dir, name), body.length === 0 ? '' : `${body}\n`, 'utf8')
}

/**
 * Collect a remote stream until the predicate holds or the deadline expires.
 * Races each `next()` against the remaining budget so an idle stream cannot
 * hang the probe past `ms`.
 * @template T
 * @param {AsyncIterable<T>} stream
 * @param {number} ms
 * @param {(frame: T) => boolean} done
 * @returns {Promise<{ frames: T[], timedOut: boolean }>}
 */
async function collect(stream, ms, done) {
  /** @type {T[]} */
  const frames = []
  const deadline = Date.now() + ms
  const iterator = stream[Symbol.asyncIterator]()
  let timedOut = false
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        break
      }
      /** @type {Promise<IteratorResult<T>>} */
      const step = Promise.resolve(iterator.next())
      /** @type {Promise<never>} */
      const tick = new Promise((_, reject) => {
        const timer = setTimeout(() => {
          reject(Object.assign(new Error(`collect timed out after ${String(ms)}ms`), { name: 'TimeoutError' }))
        }, remaining)
        step.then(() => clearTimeout(timer), () => clearTimeout(timer))
      })
      let result
      try {
        result = await Promise.race([step, tick])
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          timedOut = true
          break
        }
        throw error
      }
      if (result.done === true) break
      frames.push(result.value)
      if (done(result.value)) break
    }
  } finally {
    await iterator.return?.().catch(() => undefined)
  }
  return { frames, timedOut }
}

/**
 * True when a durable turn has finished inside collected follow frames.
 * @param {any} frame
 * @returns {boolean}
 */
function turnEnded(frame) {
  return frame?.type === 'event' && frame.event?.type === 'turn/end'
}

/**
 * Invoke a gateway method, retrying while active Services are still settling.
 * `inject` only guarantees the names exist by apply-time; the first invoke can
 * race construction of heavier controllers (sessionController).
 * @template T
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ namespace: string, method: string, args: unknown }} req
 * @returns {Promise<T>}
 */
async function invokeReady(ctx, req) {
  const deadline = Date.now() + 15_000
  let last
  for (;;) {
    try {
      return /** @type {Promise<T>} */ (/** @type {unknown} */ (ctx.typertGateway.invoke(req)))
    } catch (error) {
      last = error
      const code = /** @type {any} */ (error)?.code
      if (code !== 'gateway/service-unavailable' || Date.now() >= deadline) throw error
      await new Promise((resolve) => { setTimeout(resolve, 250) })
    }
  }
}

/**
 * Run the full probe and write every fixture into outDir.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ outDir: string, scenario: string }} config
 * @param {{ ok: true, url: string } | { ok: false, error: string }} cordisPeer
 * @param {{ ok: true, url: string } | { ok: false, error: string }} schemasteryPeer
 */
async function runScenario(ctx, config, cordisPeer, schemasteryPeer) {
  const dir = config.outDir
  await mkdir(dir, { recursive: true })
  const report = {
    startedAt: new Date().toISOString(),
    peers: {
      cordis: cordisPeer,
      schemastery: schemasteryPeer,
      credentials: tryResolve('@deepseek-ai/dsh-credentials'),
      storageDomain: tryResolve('@deepseek-ai/dsh-storage-domain'),
      zod: tryResolve('zod'),
      self: import.meta.url,
    },
    probes: /** @type {Record<string, unknown>} */ ({}),
    errors: /** @type {unknown[]} */ ([]),
  }

  /** @param {string} label */
  const fail = (label) => (error) => {
    report.errors.push({ label, error: safe(error) })
    ctx.logger.error('p0-s1: %s failed: %s', label, error instanceof Error ? error.message : String(error))
  }

  try {
    // --- Q1: strict gateway invoke across namespaces -------------------
    const list = await invokeReady(ctx, {
      namespace: 'session',
      method: 'list',
      args: { _request: {} },
    })
    report.probes.sessionList = {
      itemCount: /** @type {any} */ (list).items.length,
      sample: safe(/** @type {any} */ (list).items.slice(0, 3)),
    }
    await writeJson(dir, 'list.json', list)

    const catalog = await ctx.typertGateway.invoke({
      namespace: 'session',
      method: 'modelCatalog',
      args: {},
    })
    report.probes.modelCatalog = {
      default: safe(/** @type {any} */ (catalog).default),
      groups: (/** @type {any} */ (catalog).groups ?? []).map((g) => ({ id: g.id, models: g.models.length })),
    }

    const dirList = await ctx.typertGateway.invoke({
      namespace: 'directoryPicker',
      method: 'list',
      args: {},
    })
    report.probes.directoryPickerList = {
      entries: (/** @type {any} */ (dirList).entries ?? []).length,
    }
  } catch (error) {
    fail('gateway-invoke')(error)
  }

  // --- Q4: owner-scoped credentials -------------------------------------
  try {
    /** @type {(scope: string, id: string) => string} */
    let credentialKey = (scope, id) => `${scope}/${id}`
    let credentialsImport = 'manual'
    try {
      const mod = await import('@deepseek-ai/dsh-credentials')
      if (typeof mod.credentialKey === 'function') {
        credentialKey = mod.credentialKey
        credentialsImport = 'package'
      }
    } catch {
      // Out-of-tree package may not be resolvable; the joined key is the wire form.
    }
    const key = credentialKey('p0-s1', 'probe')
    const written = await ctx.credentials.modifyRecord(key, async () => ({
      kind: 'grant',
      payload: { note: 'p0-s1 probe', at: Date.now() },
    }))
    const readBack = await ctx.credentials.readRecord(key)
    const info = await ctx.credentials.describeRecord(key)
    report.probes.credentials = {
      key,
      via: credentialsImport,
      writtenKind: /** @type {any} */ (written)?.kind,
      readBackKind: /** @type {any} */ (readBack)?.kind,
      configured: info.configured,
      writable: info.writable,
    }
    await ctx.credentials.deleteRecord(key)
  } catch (error) {
    fail('credentials')(error)
  }

  // --- Q4: storage.domain document --------------------------------------
  try {
    /** @type {any} */
    let zod = undefined
    let zodVia = 'absent'
    try {
      zod = await import('zod')
      zodVia = 'package'
    } catch {
      try {
        zod = await import('@deepseek-ai/schemastery')
        zodVia = 'schemastery'
      } catch {
        zodVia = 'fallback-parse'
      }
    }
    const noteSchema = zodVia === 'fallback-parse'
      ? {
        parse: (/** @type {unknown} */ value) => {
          if (typeof value !== 'object' || value === null || typeof /** @type {any} */ (value).note !== 'string') {
            throw new Error('invalid note document')
          }
          return value
        },
        safeParse: (/** @type {unknown} */ value) => {
          try {
            return { success: true, data: noteSchema.parse(value) }
          } catch (error) {
            return { success: false, error }
          }
        },
      }
      : (zod.z ?? zod.default ?? zod).object({ note: (zod.z ?? zod.default ?? zod).string() })

    /** @type {any} */
    let domain = undefined
    let domainVia = ''
    /** @type {any} */
    let spec = undefined
    try {
      const mod = await import('@deepseek-ai/dsh-storage-domain')
      spec = mod.defineDomain({
        name: 'p0_s1_probe',
        version: 1,
        tables: { docs: mod.domainTable(noteSchema) },
      })
      domainVia = 'defineDomain'
    } catch (error) {
      // UNIT_NAME_RE is /^[a-z][a-z0-9_]*$/; hand-built spec is the wire form.
      spec = {
        name: 'p0_s1_probe',
        version: 1,
        tables: { docs: { valueSchema: noteSchema } },
      }
      domainVia = `manual (${error instanceof Error ? error.message : String(error)})`
    }

    const facility = ctx.get?.('storageDomain') ?? /** @type {any} */ (ctx).storageDomain
      ?? /** @type {any} */ (ctx).storage?.domain
    if (facility === undefined || typeof facility.open !== 'function') {
      throw new Error('no storage domain facility on ctx (storageDomain / storage.domain)')
    }
    domain = await facility.open(spec)
    try {
      await domain.table('docs').put('one', { note: 'p0-s1 storage probe' })
      const record = domain.table('docs').get('one')
      report.probes.storageDomain = {
        name: domain.name ?? spec.name,
        record: safe(record),
        via: domainVia,
        zodVia,
        facility: facility === /** @type {any} */ (ctx).storage?.domain ? 'ctx.storage.domain' : 'ctx.storageDomain',
      }
      await domain.table('docs').delete('one')
    } finally {
      await domain.close()
    }
  } catch (error) {
    fail('storage-domain')(error)
  }

  if (config.scenario !== 'full') {
    report.finishedAt = new Date().toISOString()
    await writeJson(dir, 'report.json', report)
    return
  }

  // --- workspace + session + prompt + follow fixtures ------------------
  try {
    const wsPath = await mkdtemp(join(tmpdir(), 'remora-p0-s1-'))
    report.probes.workspacePath = wsPath

    const ws = await ctx.typertGateway.invoke({
      namespace: 'workspace',
      method: 'create',
      args: { request: { path: wsPath } },
    })
    report.probes.workspaceCreate = safe(ws)
    const workspaceId = /** @type {any} */ (ws).workspace.workspaceId

    const session = await ctx.typertGateway.invoke({
      namespace: 'session',
      method: 'create',
      args: { request: { workspaceId } },
    })
    report.probes.sessionCreate = safe(session)
    const sessionId = /** @type {any} */ (session).sessionId

    // Open follow with cursorless assistant frames BEFORE prompting.
    const followAbort = new AbortController()
    const followStream = await ctx.typertGateway.stream({
      namespace: 'session',
      method: 'follow',
      args: {
        request: {
          address: { kind: 'session', sessionId },
          assistantStream: true,
        },
      },
      signal: followAbort.signal,
    })

    // Wait for durable turn/end so tool/call + tool/result are in the fixture;
    // assistant-stream end can fire mid-turn before the tool step settles.
    const livePromise = collect(followStream, 90_000, (frame) => turnEnded(frame))

    // Give the follower a tick to attach before the first prompt.
    await new Promise((r) => setTimeout(r, 250))

    const requestId = `p0-s1-${randomUUID()}`
    const promptText = 'Call todo_write once with a single completed item, then stop.'
    const promptBody = {
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
    }
    const promptValue = await ctx.typertGateway.invoke({
      namespace: 'session',
      method: 'prompt',
      args: { request: promptBody },
    })
    report.probes.prompt = safe(promptValue)

    // Duplicate requestId must return the original acceptance without a second message.
    const duplicateValue = await ctx.typertGateway.invoke({
      namespace: 'session',
      method: 'prompt',
      args: { request: promptBody },
    })
    report.probes.promptDuplicate = safe(duplicateValue)
    await writeJson(dir, 'prompt-duplicate.json', {
      first: promptValue,
      second: duplicateValue,
      requestId,
    })

    const live = await livePromise
    followAbort.abort()
    const liveFrames = live.frames

    // Opening snapshot + live durable/assistant frames from the first follow.
    await writeJsonl(dir, 'follow-live.jsonl', liveFrames)
    const opening = liveFrames.find((f) => f?.type === 'snapshot')
    report.probes.followOpening = {
      cursor: /** @type {any} */ (opening)?.cursor,
      records: /** @type {any} */ (opening)?.records?.length,
      hasMore: /** @type {any} */ (opening)?.hasMore,
      hasAssistantStream: opening != null && 'assistantStream' in /** @type {any} */ (opening),
      frameTypes: [...new Set(liveFrames.map((f) => f?.type))],
      eventTypes: [...new Set(liveFrames.filter((f) => f?.type === 'event').map((f) => f.event.type))],
      assistantFrameTypes: liveFrames
        .filter((f) => f?.type === 'assistant-stream')
        .map((f) => f.frame.type),
      timedOut: live.timedOut,
    }

    // "Resume": SessionFollowRequest has no afterSeq. Re-open follow; the
    // snapshot carries the current cursor and a tail of records. The adapter
    // resumes client-side by discarding seq <= afterSeq (recorded here).
    const afterSeq = liveFrames
      .filter((f) => f?.type === 'event')
      .reduce((max, f) => Math.max(max, f.event.seq), -1)
    const resumeAbort = new AbortController()
    const resumeStream = await ctx.typertGateway.stream({
      namespace: 'session',
      method: 'follow',
      args: {
        request: {
          address: { kind: 'session', sessionId },
          assistantStream: true,
        },
      },
      signal: resumeAbort.signal,
    })
    const resume = await collect(resumeStream, 5_000, (f) => f?.type === 'snapshot')
    resumeAbort.abort()
    await writeJsonl(dir, 'follow-resume.jsonl', resume.frames)
    const resumeOpening = resume.frames.find((f) => f?.type === 'snapshot')
    report.probes.followResume = {
      afterSeq,
      reopenedCursor: /** @type {any} */ (resumeOpening)?.cursor,
      reopenedRecords: /** @type {any} */ (resumeOpening)?.records?.length,
      // Events with seq <= afterSeq are already held; the adapter drops them.
      coveredBySnapshot: /** @type {any} */ (resumeOpening)?.cursor >= afterSeq,
      timedOut: resume.timedOut,
    }

    // Opening-only fixture: re-open once more on a quiet session so the
    // snapshot + zero live events are isolated for mapper tests.
    const openAbort = new AbortController()
    const openStream = await ctx.typertGateway.stream({
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'session', sessionId } } },
      signal: openAbort.signal,
    })
    const opened = await collect(openStream, 3_000, (f) => f?.type === 'snapshot')
    openAbort.abort()
    await writeJsonl(dir, 'follow-opening.jsonl', opened.frames)

    // Refresh list fixture after the session exists.
    const listAfter = await invokeReady(ctx, {
      namespace: 'session',
      method: 'list',
      args: { _request: {} },
    })
    await writeJson(dir, 'list.json', listAfter)
    report.probes.sessionListAfter = {
      itemCount: /** @type {any} */ (listAfter).items.length,
      foundSession: (/** @type {any} */ (listAfter).items ?? []).some(
        (i) => i.sessionId === sessionId,
      ),
    }

    // Gap-repair page from the opening cursor.
    const page = await ctx.typertGateway.invoke({
      namespace: 'session',
      method: 'page',
      args: {
        request: {
          address: { kind: 'session', sessionId },
          throughSeq: afterSeq,
          maxMessages: 10,
        },
      },
    })
    report.probes.page = {
      records: /** @type {any} */ (page).records?.length,
      hasMore: /** @type {any} */ (page).hasMore,
    }
    await writeJson(dir, 'page.json', page)

    report.probes.sessionId = sessionId
    report.probes.workspaceId = workspaceId
  } catch (error) {
    fail('session-scenario')(error)
  }

  report.finishedAt = new Date().toISOString()
  await writeJson(dir, 'report.json', report)
  ctx.logger.info(
    'p0-s1: scenario finished with %d error(s); fixtures in %s',
    report.errors.length,
    dir,
  )
}

/**
 * Plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ outDir: string, scenario: string }} config
 */
export function apply(ctx, config) {
  if (config.outDir.length === 0) {
    throw new Error(
      'p0-s1: outDir is required — set it in the profile cordis.patch.yml row "p0-s1" to an absolute directory',
    )
  }

  const cordisPeer = tryResolve('@deepseek-ai/cordis')
  const schemasteryPeer = tryResolve('@deepseek-ai/schemastery')
  if (!cordisPeer.ok) {
    ctx.logger.warn('p0-s1: @deepseek-ai/cordis not resolvable from plugin: %s', cordisPeer.error)
  }
  if (!schemasteryPeer.ok) {
    ctx.logger.warn('p0-s1: @deepseek-ai/schemastery not resolvable from plugin: %s', schemasteryPeer.error)
  }

  // Approvals fail closed without an answerer; the spike always grants once
  // so the mock tool_call can execute under the default `ask` policy.
  const approvals = ctx.on('approval/request', (req, next) => {
    ctx.logger.info('p0-s1: auto-approving %s', req.toolName)
    void next
    return /** @type {'allowed-once'} */ ('allowed-once')
  }, { prepend: true })

  // Q3: exact Fetch route under /api inherits Connection browser auth.
  const route = ctx.connection.fetch.register({
    path: '/api/remora/ping',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(
      JSON.stringify({
        ok: true,
        plugin: name,
        peers: { cordis: cordisPeer, schemastery: schemasteryPeer },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  })

  void runScenario(ctx, config, cordisPeer, schemasteryPeer).catch((error) => {
    ctx.logger.error('p0-s1: scenario crashed: %s', error instanceof Error ? error.stack : String(error))
  })

  ctx.effect(() => () => {
    approvals()
    route()
  }, 'p0-s1: route + approvals')
}

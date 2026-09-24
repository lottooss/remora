/**
 * P0-S2 spike plugin: root-context prepend listeners for approval/request and
 * user-questions/request, plus control routes that drive the six experiments
 * against a mock-LLM-backed dsh web profile.
 *
 * Throwaway: never imported by production code; not in the pnpm workspace.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'p0-s2'

/** Services required before apply runs. */
export const inject = [
  'connection',
  'typertGateway',
  'approval',
  'userQuestions',
  'agents',
  'sessionController',
  'tools',
]

/** Plugin config. */
export const Config = z.object({
  outDir: z.string().required(),
  /** Bridge behavior on each waterfall entry. */
  mode: z.union(['observe', 'answer-first', 'defer', 'race-next']).default('observe'),
  /** Withdrawal attempt when the bridge wins before next() settles (exp 3). */
  withdrawal: z.union(['signal', 'decided-observe', 'none']).default('signal'),
  answerDelayMs: z.natural().min(0).max(60000).default(0),
  /** Bound for next() in observe mode when the Gateway parks with zero clients. */
  nextTimeoutMs: z.natural().min(100).max(60000).default(4000),
  approvalAnswer: z.union(['allowed-once', 'rejected', 'unavailable', 'cancelled'])
    .default('allowed-once'),
  questionSelected: z.string().default('phone'),
  probeTool: z.string().default('p0s2_probe'),
})

/** Mutable runtime knobs the harness flips without restarting dsh. */
const runtime = {
  mode: 'observe',
  withdrawal: 'signal',
  answerDelayMs: 0,
  nextTimeoutMs: 4000,
  approvalAnswer: 'allowed-once',
  questionSelected: 'phone',
}

/** JSONL frames written under outDir for evidence. */
async function logLine(outDir, frame) {
  await mkdir(outDir, { recursive: true })
  await appendFile(join(outDir, 'events.jsonl'), `${JSON.stringify({ t: Date.now(), ...frame })}\n`, 'utf8')
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Find the live tool/call event for a callId by scanning the session log
 * backwards (Q7 live path).
 * @param {object} agent
 * @param {string} callId
 * @returns {object|undefined}
 */
function findToolCallLive(agent, callId) {
  const events = agent.session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'tool/call' && event.data?.callId === callId) return event
  }
  return undefined
}

/**
 * Handle one approval/request entry according to the active mode.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} req
 * @param {() => Promise<string>} next
 * @param {{ outDir: string, probeTool: string }} opts
 * @returns {Promise<string>}
 */
async function onApproval(ctx, req, next, opts) {
  const id = randomUUID()
  const entry = {
    id,
    kind: 'approval/enter',
    mode: runtime.mode,
    withdrawal: runtime.withdrawal,
    toolName: req.toolName,
    callId: req.callId ?? null,
    hasSignal: req.signal !== undefined,
    signalAborted: req.signal?.aborted === true,
    agentId: req.agent?.id ?? null,
  }
  await logLine(opts.outDir, entry)
  ctx.logger.info('p0-s2: approval enter id=%s mode=%s tool=%s', id, runtime.mode, req.toolName)

  // Q7: live Session preview lookup while the turn is open.
  if (req.callId !== undefined && req.agent !== undefined) {
    const live = findToolCallLive(req.agent, req.callId)
    await logLine(opts.outDir, {
      id,
      kind: 'preview/live',
      found: live !== undefined,
      name: live?.data?.name ?? null,
      arguments: live?.data?.arguments ?? null,
    })
    try {
      const inspection = await ctx.sessionController.inspect(req.agent.session.id)
      const cold = [...(inspection.events ?? [])].reverse()
        .find((event) => event?.type === 'tool/call' && event.data?.callId === req.callId)
      await logLine(opts.outDir, {
        id,
        kind: 'preview/inspect',
        found: cold !== undefined,
        name: cold?.data?.name ?? null,
        arguments: cold?.data?.arguments ?? null,
        eventCount: inspection.events?.length ?? 0,
      })
    } catch (error) {
      await logLine(opts.outDir, {
        id,
        kind: 'preview/inspect-error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (runtime.answerDelayMs > 0) await sleep(runtime.answerDelayMs)

  if (runtime.mode === 'observe' || runtime.mode === 'defer') {
    // Exp 1/2/4: always delegate and record what next() returns. With zero
    // remote-event clients the Gateway parks the pending event, so next() can
    // hang for the whole turn — bound it and record the hang.
    const started = Date.now()
    try {
      const outcome = await Promise.race([
        next(),
        sleep(runtime.nextTimeoutMs).then(() => 'p0-s2:next-timeout'),
      ])
      await logLine(opts.outDir, {
        id,
        kind: 'approval/next-resolved',
        outcome,
        ms: Date.now() - started,
        timedOut: outcome === 'p0-s2:next-timeout',
      })
      return outcome === 'p0-s2:next-timeout' ? 'unavailable' : outcome
    } catch (error) {
      await logLine(opts.outDir, {
        id,
        kind: 'approval/next-rejected',
        ms: Date.now() - started,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
      throw error
    }
  }

  if (runtime.mode === 'answer-first') {
    return answerFirstApproval(ctx, req, next, opts, id)
  }

  if (runtime.mode === 'race-next') {
    return raceNextApproval(ctx, req, next, opts, id)
  }

  return next()
}

/**
 * Exp 3: claim the decision without waiting for next(); optionally withdraw
 * the downstream (browser) chain first via a derived abort signal.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} req
 * @param {() => Promise<string>} next
 * @param {{ outDir: string }} opts
 * @param {string} id
 * @returns {Promise<string>}
 */
async function answerFirstApproval(ctx, req, next, opts, id) {
  let withdrawController
  if (runtime.withdrawal === 'signal' && req.signal !== undefined) {
    withdrawController = new AbortController()
    const combined = AbortSignal.any([req.signal, withdrawController.signal])
    try {
      // Shared request object: replace the signal so projectRemoteEventRequest
      // and any downstream awaiters observe the derived abort.
      Object.defineProperty(req, 'signal', {
        value: combined,
        configurable: true,
        writable: true,
        enumerable: true,
      })
      await logLine(opts.outDir, { id, kind: 'withdraw/signal-substituted' })
    } catch (error) {
      await logLine(opts.outDir, {
        id,
        kind: 'withdraw/signal-substitute-failed',
        error: error instanceof Error ? error.message : String(error),
      })
      withdrawController = undefined
    }
  }

  const decidedAt = Date.now()
  const outcome = runtime.approvalAnswer
  await logLine(opts.outDir, { id, kind: 'approval/claimed', outcome, decidedAt })

  // Fire-and-forget the PC chain so api-remotes sees the request (a card can
  // appear) and later observe / cancel it.
  const pc = next().then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
  )
  // Give the gateway a tick to park the pending delivery, then withdraw.
  await sleep(50)
  if (withdrawController !== undefined) {
    withdrawController.abort(new Error('p0-s2: bridge answered first; withdrawing PC chain'))
    await logLine(opts.outDir, { id, kind: 'withdraw/signal-aborted' })
  }
  if (runtime.withdrawal === 'decided-observe') {
    await logLine(opts.outDir, {
      id,
      kind: 'withdraw/decided-observe',
      note: 'ui-approval does not subscribe approval/decided; expect stale card unless cancel arrives',
    })
  }
  if (runtime.withdrawal === 'none') {
    await logLine(opts.outDir, { id, kind: 'withdraw/none' })
  }

  const settled = await Promise.race([
    pc,
    sleep(2000).then(() => ({ ok: false, error: 'timeout waiting for PC chain' })),
  ])
  await logLine(opts.outDir, { id, kind: 'approval/pc-chain', ...settled })
  return outcome
}

/**
 * Exp 4: call next() and race it against the phone answer delay; first wins.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} req
 * @param {() => Promise<string>} next
 * @param {{ outDir: string }} opts
 * @param {string} id
 * @returns {Promise<string>}
 */
async function raceNextApproval(ctx, req, next, opts, id) {
  const pc = next().then(
    (value) => ({ side: 'pc', value }),
    (error) => ({ side: 'pc', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
  )
  const phone = sleep(runtime.answerDelayMs).then(() => ({ side: 'phone', value: runtime.approvalAnswer }))
  const winner = await Promise.race([pc, phone])
  await logLine(opts.outDir, { id, kind: 'approval/race-winner', ...winner })
  return winner.side === 'phone' ? winner.value : (winner.value ?? 'unavailable')
}

/**
 * Handle one user-questions/request entry (same mode table as approvals).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} req
 * @param {() => Promise<object>} next
 * @param {{ outDir: string }} opts
 * @returns {Promise<object>}
 */
async function onQuestion(ctx, req, next, opts) {
  const id = randomUUID()
  await logLine(opts.outDir, {
    id,
    kind: 'question/enter',
    mode: runtime.mode,
    withdrawal: runtime.withdrawal,
    questionCount: req.questions?.length ?? 0,
    hasSignal: req.signal !== undefined,
    signalAborted: req.signal?.aborted === true,
    agentId: req.agent?.id ?? null,
  })
  ctx.logger.info('p0-s2: question enter id=%s mode=%s', id, runtime.mode)

  if (runtime.answerDelayMs > 0) await sleep(runtime.answerDelayMs)

  const phoneAnswer = () => ({
    answers: (req.questions ?? []).map((question) => ({
      id: question.id,
      selected: [runtime.questionSelected],
    })),
  })

  if (runtime.mode === 'observe' || runtime.mode === 'defer') {
    const started = Date.now()
    try {
      const value = await Promise.race([
        next(),
        sleep(runtime.nextTimeoutMs).then(() => 'p0-s2:next-timeout'),
      ])
      if (value === 'p0-s2:next-timeout') {
        await logLine(opts.outDir, {
          id,
          kind: 'question/next-resolved',
          ms: Date.now() - started,
          timedOut: true,
          answers: null,
        })
        return phoneAnswer()
      }
      await logLine(opts.outDir, {
        id,
        kind: 'question/next-resolved',
        ms: Date.now() - started,
        answers: value?.answers ?? null,
      })
      return value
    } catch (error) {
      await logLine(opts.outDir, {
        id,
        kind: 'question/next-rejected',
        ms: Date.now() - started,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
      throw error
    }
  }

  if (runtime.mode === 'answer-first') {
    let withdrawController
    if (runtime.withdrawal === 'signal' && req.signal !== undefined) {
      withdrawController = new AbortController()
      try {
        Object.defineProperty(req, 'signal', {
          value: AbortSignal.any([req.signal, withdrawController.signal]),
          configurable: true,
          writable: true,
          enumerable: true,
        })
        await logLine(opts.outDir, { id, kind: 'withdraw/signal-substituted' })
      } catch (error) {
        await logLine(opts.outDir, {
          id,
          kind: 'withdraw/signal-substitute-failed',
          error: error instanceof Error ? error.message : String(error),
        })
        withdrawController = undefined
      }
    }
    const outcome = phoneAnswer()
    await logLine(opts.outDir, { id, kind: 'question/claimed' })
    const pc = next().then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
    )
    await sleep(50)
    if (withdrawController !== undefined) {
      withdrawController.abort(new Error('p0-s2: bridge answered first; withdrawing PC chain'))
      await logLine(opts.outDir, { id, kind: 'withdraw/signal-aborted' })
    }
    const settled = await Promise.race([
      pc,
      sleep(2000).then(() => ({ ok: false, error: 'timeout waiting for PC chain' })),
    ])
    await logLine(opts.outDir, { id, kind: 'question/pc-chain', ...settled })
    return outcome
  }

  if (runtime.mode === 'race-next') {
    const pc = next().then(
      (value) => ({ side: 'pc', value }),
      (error) => ({ side: 'pc', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
    )
    const phone = sleep(runtime.answerDelayMs).then(() => ({ side: 'phone', value: phoneAnswer() }))
    const winner = await Promise.race([pc, phone])
    await logLine(opts.outDir, { id, kind: 'question/race-winner', side: winner.side })
    if (winner.side === 'pc') {
      if (winner.value !== undefined && winner.error === undefined) return winner.value
      throw new Error(winner.error ?? 'PC chain failed')
    }
    return winner.value
  }

  return next()
}

/**
 * Startup self-check: prove a root prepend listener runs before a non-prepend
 * sentinel on a synthetic waterfall (and before api-remotes' own listener if
 * that listener is present on the same event).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ outDir: string }} opts
 * @returns {Promise<object>}
 */
async function runSelfCheck(ctx, opts) {
  const order = []

  const bridge = ctx.on('approval/request', async function bridgeProbe(req, next) {
    order.push('bridge-prepend')
    return next()
  }, { prepend: true })

  const sentinel = ctx.on('approval/request', async function sentinelProbe(req, next) {
    order.push('sentinel-ordinary')
    return next()
  })

  let result
  let error
  try {
    result = await ctx.waterfall(
      'approval/request',
      {
        toolName: 'p0-s2-selfcheck',
        agent: { id: 'p0-s2-selfcheck-agent', session: { id: 'p0-s2-selfcheck' } },
      },
      async () => {
        order.push('terminal')
        return 'unavailable'
      },
    )
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
  }

  bridge()
  sentinel()

  const prependFirst = order[0] === 'bridge-prepend'
    && order.indexOf('sentinel-ordinary') > order.indexOf('bridge-prepend')
  const report = {
    kind: 'selfcheck',
    order,
    prependFirst,
    result: result ?? null,
    error: error ?? null,
    at: Date.now(),
  }
  await logLine(opts.outDir, report)
  return report
}

/**
 * Drive one experiment scenario end-to-end inside the host process.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ outDir: string, probeTool: string }} opts
 * @param {string} scenario
 * @returns {Promise<object>}
 */
async function runScenario(ctx, opts, scenario) {
  const startedAt = Date.now()
  const base = { kind: 'scenario', scenario, startedAt }

  if (scenario === 'selfcheck') {
    const report = await runSelfCheck(ctx, opts)
    return { ...base, finishedAt: Date.now(), ...report }
  }

  if (scenario === 'preview-static') {
    try {
      const inspection = await ctx.sessionController.inspect('session-missing')
      return { ...base, finishedAt: Date.now(), ok: true, events: inspection.events?.length ?? 0 }
    } catch (error) {
      return {
        ...base,
        finishedAt: Date.now(),
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }
    }
  }

  // Approval / question / cancel / abort scenarios need a live turn driven by
  // the mock LLM. The harness owns that loop; this route only reports that
  // the control plane is reachable (the plugin logs waterfall entries itself).
  return { ...base, finishedAt: Date.now(), ok: true, waited: false }
}

/**
 * Plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  // P0S2_OUT isolates each harness run; config.outDir is the static default.
  const outDir = process.env.P0S2_OUT && process.env.P0S2_OUT.length > 0
    ? process.env.P0S2_OUT
    : config.outDir
  if (outDir.length === 0) {
    throw new Error(
      'p0-s2: outDir is required — set P0S2_OUT or cordis.patch.yml row "p0-s2" to an absolute directory',
    )
  }
  const opts = { outDir, probeTool: config.probeTool }
  runtime.mode = config.mode
  runtime.answerDelayMs = config.answerDelayMs
  runtime.nextTimeoutMs = config.nextTimeoutMs
  runtime.approvalAnswer = config.approvalAnswer
  runtime.questionSelected = config.questionSelected

  void logLine(opts.outDir, {
    kind: 'boot',
    mode: runtime.mode,
    approvalAnswer: runtime.approvalAnswer,
    probeTool: config.probeTool,
    self: import.meta.url,
  })

  // Register a trivial tool the mock LLM can call so tools/pre-execute fires.
  try {
    ctx.tools.register(defineProbeTool(config.probeTool))
  } catch (error) {
    ctx.logger.warn('p0-s2: probe tool register failed: %s', error instanceof Error ? error.message : String(error))
  }

  // Exp 6 / general: force the probe tool into an approval ask.
  const preExecute = ctx.on('tools/pre-execute', async function probeAsk(exec, next) {
    if (exec.name !== config.probeTool) return next()
    await logLine(opts.outDir, {
      kind: 'pre-execute/ask',
      toolName: exec.name,
      callId: exec.callId ?? null,
    })
    return { kind: 'ask', reason: 'p0-s2 probe requires approval' }
  }, { prepend: true })

  // Root-context prepend listeners (Q5).
  const approvals = ctx.on('approval/request', function bridgeApproval(req, next) {
    return onApproval(ctx, req, next, opts)
  }, { prepend: true })

  const questions = ctx.on('user-questions/request', function bridgeQuestion(req, next) {
    return onQuestion(ctx, req, next, opts)
  }, { prepend: true })

  // Control routes under /api (inherit browser auth — P0-S1 Q3).
  const routes = []
  const register = (path, methods, handler) => {
    routes.push(ctx.connection.fetch.register({
      path,
      methods,
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = methods.includes('POST') ? await readJson(request) : {}
          const value = await handler(body)
          return json(200, value)
        } catch (error) {
          ctx.logger.error('p0-s2: route %s failed: %s', path, error instanceof Error ? error.message : String(error))
          return json(500, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }))
  }

  register('/api/remora/s2/config', ['GET', 'POST'], async (body) => {
    if (body && Object.keys(body).length > 0) {
      for (const key of [
        'mode', 'withdrawal', 'answerDelayMs', 'nextTimeoutMs',
        'approvalAnswer', 'questionSelected',
      ]) {
        if (body[key] !== undefined) runtime[key] = body[key]
      }
      await logLine(opts.outDir, { kind: 'config', ...runtime })
    }
    return { ...runtime }
  })

  register('/api/remora/s2/log', ['GET'], async () => {
    try {
      const text = await readFile(join(opts.outDir, 'events.jsonl'), 'utf8')
      return { lines: text.split('\n').filter(Boolean) }
    } catch {
      return { lines: [] }
    }
  })

  register('/api/remora/s2/scenario', ['POST'], async (body) => {
    const scenario = String(body?.scenario ?? '')
    return runScenario(ctx, opts, scenario)
  })

  ctx.effect(() => () => {
    preExecute()
    approvals()
    questions()
    for (const dispose of routes) dispose()
  }, 'p0-s2: listeners + routes')
}

/** Minimal probe tool so the mock LLM's tool_call has a real target. */
function defineProbeTool(toolName) {
  return {
    name: toolName,
    description: 'P0-S2 spike probe: records arguments for AnswerBridge experiments.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Free-form note for the probe call.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args) {
      return { ok: true, args }
    },
  }
}

async function readJson(request) {
  const text = await request.text()
  if (text.length === 0) return {}
  return JSON.parse(text)
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

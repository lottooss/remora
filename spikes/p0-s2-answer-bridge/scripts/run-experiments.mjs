/**
 * P0-S2 experiment runner: starts the mock LLM + dsh web profile, optionally
 * a scripted browser client, drives each scenario twice, and collects logs
 * under out/runs/<experiment>-<pass>/.
 *
 * Prerequisite: node scripts/setup.mjs
 *
 * Usage:
 *   node scripts/run-experiments.mjs              # all experiments × 2
 *   node scripts/run-experiments.mjs --only e1    # one experiment × 2
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installDir = join(spikeRoot, '.install')
const dshBin = join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const mockBin = join(spikeRoot, 'scripts', 'mock-llm.mjs')
const outRoot = join(spikeRoot, 'out')
const runsRoot = join(outRoot, 'runs')
const PORT = Number(process.env.P0S2_PORT ?? '7718')
const MOCK_PORT = Number(process.env.P0S2_MOCK_PORT ?? '8718')
const API_KEY = 'p0-s2-mock-key'
const BASE = `http://127.0.0.1:${PORT}`
const PROFILE = 'remora-dev'
const PASSES = 2

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1]
}

const only = arg('only', '')

function log(msg) {
  console.log(`[p0-s2] ${msg}`)
}

function runCapture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

let authCookie = ''

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(new URL(path, BASE), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authCookie ? { cookie: authCookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
  return { status: res.status, body: parsed }
}

async function waitFor(fn, { timeoutMs = 30000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await delay(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function startMock(sequence, extra = []) {
  const child = spawn(process.execPath, [
    mockBin,
    '--port', String(MOCK_PORT),
    '--api-key', API_KEY,
    '--sequence', sequence,
    '--repeat-last',
    ...extra,
  ], {
    cwd: spikeRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) {
        lines.push(line)
        try {
          const event = JSON.parse(line)
          if (event.type === 'ready') log(`mock ready ${event.baseURL}`)
        } catch { /* non-json */ }
      }
    }
  })
  child.stderr.on('data', (chunk) => process.stderr.write(`[mock] ${chunk}`))
  return { child, lines }
}

function startDsh(runDir) {
  const child = spawn(dshBin, [
    '--profile', PROFILE,
    '--no-open',
    '--port', String(PORT),
  ], {
    cwd: spikeRoot,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      DEEPSEEK_API_KEY: API_KEY,
      // Plugin prefers this over cordis.patch.yml#outDir so each run isolates
      // events.jsonl; without it every pass appends to out/events.jsonl.
      P0S2_OUT: runDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => {
    stdout.push(String(chunk))
    process.stdout.write(`[dsh] ${chunk}`)
  })
  child.stderr.on('data', (chunk) => {
    stderr.push(String(chunk))
    process.stderr.write(`[dsh!] ${chunk}`)
  })
  return { child, stdout: () => stdout.join(''), stderr: () => stderr.join('') }
}

function extractToken(dshStdout) {
  const match = /dsh web: (http:\/\/[^\s]+)/.exec(dshStdout)
  if (!match) return null
  try {
    return new URL(match[1]).searchParams.get('token')
  } catch {
    return null
  }
}

function startBrowser(token, runDir, mode, durationMs) {
  const child = spawn(process.execPath, [
    join(spikeRoot, 'scripts', 'browser-client.mjs'),
    '--url', BASE,
    '--token', token,
    '--mode', mode,
    '--out', join(runDir, 'browser.jsonl'),
    '--duration-ms', String(durationMs),
  ], {
    cwd: spikeRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  child.stdout.on('data', (chunk) => {
    lines.push(String(chunk))
    process.stdout.write(`[br] ${chunk}`)
  })
  child.stderr.on('data', (chunk) => process.stderr.write(`[br!] ${chunk}`))
  return { child, lines: () => lines.join('') }
}

async function stopAll(...handles) {
  for (const handle of handles) {
    if (handle?.child && handle.child.exitCode === null) {
      // shell:true wraps in cmd.exe — kill the whole tree so node dies too.
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(handle.child.pid)], { stdio: 'ignore' })
      } else {
        handle.child.kill('SIGTERM')
      }
    }
  }
  await delay(1200)
  for (const handle of handles) {
    if (handle?.child && handle.child.exitCode === null) {
      handle.child.kill('SIGKILL')
    }
  }
  // Free the dsh port before the next run; a half-dead child can linger.
  killPortListeners(PORT)
  await waitForPortFree(PORT, 10000).catch((error) => {
    log(`port cleanup after stop: ${error instanceof Error ? error.message : String(error)}`)
  })
  await delay(300)
}

/**
 * Each experiment: { id, description, browser, mock, config, drive }.
 * drive(ctx) runs after dsh is up and (optionally) the browser client is ready.
 */
const experiments = [
  {
    id: 'e1',
    description: 'no browser connected → listener vs terminal default; what next() returns',
    browser: null,
    mock: 'tool_call_success,success',
    mockExtra: ['--tool-name', 'p0s2_probe', '--tool-arguments', '{"note":"e1"}'],
    config: { mode: 'observe', withdrawal: 'none', answerDelayMs: 0 },
    async drive(ctx) {
      await api('/api/remora/s2/config', ctx.ex.config)
      const scenario = await api('/api/remora/s2/scenario', { scenario: 'approval-wait' })
      // Drive a session turn via in-process gateway is not available over HTTP;
      // the harness uses session RPC below.
      await driveApprovalTurn(ctx, 'e1-prompt')
      return { scenario: scenario.body }
    },
  },
  {
    id: 'e2',
    description: 'one browser tab open → ordering between Remora listener and api-remotes',
    browser: 'passive',
    mock: 'tool_call_success,success',
    mockExtra: ['--tool-name', 'p0s2_probe', '--tool-arguments', '{"note":"e2"}'],
    config: { mode: 'observe', withdrawal: 'none', answerDelayMs: 0 },
    async drive(ctx) {
      await api('/api/remora/s2/config', ctx.ex.config)
      await delay(500)
      await driveApprovalTurn(ctx, 'e2-prompt')
    },
  },
  {
    id: 'e3a',
    description: 'Remora answers first → withdraw via derived AbortSignal substitution',
    browser: 'passive',
    mock: 'tool_call_success,success',
    mockExtra: ['--tool-name', 'p0s2_probe', '--tool-arguments', '{"note":"e3a"}'],
    config: { mode: 'answer-first', withdrawal: 'signal', answerDelayMs: 0 },
    async drive(ctx) {
      await api('/api/remora/s2/config', ctx.ex.config)
      await delay(500)
      await driveApprovalTurn(ctx, 'e3a-prompt')
    },
  },
  {
    id: 'e3b',
    description: 'Remora answers first → observe whether GUI reacts to approval/decided (expect stale card)',
    browser: 'passive',
    mock: 'tool_call_success,success',
    mockExtra: ['--tool-name', 'p0s2_probe', '--tool-arguments', '{"note":"e3b"}'],
    config: { mode: 'answer-first', withdrawal: 'decided-observe', answerDelayMs: 0 },
    async drive(ctx) {
      await api('/api/remora/s2/config', ctx.ex.config)
      await delay(500)
      await driveApprovalTurn(ctx, 'e3b-prompt')
    },
  },
  {
    id: 'e3c',
    description: 'Remora answers first → do nothing to the PC chain (baseline stale card)',
    browser: 'passive',
    mock: 'tool_call_success,success',
    mockExtra: ['--tool-name', 'p0s2_probe', '--tool-arguments', '{"note":"e3c"}'],
    config: { mode: 'answer-first', withdrawal: 'none', answerDelayMs: 0 },
    async drive(ctx) {
      await api('/api/remora/s2/config', ctx.ex.config)
      await delay(500)
      await driveApprovalTurn(ctx, 'e3c-prompt')
    },
  },
  {
    id: 'e4',
    description: 'browser answers first → Remora observes next() resolution',
    browser: 'answer',
    mock: 'tool_call_success,success',
    mockExtra: ['--tool-name', 'p0s2_probe', '--tool-arguments', '{"note":"e4"}'],
    config: { mode: 'observe', withdrawal: 'none', answerDelayMs: 0 },
    async drive(ctx) {
      await api('/api/remora/s2/config', ctx.ex.config)
      await delay(500)
      await driveApprovalTurn(ctx, 'e4-prompt')
    },
  },
  {
    id: 'e5',
    description: 'request signal aborted (turn cancelled) → both sides',
    browser: 'passive',
    mock: 'tool_call_success,success',
    mockExtra: ['--tool-name', 'p0s2_probe', '--tool-arguments', '{"note":"e5"}'],
    config: { mode: 'observe', withdrawal: 'none', answerDelayMs: 0 },
    async drive(ctx) {
      await api('/api/remora/s2/config', ctx.ex.config)
      await delay(500)
      const turn = driveApprovalTurn(ctx, 'e5-prompt', { cancelAfterMs: 800 })
      await turn
    },
  },
  {
    id: 'e6',
    description: 'preview: tool call arguments via live Session vs sessionController.inspect',
    browser: null,
    mock: 'tool_call_success,success',
    mockExtra: ['--tool-name', 'p0s2_probe', '--tool-arguments', '{"note":"e6-preview","secret":"not-really"}'],
    config: { mode: 'observe', withdrawal: 'none', answerDelayMs: 0 },
    async drive(ctx) {
      await api('/api/remora/s2/config', ctx.ex.config)
      await driveApprovalTurn(ctx, 'e6-prompt')
      const missing = await api('/api/remora/s2/scenario', { scenario: 'preview-static' })
      return { previewStatic: missing.body }
    },
  },
  {
    id: 'selfcheck',
    description: 'startup self-check: root prepend listener runs first',
    browser: null,
    mock: 'success',
    mockExtra: [],
    config: { mode: 'observe', withdrawal: 'none', answerDelayMs: 0 },
    async drive(ctx) {
      await api('/api/remora/s2/config', ctx.ex.config)
      return api('/api/remora/s2/scenario', { scenario: 'selfcheck' })
    },
  },
]

/**
 * Create a session and prompt it so the mock LLM emits a tool call that
 * trips tools/pre-execute → approval/request. Uses the browser-authenticated
 * /api session RPC (client-request envelope).
 */
async function driveApprovalTurn(ctx, label, { cancelAfterMs } = {}) {
  const rpc = async (method, payload) => {
    const rpcId = `${label}-${method}-${Date.now()}`
    const res = await fetch(new URL(`/api/${method}`, BASE), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ctx.cookie ? { cookie: ctx.cookie } : {}),
        ...(ctx.token ? { 'x-dsh-launch-token': ctx.token } : {}),
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method,
        payload: { args: payload },
      }),
    })
    const text = await res.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
    return { status: res.status, body: parsed }
  }

  // Prefer token-in-query auth for the first API call if we have no cookie yet.
  const rpcWithToken = async (method, payload) => {
    if (ctx.token) {
      const rpcId = `${label}-${method}-${Date.now()}`
      const url = new URL(`/api/${method}`, BASE)
      // Session RPC uses cookie auth; obtain cookie once.
      if (!ctx.cookie) {
        const authUrl = new URL(BASE)
        authUrl.pathname = '/'
        authUrl.searchParams.set('token', ctx.token)
        const authRes = await fetch(authUrl, { redirect: 'manual' })
        const setCookie = authRes.headers.getSetCookie?.() ?? []
        ctx.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
      }
    }
    return rpc(method, payload)
  }

  // Strict Typert descriptors wrap business params under wire field "request".
  const create = await rpcWithToken('session/create', {
    request: {
      cwd: spikeRoot,
      sessionId: `session-p0s2-${label}-${Date.now()}`,
    },
  })
  if (create.status !== 200 || create.body?.result?.ok === false) {
    log(`session/create failed: ${create.status} ${JSON.stringify(create.body).slice(0, 300)}`)
    return create
  }
  const sessionId = create.body?.result?.value?.sessionId
    ?? extractSessionId(create.body)
  log(`session ${sessionId}`)

  if (cancelAfterMs) {
    delay(cancelAfterMs).then(() => {
      void rpcWithToken('session/cancel', { request: { sessionId } }).then(
        (r) => log(`session/cancel → ${r.status}`),
        (e) => log(`session/cancel error ${e}`),
      )
    })
  }

  const prompt = await rpcWithToken('session/prompt', {
    request: {
      requestId: `p0s2-${label}-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Call the tool p0s2_probe with note "probe", then stop.' }],
    },
  })
  log(`session/prompt → ${prompt.status}`)
  return { sessionId, create, prompt }
}

function extractSessionId(body) {
  const walk = (value) => {
    if (!value || typeof value !== 'object') return null
    if (typeof value.sessionId === 'string') return value.sessionId
    for (const v of Object.values(value)) {
      const found = walk(v)
      if (found) return found
    }
    return null
  }
  return walk(body)
}

function killPortListeners(port) {
  if (process.platform !== 'win32') return
  const out = runCapture('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
  ])
  const pids = out.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
  for (const pid of pids) {
    runCapture('taskkill', ['/F', '/T', '/PID', pid])
  }
  if (pids.length > 0) log(`killed stale pid(s) on :${port}: ${pids.join(', ')}`)
  return pids.length
}

function countPortListeners(port) {
  const out = runCapture('powershell', [
    '-NoProfile',
    '-Command',
    `$c = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue); $c.Count`,
  ])
  const text = out.stdout.trim()
  const n = Number.parseInt(text.split(/\r?\n/).pop() ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

async function waitForPortFree(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let killed = 0
  let freeStreak = 0
  while (Date.now() < deadline) {
    if (process.platform === 'win32') {
      const count = countPortListeners(port)
      if (count === 0) {
        freeStreak += 1
        // Two consecutive free samples — a just-killed child can reappear once.
        if (freeStreak >= 2) return
      } else {
        freeStreak = 0
        killed += killPortListeners(port)
      }
    } else {
      try {
        await fetch(new URL(`http://127.0.0.1:${port}/`), { signal: AbortSignal.timeout(300) })
        // Something answered — still bound.
      } catch {
        return
      }
    }
    await delay(300)
  }
  throw new Error(`port ${port} still bound after cleanup (kills=${killed})`)
}

async function waitForDsh(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL('/api/remora/s2/config', BASE))
      // 401 = route mounted behind browser auth; 200 = answered with cookie.
      if (res.ok || res.status === 401) return res.status
    } catch { /* not up */ }
    await delay(400)
  }
  throw new Error('dsh did not become ready (control route never answered)')
}

async function waitForToken(dsh, timeoutMs = 20000) {
  const token = await waitFor(() => extractToken(dsh.stdout()), {
    timeoutMs,
    label: 'dsh web URL',
  }).catch(() => null)
  if (!token) {
    throw new Error(`dsh never printed a launch token (stdout so far: ${JSON.stringify(dsh.stdout().slice(0, 400))})`)
  }
  return token
}

async function runOne(ex, pass) {
  const runId = `${ex.id}-pass${pass}`
  const runDir = join(runsRoot, runId)
  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true })
  authCookie = ''
  log(`=== ${runId}: ${ex.description}`)

  // A prior dsh (or a shell-wrapped child that survived taskkill) can keep
  // :7718 bound; the next dsh would fail to bind while waitForDsh talks to the
  // zombie. Free the port first.
  killPortListeners(PORT)
  await waitForPortFree(PORT)

  const mock = startMock(ex.mock, ex.mockExtra)
  await delay(700)

  const dsh = startDsh(runDir)
  let browser = null
  const summary = { experiment: ex.id, pass, description: ex.description, startedAt: new Date().toISOString() }

  try {
    await waitForDsh()
    const token = await waitForToken(dsh)
    summary.tokenPresent = true

    // Obtain a cookie for session + control routes.
    const ctx = { token, cookie: '', ex }
    if (token) {
      const authUrl = new URL(BASE)
      authUrl.pathname = '/'
      authUrl.searchParams.set('token', token)
      const authRes = await fetch(authUrl, { redirect: 'manual' })
      const setCookie = authRes.headers.getSetCookie?.() ?? []
      ctx.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
      authCookie = ctx.cookie
      summary.cookiePresent = Boolean(ctx.cookie)
      if (!ctx.cookie) throw new Error(`token exchange yielded no cookie (status ${authRes.status})`)
    }

    if (ex.browser && token) {
      browser = startBrowser(token, runDir, ex.browser, 25000)
      await delay(800)
    }

    const driveResult = await ex.drive(ctx)
    summary.drive = driveResult ?? null
    if (driveResult?.status !== undefined && driveResult.status >= 400) {
      throw new Error(`drive returned HTTP ${driveResult.status}: ${JSON.stringify(driveResult.body).slice(0, 300)}`)
    }

    // Observe-mode next() can park until nextTimeoutMs (4s default) when the
    // Gateway has zero clients or a passive browser never answers — wait past
    // that so approval/next-resolved lands in events.jsonl before teardown.
    await delay(6000)

    const logRes = await api('/api/remora/s2/log')
    summary.controlLogLines = logRes.body?.lines?.length ?? 0
    writeFileSync(join(runDir, 'control-log.json'), JSON.stringify(logRes.body, null, 2))

    if (browser) {
      // browser-client writes frames on SIGTERM; give it a moment before force-kill.
      browser.child.kill('SIGTERM')
      await delay(800)
      if (browser.child.exitCode === null) browser.child.kill('SIGKILL')
      summary.browserOutput = browser.lines().slice(0, 8000)
    }

    summary.dshStdout = dsh.stdout().slice(0, 12000)
    summary.dshStderr = dsh.stderr().slice(0, 8000)
    summary.finishedAt = new Date().toISOString()
    summary.ok = true
  } catch (error) {
    summary.ok = false
    summary.error = error instanceof Error ? error.message : String(error)
    summary.dshStdout = dsh.stdout().slice(0, 12000)
    summary.dshStderr = dsh.stderr().slice(0, 8000)
    if (browser) {
      summary.browserOutput = browser.lines().slice(0, 8000)
      browser.child.kill('SIGKILL')
    }
  } finally {
    await stopAll(browser, dsh, mock)
  }

  writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  log(`=== ${runId} ${summary.ok ? 'OK' : `FAIL: ${summary.error}`}`)
  return summary
}

async function main() {
  if (!existsSync(dshBin)) {
    console.error('dsh not installed — run: node scripts/setup.mjs')
    process.exit(1)
  }
  mkdirSync(runsRoot, { recursive: true })

  const selected = only
    ? experiments.filter((e) => e.id === only || e.id.startsWith(`${only}`))
    : experiments
  if (selected.length === 0) {
    console.error(`no experiment matches --only ${only}`)
    process.exit(1)
  }

  const results = []
  for (const ex of selected) {
    for (let pass = 1; pass <= PASSES; pass += 1) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await runOne(ex, pass))
    }
  }

  const failed = results.filter((r) => !r.ok)
  writeFileSync(join(runsRoot, 'index.json'), `${JSON.stringify(results, null, 2)}\n`)
  log(`done: ${results.length - failed.length}/${results.length} runs ok`)
  if (failed.length > 0) {
    for (const f of failed) log(`FAIL ${f.experiment}-pass${f.pass}: ${f.error}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

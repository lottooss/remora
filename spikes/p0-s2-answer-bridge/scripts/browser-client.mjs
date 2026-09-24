/**
 * Scripted "browser" for P0-S2: cookie-authenticated /api/remote.mux client
 * that opens the $events stream and records waterfall / cancel frames.
 *
 * Uses the `ws` package (not global WebSocket) so the Cookie header can be
 * sent on the HTTP upgrade — the Host rejects unauthenticated mux upgrades.
 *
 * Modes:
 *   passive  — receive only (never answer)
 *   answer   — immediately answer approval with allowed-once / question with phone
 *   next     — immediately delegate with kind:next
 *   late     — wait `--late-ms` then answer
 *
 * Usage:
 *   node scripts/browser-client.mjs --url http://127.0.0.1:7718 --token <launch> \
 *     --mode passive --out out/browser-e1.json --duration-ms 20000
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '..', '.install', 'package.json'))
const WebSocket = require('ws')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1]
}

const baseUrl = arg('url', 'http://127.0.0.1:7718')
const token = arg('token', '')
const mode = arg('mode', 'passive')
const outPath = arg('out', '')
const durationMs = Number(arg('duration-ms', '20000'))
const lateMs = Number(arg('late-ms', '5000'))

if (!token) {
  console.error('browser-client: --token is required (from `dsh web:` URL)')
  process.exit(2)
}

const frames = []
const record = (frame) => {
  frames.push({ t: Date.now(), ...frame })
  console.log('[browser]', JSON.stringify(frame))
}

// 1) Exchange launch token for the signed session cookie.
const authUrl = new URL(baseUrl)
authUrl.pathname = '/'
authUrl.search = ''
authUrl.searchParams.set('token', token)
const authRes = await fetch(authUrl, { redirect: 'manual' })
const setCookie = authRes.headers.getSetCookie?.() ?? (
  authRes.headers.get('set-cookie') ? [authRes.headers.get('set-cookie')] : []
)
if (setCookie.length === 0) {
  console.error('browser-client: no Set-Cookie from token exchange', authRes.status)
  process.exit(1)
}
const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
record({ kind: 'auth', status: authRes.status, cookieNames: setCookie.map((c) => c.split('=')[0]) })

// 2) Open /api/remote.mux and the $events logical stream.
// Cookie must ride the upgrade request; global WebSocket cannot set headers.
const wsUrl = new URL('/api/remote.mux', baseUrl)
wsUrl.protocol = baseUrl.startsWith('https') ? 'wss:' : 'ws:'
const ws = new WebSocket(wsUrl, { headers: { cookie } })
ws.on('open', () => {
  record({ kind: 'ws-open' })
  ws.send(JSON.stringify({
    type: 'open',
    streamId: 's2-events',
    endpoint: '$events',
    payload: { args: {} },
  }))
})
ws.on('error', (event) => {
  record({ kind: 'ws-error', message: String(event?.message ?? event) })
})
ws.on('close', (event) => {
  record({ kind: 'ws-close', code: event, reason: '' })
})

let clientId

const answerResult = async (eventId, outcome) => {
  const rpcId = `s2-${eventId}-${Date.now()}`
  const body = JSON.stringify({
    type: 'client-request',
    rpcId,
    method: '$events/result',
    payload: {
      args: { clientId, eventId, outcome },
    },
  })
  const res = await fetch(new URL('/api/$events/result', baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body,
  })
  const text = await res.text()
  record({ kind: 'answer-post', eventId, status: res.status, body: text.slice(0, 400) })
}

ws.on('message', async (event) => {
  let frame
  try {
    frame = JSON.parse(String(event))
  } catch {
    record({ kind: 'bad-json', raw: String(event).slice(0, 200) })
    return
  }

  if (frame.type !== 'item') {
    record({ kind: 'server', ...frame })
    return
  }
  const value = frame.value
  if (value?.type === 'ready') {
    clientId = value.clientId
    record({ kind: 'ready', clientId, host: value.host })
    return
  }
  if (value?.type === 'cancel') {
    record({ kind: 'cancel', eventId: value.eventId })
    return
  }
  if (value?.type === 'emit') {
    record({ kind: 'emit', event: value.event })
    return
  }
  if (value?.type === 'waterfall') {
    record({
      kind: 'waterfall',
      event: value.event,
      eventId: value.eventId,
      agentId: value.agentId,
      requestKeys: Object.keys(value.request ?? {}),
      toolName: value.request?.toolName ?? null,
      questionCount: value.request?.questions?.length ?? null,
    })
    if (mode === 'passive') return
    if (mode === 'next') {
      await answerResult(value.eventId, { kind: 'next' })
      return
    }
    if (mode === 'late') {
      await delay(lateMs)
    }
    if (value.event === 'approval/request') {
      await answerResult(value.eventId, { kind: 'result', value: 'allowed-once' })
    } else if (value.event === 'user-questions/request') {
      const answers = (value.request?.questions ?? []).map((q) => ({
        id: q.id,
        selected: ['browser'],
      }))
      await answerResult(value.eventId, { kind: 'result', value: { answers } })
    } else {
      await answerResult(value.eventId, { kind: 'next' })
    }
    return
  }
  record({ kind: 'unknown-item', value })
})

const shutdown = (reason) => {
  if (shutdown.done) return
  shutdown.done = true
  record({ kind: 'shutdown', reason, frameCount: frames.length })
  if (outPath) {
    writeFileSync(outPath, `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`)
    console.log(`[browser] wrote ${frames.length} frames → ${outPath}`)
  }
  try { ws.close(1000, 'done') } catch { /* already closed */ }
  process.exit(0)
}

process.on('SIGINT', () => shutdown('sigint'))
process.on('SIGTERM', () => shutdown('sigterm'))
process.on('exit', () => {
  if (!shutdown.done && outPath) {
    try {
      writeFileSync(outPath, `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`)
    } catch { /* best-effort */ }
  }
})
await delay(durationMs)
shutdown('duration')

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  createInitiatorHandshake,
  derivePairPsk,
  deriveSasCode,
  encodeBase32,
  encodeBase64Url,
  generateKeypair,
  getRelayPublicKey,
  randomBytes,
  utf8ToBytes,
} from '@remora/crypto'
import { InMemoryDeviceRegistry } from '../src/devices/index.ts'
import { createHostIdentity, type HostIdentity } from '../src/identity/index.ts'
import { PairingService, type PairingAttempt } from '../src/pairing/index.ts'
import { printTerminalQr, type ManagementPairingService, type TerminalQrStream } from '../src/web/index.ts'
import {
  registerManagementRoutes,
  type ManagementConnection,
  type ManagementFetchRoute,
  type ManagementRouteDeps,
  type ManagementWebServer,
} from '../src/web/routes.ts'

const HOST = '127.0.0.1:7717'
const SAME_ORIGIN = 'http://127.0.0.1:7717'
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
const VALID_DEVICE_ID = `d_${'a'.repeat(26)}`

/** One exact-path route as the alias registration received it. */
type WebRouteRegistration = Parameters<ManagementWebServer['register']>[0]

/** Captured `ctx` services and the routes the plugin registered on them. */
interface Harness {
  ctx: Context
  routes: Map<string, ManagementFetchRoute>
  webRoutes: Map<string, WebRouteRegistration>
  /** Runs every effect disposer the plugin registered. */
  dispose: () => Promise<void>
}

interface HarnessOptions {
  /** Answer Connection's trust fence would give for the alias route. */
  rejection?: 401 | 403 | undefined
}

function createHarness(options: HarnessOptions = {}): Harness {
  const routes = new Map<string, ManagementFetchRoute>()
  const webRoutes = new Map<string, WebRouteRegistration>()
  const disposers: Array<() => unknown> = []

  const connection: ManagementConnection = {
    fetch: {
      register: (route) => {
        routes.set(route.path, route)
        return async () => {
          routes.delete(route.path)
        }
      },
    },
    requestRejection: () => options.rejection,
  }
  const webServer: ManagementWebServer = {
    register: (route) => {
      webRoutes.set(route.path, route)
      return () => {
        webRoutes.delete(route.path)
      }
    },
  }

  const logger = {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  }
  const inner = {
    get: (name: string): unknown => (name === 'connection' ? connection : name === 'webServer' ? webServer : undefined),
    effect: (factory: () => unknown): unknown => {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer as () => unknown)
      return disposer
    },
    logger,
  }
  const ctx = {
    inject: (_deps: unknown, callback: (serviceCtx: unknown) => void): void => {
      callback(inner)
    },
    logger,
  } as unknown as Context

  return {
    ctx,
    routes,
    webRoutes,
    dispose: async () => {
      await Promise.all(disposers.splice(0).map((disposer) => disposer()))
    },
  }
}

/** Route state plus the terminal sink the routes write the QR to. */
interface RouteState {
  deps: ManagementRouteDeps
  pairingService: PairingService
  registry: InMemoryDeviceRegistry
  identity: HostIdentity
  terminal: { isTTY: boolean; chunks: string[] }
  /** Records device ids the route asked the relay to revoke. */
  revokedOnRelay: string[]
}

interface StateOptions {
  isTTY?: boolean
  relayRevokeError?: boolean
}

function createState(options: StateOptions = {}): RouteState {
  const identity = createHostIdentity()
  const registry = new InMemoryDeviceRegistry()
  const pairingService = new PairingService({
    identity,
    hostName: 'TestHost',
    relayOrigin: 'https://relay.test',
    registry,
    sendFrame: () => {},
  })
  const terminal = { isTTY: options.isTTY ?? true, chunks: [] as string[] }
  const stdout: TerminalQrStream = {
    get isTTY(): boolean {
      return terminal.isTTY
    },
    write: (chunk: string): boolean => {
      terminal.chunks.push(chunk)
      return true
    },
  }
  const revokedOnRelay: string[] = []
  const deps: ManagementRouteDeps = {
    pairingService,
    registry,
    relayConnection: { isConnected: false, status: 'idle' },
    identity: { hostId: identity.hostId },
    hostName: 'TestHost',
    terminalStdout: stdout,
    revokeEndpointOnRelay: async (deviceId: string) => {
      if (options.relayRevokeError === true) {
        throw new Error('relay unreachable')
      }
      revokedOnRelay.push(deviceId)
    },
  }
  return { deps, pairingService, registry, identity, terminal, revokedOnRelay }
}

function addPairedDevice(registry: InMemoryDeviceRegistry, deviceId = VALID_DEVICE_ID, name = 'Pixel 8'): void {
  registry.addDevice({
    deviceId,
    name,
    noisePublicKey: randomBytes(32),
    devicePsk: randomBytes(32),
    pushKey: randomBytes(32),
    createdAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    revoked: false,
  })
}

function routeOf(harness: Harness, path: string): ManagementFetchRoute {
  const route = harness.routes.get(path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  return route
}

async function get(harness: Harness, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return await routeOf(harness, path).fetch(
    new Request(`http://dsh.internal${path}`, {
      method: 'GET',
      headers: { host: HOST, accept: BROWSER_ACCEPT, ...headers },
    }),
  )
}

async function post(
  harness: Harness,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { host: HOST, origin: SAME_ORIGIN, ...options.headers }
  const init: RequestInit = { method: 'POST', headers }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  return await routeOf(harness, path).fetch(new Request(`http://dsh.internal${path}`, init))
}

/** Runs the device half of the pairing handshake so SAS confirmation is reachable. */
async function driveHandshake(
  pairingService: PairingService,
  identity: HostIdentity,
  attempt: PairingAttempt,
): Promise<{ deviceId: string; sas: string }> {
  const deviceRelaySeed = randomBytes(32)
  const deviceRelayKey = { privateKey: deviceRelaySeed, publicKey: getRelayPublicKey(deviceRelaySeed) }
  const deviceNoiseKey = generateKeypair()
  const deviceId = `d_${encodeBase32(deviceRelayKey.publicKey.subarray(0, 16))}`
  const peerRawId = deviceRelayKey.publicKey.subarray(0, 16)

  const ticketId = `t_${encodeBase32(attempt.ticket.subarray(0, 16))}`
  const pairPsk = derivePairPsk(attempt.pairingSecret, ticketId)
  const prologue = utf8ToBytes(`remora/1\x00pair\x00${identity.hostId}\x00${deviceId}`)
  const initiator = createInitiatorHandshake({
    staticKey: deviceNoiseKey.privateKey,
    remoteStaticKey: identity.noiseKeypair.publicKey,
    psk: pairPsk,
    prologue,
  })
  const msg1 = initiator.writeMessage(
    utf8ToBytes(
      JSON.stringify({
        v: 1,
        purpose: 'pair',
        deviceId,
        relayPub: encodeBase64Url(deviceRelayKey.publicKey),
        name: 'Pixel 8',
      }),
    ),
  )

  const handled = await pairingService.handlePairingHandshake(deviceId, 7, peerRawId, msg1)
  expect(handled).toBe(true)
  const sas = deriveSasCode(identity.noiseKeypair.publicKey, deviceNoiseKey.publicKey, pairPsk)
  expect(attempt.sasCode).toBe(sas)
  return { deviceId, sas }
}

/** The open attempt, or a hard failure when the test has lost it. */
function openAttempt(state: RouteState): PairingAttempt {
  const attempt = state.pairingService.getActiveAttempt()
  if (attempt === null) throw new Error('no active pairing attempt')
  return attempt
}

interface FakeResponseState {
  status: number
  headers: Record<string, string>
  body: string
  ended: boolean
}

function createFakeResponse(): { res: ServerResponse; state: FakeResponseState } {
  const state: FakeResponseState = { status: 0, headers: {}, body: '', ended: false }
  const res = {
    writeHead: (status: number, headers: Record<string, string> = {}): void => {
      state.status = status
      state.headers = headers
    },
    end: (chunk?: string): void => {
      if (chunk !== undefined) state.body = chunk
      state.ended = true
    },
  }
  return { res: res as unknown as ServerResponse, state }
}

describe('P2-H1: management page routes', () => {
  it('registers the dashboard, action, and alias routes and removes them on disposal', async () => {
    const harness = createHarness()
    const state = createState()
    registerManagementRoutes(harness.ctx, state.deps)

    expect([...harness.routes.keys()].sort()).toEqual([
      '/api/remora',
      '/api/remora/devices/revoke',
      '/api/remora/devices/rotation/confirm',
      '/api/remora/devices/rotation/reject',
      '/api/remora/pair/confirm',
      '/api/remora/pair/reject',
      '/api/remora/pair/start',
    ])
    expect(routeOf(harness, '/api/remora').methods).toEqual(['GET', 'HEAD'])
    expect(routeOf(harness, '/api/remora/pair/start').methods).toEqual(['POST'])
    expect(routeOf(harness, '/api/remora').requestBody).toBe('buffered')

    const alias = harness.webRoutes.get('/api/remora/')
    expect(alias?.kind).toBe('exact')

    await harness.dispose()
    expect(harness.routes.size).toBe(0)
    expect(harness.webRoutes.size).toBe(0)
  })

  it('serves the self-contained page to a browser navigation', async () => {
    const harness = createHarness()
    registerManagementRoutes(harness.ctx, createState().deps)

    const response = await get(harness, '/api/remora')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')

    const html = await response.text()
    expect(html).toContain('Remora Host Management')
    expect(html).toContain('No devices paired yet')
    expect(html).toContain('startPairing()')
    expect(html).toContain('/api/remora/pair/start')
    expect(html).toContain('<style>')
    // Self-contained: no external stylesheets, scripts, or images, and the QR
    // payload never appears as text (it is drawn as SVG paths only).
    expect(html).not.toContain('<link')
    expect(html).not.toContain('src="http')
    expect(html).not.toContain('remora://pair')
  })

  it('escapes device names in the page markup', async () => {
    const harness = createHarness()
    const state = createState()
    addPairedDevice(state.registry, VALID_DEVICE_ID, '<img src=x onerror=alert(1)>')
    registerManagementRoutes(harness.ctx, state.deps)

    const html = await (await get(harness, '/api/remora')).text()
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
  })

  it('serves machine-readable state as JSON without the QR payload', async () => {
    const harness = createHarness()
    const state = createState()
    addPairedDevice(state.registry, VALID_DEVICE_ID, 'Pixel 8')
    registerManagementRoutes(harness.ctx, state.deps)

    const response = await get(harness, '/api/remora', { accept: 'application/json' })
    expect(response.status).toBe(200)
    const text = await response.text()
    const payload = JSON.parse(text) as {
      hostId: string
      hostName: string
      relay: { status: string; connected: boolean }
      devices: Array<{ deviceId: string; revoked: boolean }>
      pairing: unknown
    }
    expect(payload.hostId).toBe(state.identity.hostId)
    expect(payload.hostName).toBe('TestHost')
    expect(payload.relay).toEqual({ status: 'idle', connected: false })
    expect(payload.devices).toHaveLength(1)
    expect(payload.devices[0]).toMatchObject({ deviceId: VALID_DEVICE_ID, revoked: false })
    expect(payload.pairing).toBeNull()
    expect(text).not.toContain('remora://pair')
  })

  it('answers HEAD on the dashboard route', async () => {
    const harness = createHarness()
    registerManagementRoutes(harness.ctx, createState().deps)

    const response = await routeOf(harness, '/api/remora').fetch(
      new Request('http://dsh.internal/api/remora', { method: 'HEAD', headers: { host: HOST } }),
    )
    expect(response.status).toBe(200)
  })

  it('refuses a cross-origin request before acting on it', async () => {
    const harness = createHarness()
    const state = createState()
    registerManagementRoutes(harness.ctx, state.deps)

    const crossOrigin = await post(harness, '/api/remora/pair/start', {
      headers: { origin: 'http://evil.example' },
    })
    expect(crossOrigin.status).toBe(403)
    expect((await crossOrigin.json()) as { error: string }).toEqual({ error: 'cross-origin' })
    expect(state.pairingService.hasActiveAttempt()).toBe(false)

    const crossSite = await post(harness, '/api/remora/pair/start', {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(crossSite.status).toBe(403)

    const opaqueOrigin = await post(harness, '/api/remora/pair/start', { headers: { origin: 'null' } })
    expect(opaqueOrigin.status).toBe(403)
    expect(state.pairingService.hasActiveAttempt()).toBe(false)

    const control = post(harness, '/api/remora/pair/start')
    expect((await control).status).toBe(200)
    expect(state.pairingService.hasActiveAttempt()).toBe(true)
  })

  it('starts one pairing attempt and prints the terminal QR only when unpaired', async () => {
    const harness = createHarness()
    const state = createState({ isTTY: true })
    registerManagementRoutes(harness.ctx, state.deps)

    const started = await post(harness, '/api/remora/pair/start')
    expect(started.status).toBe(200)
    expect((await started.json()) as { ok: boolean }).toEqual({ ok: true })
    const attempt = state.pairingService.getActiveAttempt()
    expect(attempt).not.toBeNull()
    expect(attempt?.qrPayload).toContain('remora://pair?')
    expect(state.terminal.chunks.join('')).toContain('Scan this QR code with Remora on Android')
    const printedChunks = state.terminal.chunks.length
    expect(printedChunks).toBeGreaterThan(0)

    const again = await post(harness, '/api/remora/pair/start')
    expect(again.status).toBe(409)
    expect((await again.json()) as { error: string }).toEqual({ error: 'pairing-in-progress' })
    expect(state.pairingService.getActiveAttempt()).toBe(attempt)
    expect(state.terminal.chunks).toHaveLength(printedChunks)
  })

  it('suppresses the terminal QR without a TTY or with a paired device', async () => {
    const headless = createHarness()
    const headlessState = createState({ isTTY: false })
    registerManagementRoutes(headless.ctx, headlessState.deps)
    expect((await post(headless, '/api/remora/pair/start')).status).toBe(200)
    expect(headlessState.terminal.chunks).toHaveLength(0)
    await headless.dispose()

    const paired = createHarness()
    const pairedState = createState({ isTTY: true })
    addPairedDevice(pairedState.registry)
    registerManagementRoutes(paired.ctx, pairedState.deps)
    expect((await post(paired, '/api/remora/pair/start')).status).toBe(200)
    expect(pairedState.terminal.chunks).toHaveLength(0)
  })

  it('shows the QR only while the attempt awaits a handshake', async () => {
    const harness = createHarness()
    const state = createState()
    registerManagementRoutes(harness.ctx, state.deps)

    await post(harness, '/api/remora/pair/start')
    const withQr = await (await get(harness, '/api/remora')).text()
    expect(withQr).toContain('Scan to Pair Device')
    expect(withQr).toContain('<svg')

    const { sas } = await driveHandshake(state.pairingService, state.identity, openAttempt(state))

    const withSas = await (await get(harness, '/api/remora')).text()
    expect(withSas).toContain('Confirm Pairing SAS Code')
    expect(withSas).toContain(`${sas.slice(0, 3)} ${sas.slice(3)}`)
    expect(withSas).not.toContain('<svg')
    expect(withSas).not.toContain('remora://pair')
  })

  it('confirms pairing only with the displayed six-digit SAS', async () => {
    const harness = createHarness()
    const state = createState()
    registerManagementRoutes(harness.ctx, state.deps)

    const beforeStart = await post(harness, '/api/remora/pair/confirm', { body: { sas: '123456' } })
    expect(beforeStart.status).toBe(409)
    expect((await beforeStart.json()) as { error: string }).toEqual({ error: 'no-active-pairing' })

    await post(harness, '/api/remora/pair/start')
    const { deviceId, sas } = await driveHandshake(
      state.pairingService,
      state.identity,
      openAttempt(state),
    )

    const malformed = await post(harness, '/api/remora/pair/confirm', { body: { sas: '1234' } })
    expect(malformed.status).toBe(400)
    expect((await malformed.json()) as { error: string }).toEqual({ error: 'invalid-sas' })

    const wrong = sas === '000000' ? '111111' : '000000'
    const mismatch = await post(harness, '/api/remora/pair/confirm', { body: { sas: wrong } })
    expect(mismatch.status).toBe(400)
    expect((await mismatch.json()) as { error: string }).toEqual({ error: 'sas-mismatch' })
    expect(state.registry.getDeviceById(deviceId)).toBeNull()

    const confirmed = await post(harness, '/api/remora/pair/confirm', { body: { sas } })
    expect(confirmed.status).toBe(200)
    expect(state.registry.getDeviceById(deviceId)).not.toBeNull()

    const again = await post(harness, '/api/remora/pair/confirm', { body: { sas } })
    expect(again.status).toBe(409)
  })

  it('rejects an open attempt once and treats later rejections as done', async () => {
    const harness = createHarness()
    const state = createState()
    registerManagementRoutes(harness.ctx, state.deps)

    const idle = await post(harness, '/api/remora/pair/reject')
    expect(idle.status).toBe(200)
    expect((await idle.json()) as { rejected: boolean }).toEqual({ ok: true, rejected: false })

    await post(harness, '/api/remora/pair/start')
    const rejected = await post(harness, '/api/remora/pair/reject')
    expect(rejected.status).toBe(200)
    expect((await rejected.json()) as { rejected: boolean }).toEqual({ ok: true, rejected: true })
    expect(state.pairingService.hasActiveAttempt()).toBe(false)

    const again = await post(harness, '/api/remora/pair/reject')
    expect((await again.json()) as { rejected: boolean }).toEqual({ ok: true, rejected: false })
  })

  it('validates, revokes, and reports devices to the relay', async () => {
    const harness = createHarness()
    const state = createState()
    addPairedDevice(state.registry)
    registerManagementRoutes(harness.ctx, state.deps)

    const malformed = await post(harness, '/api/remora/devices/revoke', { body: { deviceId: 'd_short' } })
    expect(malformed.status).toBe(400)
    expect((await malformed.json()) as { error: string }).toEqual({ error: 'invalid-device-id' })

    const unknown = await post(harness, '/api/remora/devices/revoke', { body: { deviceId: `d_${'b'.repeat(26)}` } })
    expect(unknown.status).toBe(404)
    expect((await unknown.json()) as { error: string }).toEqual({ error: 'unknown-device' })

    const revoked = await post(harness, '/api/remora/devices/revoke', { body: { deviceId: VALID_DEVICE_ID } })
    expect(revoked.status).toBe(200)
    expect(state.registry.getDeviceById(VALID_DEVICE_ID)?.revoked).toBe(true)
    expect(state.revokedOnRelay).toEqual([VALID_DEVICE_ID])

    const again = await post(harness, '/api/remora/devices/revoke', { body: { deviceId: VALID_DEVICE_ID } })
    expect(again.status).toBe(409)
    expect((await again.json()) as { error: string }).toEqual({ error: 'already-revoked' })
  })

  it('reports a relay revoke failure after the local revoke already landed', async () => {
    const harness = createHarness()
    const state = createState({ relayRevokeError: true })
    addPairedDevice(state.registry)
    registerManagementRoutes(harness.ctx, state.deps)

    const response = await post(harness, '/api/remora/devices/revoke', { body: { deviceId: VALID_DEVICE_ID } })
    expect(response.status).toBe(502)
    expect((await response.json()) as { error: string }).toEqual({ error: 'relay-revoke-failed' })
    expect(state.registry.getDeviceById(VALID_DEVICE_ID)?.revoked).toBe(true)
    expect(state.revokedOnRelay).toEqual([])
  })

  it('bounds and parses action bodies', async () => {
    const harness = createHarness()
    const state = createState()
    registerManagementRoutes(harness.ctx, state.deps)

    const oversized = await routeOf(harness, '/api/remora/pair/confirm').fetch(
      new Request('http://dsh.internal/api/remora/pair/confirm', {
        method: 'POST',
        headers: { host: HOST, origin: SAME_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ sas: '123456', filler: 'x'.repeat(9000) }),
      }),
    )
    expect(oversized.status).toBe(413)
    expect((await oversized.json()) as { error: string }).toEqual({ error: 'body-too-large' })

    const broken = await routeOf(harness, '/api/remora/pair/confirm').fetch(
      new Request('http://dsh.internal/api/remora/pair/confirm', {
        method: 'POST',
        headers: { host: HOST, origin: SAME_ORIGIN, 'content-type': 'application/json' },
        body: 'not json',
      }),
    )
    expect(broken.status).toBe(400)
    expect((await broken.json()) as { error: string }).toEqual({ error: 'invalid-json' })

    const empty = await post(harness, '/api/remora/pair/confirm')
    expect(empty.status).toBe(400)
    expect((await empty.json()) as { error: string }).toEqual({ error: 'invalid-sas' })

    const formEncoded = await routeOf(harness, '/api/remora/pair/confirm').fetch(
      new Request('http://dsh.internal/api/remora/pair/confirm', {
        method: 'POST',
        headers: { host: HOST, origin: SAME_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'sas=123456',
      }),
    )
    expect(formEncoded.status).toBe(409)
    expect((await formEncoded.json()) as { error: string }).toEqual({ error: 'no-active-pairing' })
    expect(state.pairingService.hasActiveAttempt()).toBe(false)
  })

  it('redirects the trailing-slash alias only after Connection accepts the request', async () => {
    const harness = createHarness()
    registerManagementRoutes(harness.ctx, createState().deps)
    const alias = harness.webRoutes.get('/api/remora/')
    if (alias === undefined) throw new Error('alias route not registered')

    const accepted = createFakeResponse()
    alias.handler({ headers: { host: HOST } } as unknown as IncomingMessage, accepted.res)
    expect(accepted.state.status).toBe(303)
    expect(accepted.state.headers.location).toBe('/api/remora')
    expect(accepted.state.ended).toBe(true)
  })

  it('answers the trailing-slash alias with the trust-fence status when refused', async () => {
    const harness = createHarness({ rejection: 403 })
    registerManagementRoutes(harness.ctx, createState().deps)
    const alias = harness.webRoutes.get('/api/remora/')
    if (alias === undefined) throw new Error('alias route not registered')

    const refused = createFakeResponse()
    alias.handler({ headers: { host: HOST } } as unknown as IncomingMessage, refused.res)
    expect(refused.state.status).toBe(403)
    expect(refused.state.body).toBe('forbidden')
    expect(refused.state.headers.location).toBeUndefined()
  })

  it('reports a failed pairing start instead of leaking the error', async () => {
    const harness = createHarness()
    const state = createState()
    const brokenPairing: ManagementPairingService = {
      getActiveAttempt: () => null,
      hasActiveAttempt: () => false,
      beginPairing: () => Promise.reject(new Error('relay ticket unavailable')),
      confirmPairing: () => Promise.resolve(false),
      rejectPairing: () => Promise.resolve(),
    }
    registerManagementRoutes(harness.ctx, { ...state.deps, pairingService: brokenPairing })

    const response = await post(harness, '/api/remora/pair/start')
    expect(response.status).toBe(500)
    expect((await response.json()) as { error: string }).toEqual({ error: 'internal-error' })
  })
})

describe('P2-H1: terminal QR', () => {
  it('prints only when a TTY is attached and no device is paired', async () => {
    const chunks: string[] = []
    const write = (chunk: string): boolean => {
      chunks.push(chunk)
      return true
    }
    const tty: TerminalQrStream = { isTTY: true, write }

    const printed = await printTerminalQr('remora://pair?v=1&h=h_1', {
      pairedDeviceCount: 0,
      stdout: tty,
    })
    expect(printed).toBe(true)
    expect(chunks.join('')).toContain('Scan this QR code with Remora on Android')

    chunks.length = 0
    expect(await printTerminalQr('remora://pair?v=1&h=h_1', { pairedDeviceCount: 1, stdout: tty })).toBe(false)
    expect(await printTerminalQr('', { pairedDeviceCount: 0, stdout: tty })).toBe(false)
    expect(chunks).toHaveLength(0)

    const pipe: TerminalQrStream = { isTTY: false, write }
    expect(await printTerminalQr('remora://pair?v=1&h=h_1', { pairedDeviceCount: 0, stdout: pipe })).toBe(false)
    expect(chunks).toHaveLength(0)
  })
})

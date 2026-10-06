/**
 * P7-H1 `apply()` harness (docs/tasks/P7-H1.md): the real host plugin is
 * mounted through `ctx.plugin(...)` on a real `@deepseek-ai/cordis` root
 * Context. Only the dsh side of the boundary is faked (test/support/dsh-fakes.ts),
 * provided inside their own plugin fibers the way real dsh provides services;
 * the plugin entry point itself — the unit under test — is real.
 *
 * On main before the fix this fails with Cordis 4's
 * `cannot get property "typertGateway" without inject`, because `apply()`
 * declared `inject: []` and read `(ctx as any).typertGateway`.
 *
 * P7-H3 adds the relay enrollment at startup: the relay side of that boundary
 * is the fake relay of test/relay/fake-relay.ts (a real loopback HTTP and
 * WebSocket server that, like the real relay, refuses to authenticate a host
 * it never enrolled), and the credentials fake gains the seam's reference
 * half (`resolve`) for the enrollment secret.
 *
 * P7-H4 adds device persistence: the plugin loads the paired-device registry
 * and the per-device notify preferences from the dsh credentials record
 * `remora/devices`, so a paired device is still admitted and a revocation
 * still holds after a remount on the same credentials store. The management
 * dashboard route (driven through a fake of dsh's `connection` service) is
 * the observable for what the plugin's registry contains.
 */
import { Context, type Message } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import { decodeBase64Url, deriveEndpointId, encodeBase64Url, getRelayPublicKey, hexToBytes } from '@remora/crypto'
import { afterEach, describe, expect, it } from 'vitest'
import * as host from '../src/index.ts'
import type { ManagementFetchRoute } from '../src/web/routes.ts'
import {
  createFakeCredentials,
  createFakeStorage,
  createFakeTypertGateway,
  provideFakeDshServices,
  reserveClosedPort,
} from './support/dsh-fakes.ts'
import { createValidHostConfig } from './support/host-config.ts'
import { createHostCredentials, type FakeHostCredentials } from './relay/fake-credentials.ts'
import type { FakeGrantRecord } from './identity/fake-credentials.ts'
import { startFakeRelay, type FakeRelay } from './relay/fake-relay.ts'
import { createFixtureSession, createTestAgent, FIXTURE_SESSION_ID, FIXTURE_TURN_END } from './notify/dsh-test-events.ts'
import { createApprovalJournalAgent } from './interaction/approval-journal.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    'remora-rcp-server'?: host.RcpServer
  }
}

/**
 * Cordis fiber lifecycle states. The upstream `FiberState` is an ambient const
 * enum, whose members cannot be imported with `isolatedModules` enabled, so the
 * values are mirrored here (fiber.d.ts of @deepseek-ai/cordis 4.0.2).
 */
const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

/** The credentials key the profile config names (`enrollSecretKey`). */
const SECRET_KEY = 'REMORA_RELAY_ENROLL_SECRET'
/** Obviously fake test secret (AGENTS.md §10). */
const SECRET = 'test-enroll-secret-not-real-0123456789'
/** The credentials record remembering a successful enrollment (P7-H3). */
const ENROLLMENT_RECORD_KEY = 'remora/relay-enrollment'
/** The credentials record holding the paired devices and their prefs (P7-H4). */
const DEVICES_RECORD_KEY = 'remora/devices'
/** The management dashboard route (web/routes.ts). */
const DASHBOARD_PATH = '/api/remora'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** Collects every structured log record the plugin emits. */
function captureLogs(ctx: Context): Message[] {
  const messages: Message[] = []
  ctx.logger.exporter({ export: (message) => messages.push(message) })
  return messages
}

/** First argument of a log record when it is a string (the printf format). */
function firstArgString(message: Message): string | undefined {
  const arg = message.args[0]
  return typeof arg === 'string' ? arg : undefined
}

/** Compact [type, first-arg] view of log records for assertion messages. */
function logSummary(messages: Message[]): string {
  return JSON.stringify(messages.map((message) => [message.type, firstArgString(message)]))
}

/**
 * The host id from the "remora: host started (id: %s, ...)" info record:
 * `args` is [format, hostId, relayOrigin, remoteRoots]. Log records carry the
 * id truncated to 6 characters (AGENTS.md §1.8).
 */
function startedHostId(messages: Message[]): string {
  const started = messages.find(
    (message) => message.type === 'info' && firstArgString(message)?.startsWith('remora: host started') === true,
  )
  const id = started?.args[1]
  return typeof id === 'string' ? id : ''
}

/** The credentials record holding the host identity (crypto-v1.md §3, P7-H2). */
const HOST_IDENTITY_RECORD_KEY = 'remora/host-identity'

/**
 * The full host id, derived from the relay seed of the identity record the
 * plugin persists. Log records only ever carry the truncated id, so the
 * identity record seam is the test's source for the real value.
 */
async function persistedHostId(credentials: FakeHostCredentials): Promise<string> {
  const record = await credentials.readRecord(HOST_IDENTITY_RECORD_KEY)
  if (record?.kind !== 'grant') throw new Error('apply harness: no host identity record was persisted')
  const payload = record.payload as { relaySeed?: unknown }
  if (typeof payload.relaySeed !== 'string') throw new Error('apply harness: identity record carries no relaySeed')
  return deriveEndpointId('h_', getRelayPublicKey(decodeBase64Url(payload.relaySeed)))
}

/**
 * Provides the in-memory credentials store under the `credentials` service
 * name, inside its own plugin fiber the way dsh provides the real seam
 * (`provideFakeDshServices` keeps its refusing fake for the boot-must-not-use
 * contract; the credentials seam is the one service boot may use — identity
 * records since P7-H2, the enrollment secret and record since P7-H3).
 */
async function provideCredentialsStore(ctx: Context, store: FakeHostCredentials): Promise<void> {
  await ctx.plugin({ apply: (serviceCtx: Context) => void serviceCtx.provide('credentials', store) })
}

/** The enrollment secret configured under the profile's key, as dsh would resolve it. */
function credentialsWithSecret(): FakeHostCredentials {
  return createHostCredentials({ references: { [SECRET_KEY]: SECRET } })
}

/** Every argument of a log record rendered as one string, for content assertions. */
function renderedArgs(message: Message): string {
  return message.args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')
}

/** Polls `predicate` until it holds or `timeoutMs` passes; returns whether it held. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

/** The `remora: relay ready (host %s)` info record, if emitted. */
function relayReadyLog(messages: Message[]): Message | undefined {
  return messages.find(
    (message) => message.type === 'info' && firstArgString(message)?.startsWith('remora: relay ready') === true,
  )
}

async function startRelay(options: Parameters<typeof startFakeRelay>[0] = { enrollSecret: SECRET }): Promise<FakeRelay> {
  const fake = await startFakeRelay(options)
  cleanups.push(() => fake.close())
  return fake
}

/** One dsh "process": a fresh Cordis root with the dsh services and the host plugin mounted. */
async function mountHost(
  credentials: FakeHostCredentials,
  relayUrl: string,
): Promise<{ messages: Message[]; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  const messages = captureLogs(ctx)
  await provideFakeDshServices(ctx, {
    typertGateway: createFakeTypertGateway(),
    storage: createFakeStorage(),
  })
  await provideCredentialsStore(ctx, credentials)
  const fiber = await ctx.plugin(host, createValidHostConfig({ relayUrl }))
  cleanups.push(async () => {
    if (fiber.state !== FIBER_STATE.DISPOSED) await fiber.dispose()
  })
  return { messages, fiber }
}

/**
 * Minimal fake of dsh's `connection` service — the Fetch-route registry the
 * management page mounts through (`ManagementConnection`) — provided inside
 * its own fiber like a real dsh service. Returns the routes as the plugin
 * registers them, so a test can drive the real handlers.
 */
async function provideConnectionRoutes(ctx: Context): Promise<Map<string, ManagementFetchRoute>> {
  const routes = new Map<string, ManagementFetchRoute>()
  await ctx.plugin({
    apply: (serviceCtx: Context) => {
      void serviceCtx.provide('connection', {
        fetch: {
          register: (route: ManagementFetchRoute) => {
            routes.set(route.path, route)
            return async () => {
              routes.delete(route.path)
            }
          },
        },
        requestRejection: () => undefined,
      })
    },
  })
  return routes
}

/** mountHost plus the `connection` fake, so the management routes can be driven. */
async function mountHostWithRoutes(
  credentials: FakeHostCredentials,
  relayUrl: string,
): Promise<{
  messages: Message[]
  fiber: Awaited<ReturnType<Context['plugin']>>
  routes: Map<string, ManagementFetchRoute>
}> {
  const ctx = new Context()
  const messages = captureLogs(ctx)
  await provideFakeDshServices(ctx, {
    typertGateway: createFakeTypertGateway(),
    storage: createFakeStorage(),
  })
  await provideCredentialsStore(ctx, credentials)
  const routes = await provideConnectionRoutes(ctx)
  const fiber = await ctx.plugin(host, createValidHostConfig({ relayUrl }))
  cleanups.push(async () => {
    if (fiber.state !== FIBER_STATE.DISPOSED) await fiber.dispose()
  })
  return { messages, fiber, routes }
}

/** The device list the management dashboard answers with, once its route is up. */
async function dashboardDevices(
  routes: Map<string, ManagementFetchRoute>,
): Promise<Array<{ deviceId: string; name: string; revoked: boolean; pairedAt: number }>> {
  const registered = await waitFor(() => routes.has(DASHBOARD_PATH))
  expect(registered, 'the management dashboard route was never registered').toBe(true)
  const route = routes.get(DASHBOARD_PATH)
  if (route === undefined) throw new Error('apply harness: dashboard route vanished')
  const response = await route.fetch(
    new Request(`http://127.0.0.1${DASHBOARD_PATH}`, { headers: { host: '127.0.0.1', accept: 'application/json' } }),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    devices: Array<{ deviceId: string; name: string; revoked: boolean; pairedAt: number }>
  }
  return body.devices
}

describe('remora host plugin apply() harness', () => {
  it('starts on a real Cordis context with the dsh services present', async () => {
    const ctx = new Context()
    const messages = captureLogs(ctx)
    await provideFakeDshServices(ctx, {
      typertGateway: createFakeTypertGateway(),
      storage: createFakeStorage(),
    })
    // The host identity lives in the credentials record seam (P7-H2), so boot
    // reads and creates the `remora/host-identity` record through it; the
    // relay enrollment secret is resolved through the same seam (P7-H3).
    await provideCredentialsStore(ctx, credentialsWithSecret())

    const config = createValidHostConfig({ relayUrl: `http://127.0.0.1:${await reserveClosedPort()}` })
    const loaded = await ctx.plugin(host, config)

    expect(
      loaded.state,
      `plugin did not reach ACTIVE; log records: ${logSummary(messages)}`,
    ).toBe(FIBER_STATE.ACTIVE)

    const started = messages.find(
      (message) => message.type === 'info' && firstArgString(message)?.startsWith('remora: host started') === true,
    )
    expect(started, `expected a "remora: host started" info log; got: ${logSummary(messages)}`).toBeDefined()

    const errorMessages = messages.filter((message) => message.type === 'error')
    expect(errorMessages).toEqual([])

    const disposeStartedAt = performance.now()
    await loaded.dispose()
    expect(performance.now() - disposeStartedAt).toBeLessThan(2_000)
  }, 15_000)

  it('stays pending without typertGateway and does not crash', async () => {
    const ctx = new Context()
    const messages = captureLogs(ctx)
    await provideFakeDshServices(ctx, {
      credentials: createFakeCredentials(),
      storage: createFakeStorage(),
    })

    const config = createValidHostConfig({ relayUrl: `http://127.0.0.1:${await reserveClosedPort()}` })
    const fiber = await ctx.plugin(host, config)

    expect(
      fiber.state,
      `plugin should wait for its required services; log records: ${logSummary(messages)}`,
    ).toBe(FIBER_STATE.PENDING)

    // Give any runaway startup a chance to blow up before asserting stillness.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(fiber.state).toBe(FIBER_STATE.PENDING)
    expect(messages.some((message) => message.type === 'error')).toBe(false)
    expect(
      messages.some((message) => firstArgString(message)?.startsWith('remora: host started') === true),
    ).toBe(false)
  }, 15_000)

  it('keeps the same host id across a restart (same credentials store)', async () => {
    // One dsh credentials store stands for the profile's credential records;
    // each mount is a fresh Cordis root, the way a dsh restart is.
    const credentialsStore = credentialsWithSecret()
    const config = createValidHostConfig({ relayUrl: `http://127.0.0.1:${await reserveClosedPort()}` })

    const first = new Context()
    const firstMessages = captureLogs(first)
    await provideFakeDshServices(first, {
      typertGateway: createFakeTypertGateway(),
      storage: createFakeStorage(),
    })
    await provideCredentialsStore(first, credentialsStore)
    const firstLoaded = await first.plugin(host, config)
    expect(
      firstLoaded.state,
      `first mount did not reach ACTIVE; log records: ${logSummary(firstMessages)}`,
    ).toBe(FIBER_STATE.ACTIVE)
    const firstId = await persistedHostId(credentialsStore)
    expect(firstId).toMatch(/^h_[a-z2-7]{26}$/)
    // The startup log carries the id truncated to 6 characters (AGENTS.md §1.8).
    expect(startedHostId(firstMessages)).toBe(firstId.slice(0, 6))
    await firstLoaded.dispose()

    const second = new Context()
    const secondMessages = captureLogs(second)
    await provideFakeDshServices(second, {
      typertGateway: createFakeTypertGateway(),
      storage: createFakeStorage(),
    })
    await provideCredentialsStore(second, credentialsStore)
    const secondLoaded = await second.plugin(host, config)
    expect(
      secondLoaded.state,
      `second mount did not reach ACTIVE; log records: ${logSummary(secondMessages)}`,
    ).toBe(FIBER_STATE.ACTIVE)
    const secondId = await persistedHostId(credentialsStore)
    expect(secondId).toMatch(/^h_[a-z2-7]{26}$/)
    expect(secondId, 'host id changed across a restart; the identity is not persisted').toBe(firstId)
    expect(startedHostId(secondMessages)).toBe(secondId.slice(0, 6))
    await secondLoaded.dispose()
  }, 15_000)
})

describe('remora host plugin apply() harness: relay enrollment (P7-H3)', () => {
  it('enrolls with the relay before connecting, then logs "remora: relay ready (host <6 chars>)"', async () => {
    const relay = await startRelay()
    const credentials = credentialsWithSecret()
    const { messages, fiber } = await mountHost(credentials, relay.origin)
    expect(fiber.state, `plugin did not reach ACTIVE; log records: ${logSummary(messages)}`).toBe(FIBER_STATE.ACTIVE)

    const ready = await waitFor(() => relayReadyLog(messages) !== undefined)
    expect(ready, `no "remora: relay ready" info log; log records: ${logSummary(messages)}`).toBe(true)

    const hostId = await persistedHostId(credentials)
    expect(startedHostId(messages)).toBe(hostId.slice(0, 6))
    expect(relayReadyLog(messages)?.args[1]).toBe(hostId.slice(0, 6))
    expect(relay.enrollRequests, 'the host never enrolled with the relay').toHaveLength(1)
    expect(relay.enrollRequests[0]?.authorization).toBe(`Bearer ${SECRET}`)
    expect(credentials.resolvedRefs).toContain(SECRET_KEY)
    // Enrollment strictly precedes the first relay connection, which then authenticates.
    expect(relay.connectAttempts[0]?.sequence ?? 0).toBeGreaterThan(relay.enrollRequests[0]?.sequence ?? Infinity)
    expect(relay.connectAttempts.map((attempt) => attempt.outcome)).toEqual(['ready'])
    expect(relay.enrolledHostIds.has(hostId)).toBe(true)
    expect(await credentials.readRecord(ENROLLMENT_RECORD_KEY)).toEqual({
      kind: 'grant',
      payload: { hostId, enrolledRelayOrigin: relay.origin },
    })
    expect(messages.filter((message) => message.type === 'error')).toEqual([])
    for (const message of messages) expect(renderedArgs(message)).not.toContain(SECRET)

    const disposeStartedAt = performance.now()
    await fiber.dispose()
    expect(performance.now() - disposeStartedAt).toBeLessThan(2_000)
  }, 15_000)

  it('skips enrollment on a restart already enrolled with the same relay origin', async () => {
    const relay = await startRelay()
    const credentials = credentialsWithSecret()

    const first = await mountHost(credentials, relay.origin)
    expect(await waitFor(() => relayReadyLog(first.messages) !== undefined)).toBe(true)
    await first.fiber.dispose()
    expect(relay.enrollRequests).toHaveLength(1)

    const second = await mountHost(credentials, relay.origin)
    const ready = await waitFor(() => relayReadyLog(second.messages) !== undefined)
    expect(ready, `restart did not reach the relay; log records: ${logSummary(second.messages)}`).toBe(true)
    expect(relay.enrollRequests, 'a restart enrolled again although already enrolled').toHaveLength(1)
    expect(relay.connectAttempts.map((attempt) => attempt.outcome)).toEqual(['ready', 'ready'])
  }, 15_000)

  it('fails to load with a RemoraConfigError naming the key and the .env file when the secret is missing', async () => {
    const relay = await startRelay()
    const ctx = new Context()
    const messages = captureLogs(ctx)
    await provideFakeDshServices(ctx, {
      typertGateway: createFakeTypertGateway(),
      storage: createFakeStorage(),
    })
    await provideCredentialsStore(ctx, createHostCredentials())

    const fiber = ctx.plugin(host, createValidHostConfig({ relayUrl: relay.origin }))
    cleanups.push(async () => {
      if (fiber.state !== FIBER_STATE.DISPOSED) await fiber.dispose()
    })
    const failure = await fiber.then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure, `plugin loaded without the enrollment secret; log records: ${logSummary(messages)}`).toBeInstanceOf(
      host.RemoraConfigError,
    )
    expect(String((failure as Error).message)).toContain(SECRET_KEY)
    expect(String((failure as Error).message)).toContain('.env')
    expect(fiber.state).toBe(FIBER_STATE.FAILED)
    expect(relay.enrollRequests).toHaveLength(0)
    expect(relay.connectAttempts).toHaveLength(0)
  }, 15_000)

  it('on 401 logs an actionable error and never starts the relay link', async () => {
    const relay = await startRelay({ enrollSecret: 'the-relay-has-another-secret' })
    const { messages, fiber } = await mountHost(credentialsWithSecret(), relay.origin)
    expect(fiber.state).toBe(FIBER_STATE.ACTIVE)

    const rejected = (): Message | undefined =>
      messages.find((message) => message.type === 'error' && renderedArgs(message).includes('401'))
    const logged = await waitFor(() => rejected() !== undefined)
    expect(logged, `no error log for the 401; log records: ${logSummary(messages)}`).toBe(true)
    const text = rejected() === undefined ? '' : renderedArgs(rejected() as Message)
    expect(text).toContain(SECRET_KEY)
    expect(text).not.toContain(SECRET)

    // Give a wrongly started relay loop time to dial before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(relay.enrollRequests).toHaveLength(1)
    expect(relay.connectAttempts, 'the relay link was started after a 401').toHaveLength(0)
    expect(relayReadyLog(messages)).toBeUndefined()
  }, 15_000)

  it('clears a stale remembered enrollment when the relay refuses the host, so the next start enrolls again', async () => {
    const relay = await startRelay()
    const credentials = credentialsWithSecret()

    const first = await mountHost(credentials, relay.origin)
    expect(await waitFor(() => relayReadyLog(first.messages) !== undefined)).toBe(true)
    await first.fiber.dispose()

    // The relay loses its endpoint table (redeployed with fresh storage).
    relay.forgetEndpoints()
    const second = await mountHost(credentials, relay.origin)
    const cleared = await waitFor(async () => (await credentials.readRecord(ENROLLMENT_RECORD_KEY)) === undefined)
    expect(cleared, `remembered enrollment not cleared; log records: ${logSummary(second.messages)}`).toBe(true)
    expect(relay.connectAttempts.map((attempt) => attempt.outcome)).toEqual(['ready', 'forbidden'])
    expect(second.messages.some((message) => message.type === 'error')).toBe(true)
    await second.fiber.dispose()

    const third = await mountHost(credentials, relay.origin)
    expect(await waitFor(() => relayReadyLog(third.messages) !== undefined)).toBe(true)
    expect(relay.enrollRequests).toHaveLength(2)
  }, 15_000)
})

/**
 * The routing records the dsh event wiring (P7-H5) emits when a real-shaped
 * dsh event reaches the plugin's handlers. The handlers must react to the
 * exact shapes real dsh emits — `session/event` as `(session, event)` and
 * `agent/error` as `{ agent, turn, step, error }` with the session id on
 * `agent.id` (upstream.lock.json 0.1.5-rc.3) — so the wiring logs the routed
 * session id (truncated to 6 characters, AGENTS.md §1.8) when it fires.
 */
const TURN_ENDED_LOG_PREFIX = 'remora: turn ended in session'
const AGENT_ERROR_LOG_PREFIX = 'remora: agent error in session'

describe('remora host plugin apply() harness: dsh event wiring (P7-H5)', () => {
  it('routes a real turn/end session event to the turn-done notification path', async () => {
    const ctx = new Context()
    const messages = captureLogs(ctx)
    await provideFakeDshServices(ctx, {
      typertGateway: createFakeTypertGateway(),
      storage: createFakeStorage(),
    })
    await provideCredentialsStore(ctx, credentialsWithSecret())
    const loaded = await ctx.plugin(
      host,
      createValidHostConfig({ relayUrl: `http://127.0.0.1:${await reserveClosedPort()}` }),
    )
    expect(
      loaded.state,
      `plugin did not reach ACTIVE; log records: ${logSummary(messages)}`,
    ).toBe(FIBER_STATE.ACTIVE)

    // The exact emit real dsh performs (upstream session/src/index.ts):
    // the owning session as the FIRST argument, the appended event second.
    ctx.emit('session/event', createFixtureSession(), FIXTURE_TURN_END)

    const routed = await waitFor(() =>
      messages.some(
        (message) => message.type === 'info' && firstArgString(message)?.startsWith(TURN_ENDED_LOG_PREFIX) === true,
      ),
    )
    expect(
      routed,
      `the plugin never reacted to a real (session, event) turn/end emit — ` +
        `the handler assumed a wrong event shape (P7-H5); log records: ${logSummary(messages)}`,
    ).toBe(true)
    const record = messages.find(
      (message) => message.type === 'info' && firstArgString(message)?.startsWith(TURN_ENDED_LOG_PREFIX) === true,
    )
    expect(record?.args[1], 'the routed session id must be the real session id, truncated to 6 characters').toBe(
      FIXTURE_SESSION_ID.slice(0, 6),
    )
    expect(
      messages.filter((message) => message.type === 'error'),
      'the real-shaped emit must not crash the wiring',
    ).toEqual([])
    await loaded.dispose()
  }, 15_000)

  it('routes a real agent/error payload to the turn-error notification path', async () => {
    const ctx = new Context()
    const messages = captureLogs(ctx)
    await provideFakeDshServices(ctx, {
      typertGateway: createFakeTypertGateway(),
      storage: createFakeStorage(),
    })
    await provideCredentialsStore(ctx, credentialsWithSecret())
    const loaded = await ctx.plugin(
      host,
      createValidHostConfig({ relayUrl: `http://127.0.0.1:${await reserveClosedPort()}` }),
    )
    expect(
      loaded.state,
      `plugin did not reach ACTIVE; log records: ${logSummary(messages)}`,
    ).toBe(FIBER_STATE.ACTIVE)

    // The exact payload real dsh emits (upstream agent/src/runtime-types.ts):
    // `{ agent, turn, step, error }` — there is NO sessionId field; the
    // session id is `agent.id`.
    ctx.emit('agent/error', {
      agent: createTestAgent(FIXTURE_SESSION_ID),
      turn: 3,
      step: 1,
      error: new Error('provider dropped the connection'),
    })

    const routed = await waitFor(() =>
      messages.some(
        (message) => message.type === 'info' && firstArgString(message)?.startsWith(AGENT_ERROR_LOG_PREFIX) === true,
      ),
    )
    expect(
      routed,
      `the plugin never reacted to a real agent/error payload — ` +
        `the handler looked for a sessionId field that the real payload does not carry (P7-H5); log records: ${logSummary(messages)}`,
    ).toBe(true)
    const record = messages.find(
      (message) => message.type === 'info' && firstArgString(message)?.startsWith(AGENT_ERROR_LOG_PREFIX) === true,
    )
    expect(record?.args[1], 'the routed session id must come from agent.id, truncated to 6 characters').toBe(
      FIXTURE_SESSION_ID.slice(0, 6),
    )
    expect(record?.args[2], 'the routed turn number must come from the payload').toBe(3)
    expect(record?.args[3], 'the routed step number must come from the payload').toBe(1)
    expect(
      messages.filter((message) => message.type === 'error'),
      'the real-shaped emit must not crash the wiring',
    ).toEqual([])
    await loaded.dispose()
  }, 15_000)
})

describe('remora host plugin apply() harness: device persistence (P7-H4)', () => {
  const DEVICE_A_ID = 'd_abcdefghijklmnopqrstuvwxyz'
  const DEVICE_B_ID = 'd_mzxw6ytboirx24dhmzxw6ytboi'
  /** Fixed, obviously fake test key material (AGENTS.md §10). */
  const PSK_SEED = new Uint8Array(32).fill(2)
  const PUSH_KEY_SEED = new Uint8Array(32).fill(3)

  /**
   * The devices record a previous session left behind: one paired device with
   * its PSK and push key (crypto-v1.md §3), one revoked device whose secrets
   * the revocation write deleted, and the paired device's notify preferences.
   */
  function credentialsWithDevicesRecord(): FakeHostCredentials {
    const devicesRecord: FakeGrantRecord = {
      kind: 'grant',
      payload: {
        v: 1,
        devices: [
          {
            deviceId: DEVICE_A_ID,
            name: 'Pixel 8',
            noisePublicKey: encodeBase64Url(new Uint8Array(32).fill(1)),
            devicePsk: encodeBase64Url(PSK_SEED),
            pushKey: encodeBase64Url(PUSH_KEY_SEED),
            approvalPublicKey: encodeBase64Url(new Uint8Array(65).fill(4)),
            createdAt: 1_000,
            lastSeenAt: 2_000,
            revoked: false,
          },
          {
            deviceId: DEVICE_B_ID,
            name: 'Old Phone',
            noisePublicKey: encodeBase64Url(new Uint8Array(32).fill(5)),
            createdAt: 3_000,
            lastSeenAt: 4_000,
            revoked: true,
          },
        ],
        notifyPrefs: { [DEVICE_A_ID]: { approval: true, question: true, turnDone: false, turnError: true } },
      },
    }
    return createHostCredentials({
      references: { [SECRET_KEY]: SECRET },
      records: { [DEVICES_RECORD_KEY]: devicesRecord },
    })
  }

  it('admits a paired device and keeps its revocation across two mounts on the same credentials store', async () => {
    const credentials = credentialsWithDevicesRecord()
    const relayUrl = `http://127.0.0.1:${await reserveClosedPort()}`

    const first = await mountHostWithRoutes(credentials, relayUrl)
    expect(
      first.fiber.state,
      `first mount did not reach ACTIVE; log records: ${logSummary(first.messages)}`,
    ).toBe(FIBER_STATE.ACTIVE)
    const firstDevices = await dashboardDevices(first.routes)
    expect(firstDevices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: DEVICE_A_ID, name: 'Pixel 8', revoked: false }),
        expect.objectContaining({ deviceId: DEVICE_B_ID, name: 'Old Phone', revoked: true }),
      ]),
    )
    await first.fiber.dispose()

    // The restart: a fresh Cordis root over the SAME credentials store.
    const second = await mountHostWithRoutes(credentials, relayUrl)
    expect(
      second.fiber.state,
      `second mount did not reach ACTIVE; log records: ${logSummary(second.messages)}`,
    ).toBe(FIBER_STATE.ACTIVE)
    const secondDevices = await dashboardDevices(second.routes)
    expect(secondDevices, 'the paired device did not survive the remount').toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: DEVICE_A_ID, name: 'Pixel 8', revoked: false }),
        expect.objectContaining({ deviceId: DEVICE_B_ID, name: 'Old Phone', revoked: true }),
      ]),
    )

    // The remount neither clobbered the record nor resurrected the revoked
    // device's secrets: the paired device keeps its PSK/push key, the revoked
    // one has none (crypto-v1.md §10).
    const stored = await credentials.readRecord(DEVICES_RECORD_KEY)
    expect(stored?.kind).toBe('grant')
    const payload = (stored as FakeGrantRecord).payload as {
      devices: Array<{ deviceId: string; devicePsk?: string; pushKey?: string }>
    }
    const storedA = payload.devices.find((device) => device.deviceId === DEVICE_A_ID)
    const storedB = payload.devices.find((device) => device.deviceId === DEVICE_B_ID)
    expect(storedA?.devicePsk).toBe(encodeBase64Url(PSK_SEED))
    expect(storedA?.pushKey).toBe(encodeBase64Url(PUSH_KEY_SEED))
    expect(storedB?.devicePsk).toBeUndefined()
    expect(storedB?.pushKey).toBeUndefined()

    // The device secrets never reach the plugin's log output (AGENTS.md §1.8).
    for (const messages of [first.messages, second.messages]) {
      for (const message of messages) {
        const text = renderedArgs(message)
        expect(text, 'device key material leaked into a log record').not.toContain(encodeBase64Url(PSK_SEED))
        expect(text, 'device key material leaked into a log record').not.toContain(encodeBase64Url(PUSH_KEY_SEED))
      }
    }
    await second.fiber.dispose()
  }, 15_000)
})

describe('remora host plugin apply() harness: AnswerBridge policy (P7-H10)', () => {
  const DEVICE_ID = 'd_abcdefghijklmnopqrstuvwxyz'
  // P-256 generator point (test private scalar 1), encoded as SPKI DER.
  const APPROVAL_PUBLIC_KEY = hexToBytes(
    '3059301306072a8648ce3d020106082a8648ce3d03010703420004' +
    '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
    '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
  )

  async function mountBridge(config: Partial<host.Config> = {}) {
    const ctx = new Context()
    const credentials = credentialsWithSecret()
    // Use the production persistence API to prepare a previously paired device.
    const registry = await host.loadPersistentDeviceRegistry(credentials)
    registry.addDevice({
      deviceId: DEVICE_ID,
      name: 'Approval test phone',
      noisePublicKey: new Uint8Array(32).fill(1),
      devicePsk: new Uint8Array(32).fill(2),
      pushKey: new Uint8Array(32).fill(3),
      approvalPublicKey: APPROVAL_PUBLIC_KEY,
      createdAt: 1,
      lastSeenAt: 1,
      revoked: false,
    })
    await registry.flush()
    await provideFakeDshServices(ctx, {
      typertGateway: createFakeTypertGateway(),
      storage: createFakeStorage(),
    })
    await provideCredentialsStore(ctx, credentials)
    const fiber = await ctx.plugin(host, createValidHostConfig({
      relayUrl: `http://127.0.0.1:${await reserveClosedPort()}`,
      ...config,
    }))
    cleanups.push(async () => { await fiber.dispose() })
    expect(fiber.state).toBe(FIBER_STATE.ACTIVE)
    const server = ctx['remora-rcp-server']
    if (server === undefined) throw new Error('host did not expose its RCP server')
    const pending = new Promise<host.PendingApproval>((resolve) => {
      server.setTransportSender((_deviceId, _channelId, raw) => {
        const frame = JSON.parse(raw) as { d?: { type?: string; pending?: host.PendingApproval } }
        if (frame.d?.type === 'requested' && frame.d.pending?.kind === 'approval') resolve(frame.d.pending)
        return true
      })
    })
    const follow = await server.handleMessage(
      JSON.stringify({ v: 1, k: 'req', id: 1, m: 'interaction.follow', p: {} }),
      { deviceId: DEVICE_ID, channelId: 1 },
    )
    expect(JSON.parse(follow ?? '{}')).toMatchObject({ ok: true })
    cleanups.push(async () => { server.closeChannel(DEVICE_ID, 1) })
    return { ctx, server, pending }
  }

  it.each([
    ['high', 'git reset --hard'],
    ['all', 'echo safe'],
  ] as const)('enforces configured %s biometrics through the actual approvals.answer handler', async (approvalBiometric, command) => {
    const { ctx, server, pending } = await mountBridge({ approvalBiometric })
    const controller = new AbortController()
    const outcome = ctx.waterfall('approval/request', {
      agent: createApprovalJournalAgent(JSON.stringify({ command })),
      toolName: 'bash',
      callId: ToolCallId('mock-call-1'),
      signal: controller.signal,
    }, async (): Promise<ApprovalOutcome> => 'unavailable')
    try {
      const approval = await pending
      const reply = await server.handleMessage(JSON.stringify({
        v: 1,
        k: 'req',
        id: 2,
        m: 'approvals.answer',
        p: { id: approval.id, outcome: 'allowed-once', argsDigest: approval.argsDigest, issuedAt: Date.now() },
      }), { deviceId: DEVICE_ID, channelId: 1 })
      expect(JSON.parse(reply ?? '{}')).toMatchObject({ ok: false, e: { code: 'signature_required' } })
      expect(approval.requiresSignature).toBe(true)
      const invalidSignatureReply = await server.handleMessage(JSON.stringify({
        v: 1,
        k: 'req',
        id: 3,
        m: 'approvals.answer',
        p: {
          id: approval.id,
          outcome: 'allowed-once',
          argsDigest: approval.argsDigest,
          issuedAt: Date.now(),
          sig: encodeBase64Url(new Uint8Array(70).fill(9)),
        },
      }), { deviceId: DEVICE_ID, channelId: 1 })
      expect(JSON.parse(invalidSignatureReply ?? '{}')).toMatchObject({ ok: false, e: { code: 'signature_invalid' } })
    } finally {
      controller.abort()
      await outcome
    }
  })

  it('uses the configured approval timeout in pending metadata and ends an unanswered request', async () => {
    const { ctx, pending } = await mountBridge({ approvalTimeoutMs: 100 })
    const controller = new AbortController()
    const outcome = ctx.waterfall('approval/request', {
      agent: createApprovalJournalAgent(),
      toolName: 'bash',
      callId: ToolCallId('mock-call-1'),
      signal: controller.signal,
    }, async (): Promise<ApprovalOutcome> => 'unavailable')
    try {
      const approval = await pending
      expect(approval.expiresAt - approval.createdAt).toBe(100)
      let completed: ApprovalOutcome | undefined
      void outcome.then((value) => { completed = value })
      expect(await waitFor(() => completed !== undefined, 1_000)).toBe(true)
      expect(completed).toBe('unavailable')
    } finally {
      controller.abort()
      await outcome
    }
  })

  it('rejects startup when a real Cordis registration interceptor prevents the ordering probes from running', async () => {
    const ctx = new Context()
    const messages = captureLogs(ctx)
    // A real Cordis extension intercepts these registrations. The waterfall
    // and host stay unmocked; the self-check must detect that no probe ran.
    const removeInterceptor = ctx.on('internal/listener', (eventName) => {
      if (eventName === 'approval/request') return () => true
      return undefined
    })
    cleanups.push(async () => { removeInterceptor() })
    await provideFakeDshServices(ctx, {
      typertGateway: createFakeTypertGateway(),
      storage: createFakeStorage(),
    })
    await provideCredentialsStore(ctx, credentialsWithSecret())
    const relay = await startRelay()
    const fiber = ctx.plugin(host, createValidHostConfig({ relayUrl: relay.origin }))
    cleanups.push(async () => { await fiber.dispose() })
    const failure = await fiber.then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('AnswerBridge waterfall self-check failed')
    expect(fiber.state).toBe(FIBER_STATE.FAILED)
    expect(messages.some((message) => firstArgString(message)?.startsWith('remora: host started'))).toBe(false)
    expect(relay.enrollRequests).toHaveLength(0)
  })
})

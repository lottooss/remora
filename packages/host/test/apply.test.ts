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
 */
import { Context, type Message } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as host from '../src/index.ts'
import {
  createFakeCredentials,
  createFakeStorage,
  createFakeTypertGateway,
  provideFakeDshServices,
  reserveClosedPort,
} from './support/dsh-fakes.ts'
import { createValidHostConfig } from './support/host-config.ts'
import { createHostCredentials, type FakeHostCredentials } from './relay/fake-credentials.ts'
import { startFakeRelay, type FakeRelay } from './relay/fake-relay.ts'

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
 * `args` is [format, hostId, relayOrigin, remoteRoots].
 */
function startedHostId(messages: Message[]): string {
  const started = messages.find(
    (message) => message.type === 'info' && firstArgString(message)?.startsWith('remora: host started') === true,
  )
  const id = started?.args[1]
  return typeof id === 'string' ? id : ''
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
    const firstId = startedHostId(firstMessages)
    expect(firstId).toMatch(/^h_[a-z2-7]{26}$/)
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
    const secondId = startedHostId(secondMessages)
    expect(secondId).toMatch(/^h_[a-z2-7]{26}$/)
    expect(secondId, 'host id changed across a restart; the identity is not persisted').toBe(firstId)
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

    const hostId = startedHostId(messages)
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

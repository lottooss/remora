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
 */
import { Context, type Message } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as host from '../src/index.ts'
import {
  createFakeCredentials,
  createFakeStorage,
  createFakeTypertGateway,
  provideFakeDshServices,
  reserveClosedPort,
} from './support/dsh-fakes.ts'
import { createValidHostConfig } from './support/host-config.ts'

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

describe('remora host plugin apply() harness', () => {
  it('starts on a real Cordis context with the dsh services present', async () => {
    const ctx = new Context()
    const messages = captureLogs(ctx)
    await provideFakeDshServices(ctx, {
      typertGateway: createFakeTypertGateway(),
      credentials: createFakeCredentials(),
      storage: createFakeStorage(),
    })

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
})

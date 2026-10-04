/**
 * P7-H7 acceptance — method-set parity (docs/tasks/P7-H7.md): after the real
 * plugin `apply()` has run, the set of methods registered on the host's
 * RcpServer equals `RCP_METHODS` of @remora/protocol.
 *
 * `RCP_METHODS` is the reconciled 36-method set of RCP/1 §4–§10 that
 * @remora/protocol asserts against the spec tables (P7-C1). It holds only
 * device→host methods: the host→device pairing messages of §7
 * (`pair.complete` req, `pair.rejected` evt) are sent by the pairing service,
 * never dispatched through the RcpServer, and have no registry entry — so the
 * "minus host→device" subtraction is empty today. If a host→device method
 * ever enters the registry, this test must exclude it explicitly here.
 *
 * Red on main before P7-H7: the host still registers the off-spec extras
 * `sessions.get`, `files.readBytes`, `diffs.get`, `diffs.hunk` and lacks
 * `devices.self`, `devices.unpair`, `devices.rotateApprovalKey`.
 *
 * The plugin is mounted through `apply()` on a real Cordis context exactly
 * like test/apply.test.ts; only the dsh side of the boundary is faked
 * (test/support/dsh-fakes.ts). The RcpServer itself is observed through the
 * `remora-rcp-server` service the plugin provides in apply().
 */
import { Context } from '@deepseek-ai/cordis'
import { RCP_METHODS } from '@remora/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import * as host from '../../src/index.ts'
import type { RcpServer } from '../../src/rcp/index.ts'
import { createHostCredentials, type FakeHostCredentials } from '../relay/fake-credentials.ts'
import {
  createFakeStorage,
  createFakeTypertGateway,
  provideFakeDshServices,
  reserveClosedPort,
} from '../support/dsh-fakes.ts'
import { createValidHostConfig } from '../support/host-config.ts'

/** The service the plugin provides so tests can observe its RcpServer. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    'remora-rcp-server'?: RcpServer
  }
}

/** The credentials key the profile config names (`enrollSecretKey`). */
const SECRET_KEY = 'REMORA_RELAY_ENROLL_SECRET'
/** Obviously fake test secret (AGENTS.md §10). */
const SECRET = 'test-enroll-secret-not-real-0123456789'

/** Mirrors the upstream fiber state const enum (see test/apply.test.ts). */
const FIBER_STATE_DISPOSED = 4

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** Mounts the real host plugin on a real Cordis context (the apply harness). */
async function mountHost(): Promise<Context> {
  const ctx = new Context()
  await provideFakeDshServices(ctx, {
    typertGateway: createFakeTypertGateway(),
    storage: createFakeStorage(),
  })
  const credentials: FakeHostCredentials = createHostCredentials({
    references: { [SECRET_KEY]: SECRET },
  })
  await ctx.plugin({
    apply: (serviceCtx: Context) => void serviceCtx.provide('credentials', credentials),
  })
  // An unreachable relay keeps the enrollment loop in the background, the way
  // the no-relay apply() tests run; disposal aborts it.
  const fiber = await ctx.plugin(
    host,
    createValidHostConfig({ relayUrl: `http://127.0.0.1:${await reserveClosedPort()}` }),
  )
  cleanups.push(async () => {
    if (fiber.state !== FIBER_STATE_DISPOSED) await fiber.dispose()
  })
  return ctx
}

describe('RCP method-set parity (P7-H7)', () => {
  it('registers exactly the device-callable RCP_METHODS set after apply()', async () => {
    const ctx = await mountHost()
    const server = ctx['remora-rcp-server']
    expect(server, 'the plugin did not expose its RcpServer under the remora-rcp-server service').toBeDefined()
    if (server === undefined) throw new Error('unreachable: the assertion above failed')

    const registered = server.registeredMethodNames().slice().sort()
    const expected: string[] = RCP_METHODS.map((method) => method.name).slice().sort()

    const unexpected = registered.filter((name) => !expected.includes(name))
    const missing = expected.filter((name) => !registered.includes(name))
    expect(
      unexpected,
      'methods registered on RcpServer that the RCP/1 method set does not define',
    ).toEqual([])
    expect(missing, 'device-callable RCP/1 methods the host never registered').toEqual([])
    expect(registered, 'the registered method set must equal RCP_METHODS exactly').toEqual(expected)
  }, 15_000)
})

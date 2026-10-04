/**
 * P7-H7 acceptance — per-method tests for `devices.self`, `devices.unpair`,
 * `devices.rotateApprovalKey` (RCP/1 §7, crypto-v1.md §10), driven through the
 * real plugin: the host is mounted via `apply()` on a real Cordis context with
 * a paired device in the dsh credentials record, requests go through the real
 * RcpServer, and the rotation is resolved through the real management routes.
 *
 * Red on main before P7-H7: none of the three methods is registered (every
 * request below fails with `method_not_found`) and the rotation
 * confirm/reject routes do not exist.
 *
 * The channel-closing half of unpair is proven end-to-end against the real
 * ChannelManager in test/rcp/devices-channel.test.ts (added with the
 * implementation, which provides the method registration it wires).
 */
import { Context, type Message } from '@deepseek-ai/cordis'
import { encodeBase64Url } from '@remora/crypto'
import { afterEach, describe, expect, it } from 'vitest'
import * as host from '../../src/index.ts'
import type { RcpServer } from '../../src/rcp/index.ts'
import type { ManagementFetchRoute } from '../../src/web/routes.ts'
import type { FakeGrantRecord } from '../identity/fake-credentials.ts'
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
/** The credentials record holding the paired devices and their prefs (P7-H4). */
const DEVICES_RECORD_KEY = 'remora/devices'
/** The management dashboard route (web/routes.ts). */
const DASHBOARD_PATH = '/api/remora'
/** The rotation Confirm/Reject routes on the management page (P7-H7). */
const ROTATION_CONFIRM_PATH = '/api/remora/devices/rotation/confirm'
const ROTATION_REJECT_PATH = '/api/remora/devices/rotation/reject'

/** Valid device endpoint ids: `d_` + 26 lowercase base32 characters. */
const DEVICE_A_ID = 'd_abcdefghijklmnopqrstuvwxyz'
const DEVICE_B_ID = 'd_mzxw6ytboirx24dhmzxw6ytboi'
const UNKNOWN_DEVICE_ID = 'd_bbbbbbbbbbbbbbbbbbbbbbbbbb'

/** Fixed, obviously fake test key material (AGENTS.md §10). */
const PSK_SEED = new Uint8Array(32).fill(2)
const PUSH_KEY_SEED = new Uint8Array(32).fill(3)

/** Uncompressed P-256 approval public keys (0x04 || X || Y), old and new. */
const KEY_OLD = new Uint8Array(65).fill(1)
const KEY_NEW = new Uint8Array(65).fill(9)
KEY_OLD[0] = 0x04
KEY_NEW[0] = 0x04

/** Fixed request ids for the exactly-once assertions. */
const ROTATION_REQUEST_ID = '5e22e13c-1111-4222-8333-000000000001'
const ROTATION_REQUEST_ID_2 = '5e22e13c-1111-4222-8333-000000000002'

/** Mirrors the upstream fiber state const enum (see test/apply.test.ts). */
const FIBER_STATE_DISPOSED = 4

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

/** Every argument of a log record rendered as one string, for content checks. */
function renderedArgs(message: Message): string {
  return message.args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')
}

/** Polls `predicate` until it holds or `timeoutMs` passes. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

/** The stored devices record payload (the atomic whole-record write's result). */
async function readStoredPayload(credentials: FakeHostCredentials): Promise<{
  devices: Array<{
    deviceId: string
    devicePsk?: string
    pushKey?: string
    approvalPublicKey?: string
    revoked: boolean
  }>
  notifyPrefs: Record<string, unknown>
}> {
  const stored = await credentials.readRecord(DEVICES_RECORD_KEY)
  expect(stored?.kind, 'the remora/devices record must exist').toBe('grant')
  return (stored as FakeGrantRecord).payload as {
    devices: Array<{
      deviceId: string
      devicePsk?: string
      pushKey?: string
      approvalPublicKey?: string
      revoked: boolean
    }>
    notifyPrefs: Record<string, unknown>
  }
}

function storedDevice(payload: Awaited<ReturnType<typeof readStoredPayload>>, deviceId: string) {
  const device = payload.devices.find((entry) => entry.deviceId === deviceId)
  expect(device, `device ${deviceId} is not in the stored record`).toBeDefined()
  if (device === undefined) throw new Error(`unreachable: the assertion above failed`)
  return device
}

/** One paired device ("Pixel 8") plus one revoked device in the record. */
function credentialsWithPairedDevice(): FakeHostCredentials {
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
          approvalPublicKey: encodeBase64Url(KEY_OLD),
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

/** Minimal fake of dsh's `connection` service (same shape as test/apply.test.ts). */
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

/** Mounts the real plugin with one paired device and the management routes. */
async function mountHostWithPairedDevice(): Promise<{
  credentials: FakeHostCredentials
  routes: Map<string, ManagementFetchRoute>
  server: RcpServer
}> {
  const ctx = new Context()
  const credentials = credentialsWithPairedDevice()
  await provideFakeDshServices(ctx, {
    typertGateway: createFakeTypertGateway(),
    storage: createFakeStorage(),
  })
  await ctx.plugin({
    apply: (serviceCtx: Context) => void serviceCtx.provide('credentials', credentials),
  })
  const routes = await provideConnectionRoutes(ctx)
  const fiber = await ctx.plugin(
    host,
    createValidHostConfig({ relayUrl: `http://127.0.0.1:${await reserveClosedPort()}` }),
  )
  cleanups.push(async () => {
    if (fiber.state !== FIBER_STATE_DISPOSED) await fiber.dispose()
  })
  const server = ctx['remora-rcp-server']
  expect(server, 'the plugin did not expose its RcpServer under the remora-rcp-server service').toBeDefined()
  if (server === undefined) throw new Error('unreachable: the assertion above failed')
  return { credentials, routes, server }
}

/** Sends one RCP request as `deviceId` and returns the decoded reply. */
async function request(
  server: RcpServer,
  deviceId: string,
  id: number,
  m: string,
  p?: Record<string, unknown>,
): Promise<{ ok: boolean; r?: Record<string, unknown>; e?: { code: string; message: string } }> {
  const raw = await server.handleMessage(
    JSON.stringify(p === undefined ? { k: 'req', id, m } : { k: 'req', id, m, p }),
    { deviceId, channelId: 1 },
  )
  expect(raw, `the ${m} request was dropped without a reply`).not.toBeNull()
  return JSON.parse(raw as string)
}

/** POSTs one JSON action body to a management route after waiting for it. */
async function postAction(
  routes: Map<string, ManagementFetchRoute>,
  path: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const registered = await waitFor(() => routes.has(path))
  expect(registered, `the ${path} route was never registered`).toBe(true)
  const route = routes.get(path)
  if (route === undefined) throw new Error(`route vanished: ${path}`)
  const response = await route.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** The dashboard JSON body (pending rotation state included once implemented). */
async function dashboardBody(routes: Map<string, ManagementFetchRoute>): Promise<{
  pendingRotations?: Array<{ deviceId: string; name: string }>
}> {
  const registered = await waitFor(() => routes.has(DASHBOARD_PATH))
  expect(registered, 'the management dashboard route was never registered').toBe(true)
  const route = routes.get(DASHBOARD_PATH)
  if (route === undefined) throw new Error('route vanished: dashboard')
  const response = await route.fetch(
    new Request(`http://127.0.0.1${DASHBOARD_PATH}`, {
      headers: { host: '127.0.0.1', accept: 'application/json' },
    }),
  )
  expect(response.status).toBe(200)
  return (await response.json()) as { pendingRotations?: Array<{ deviceId: string; name: string }> }
}

describe('devices.self (P7-H7, RCP/1 §7)', () => {
  it('returns the caller’s own paired-device view', async () => {
    const { server } = await mountHostWithPairedDevice()

    const res = await request(server, DEVICE_A_ID, 1, 'devices.self', {})
    expect(res.ok, `devices.self failed: ${JSON.stringify(res.e)}`).toBe(true)
    expect(res.r).toEqual({
      id: DEVICE_A_ID,
      name: 'Pixel 8',
      pairedAt: 1_000,
      // The host cannot observe the phone's keystore: unknown from here.
      approvalKey: { hardwareBacked: null },
    })
  }, 15_000)

  it('fails closed for an unknown or revoked caller', async () => {
    const { server } = await mountHostWithPairedDevice()

    const unknown = await request(server, UNKNOWN_DEVICE_ID, 2, 'devices.self', {})
    expect(unknown.ok).toBe(false)
    expect(unknown.e?.code).toBe('forbidden')

    const revoked = await request(server, DEVICE_B_ID, 3, 'devices.self', {})
    expect(revoked.ok).toBe(false)
    expect(revoked.e?.code).toBe('forbidden')
  }, 15_000)
})

describe('devices.unpair (P7-H7, RCP/1 §7, crypto-v1.md §10)', () => {
  it('revokes the caller and drops its secrets and preferences in one record write', async () => {
    const ctx = new Context()
    const credentials = credentialsWithPairedDevice()
    await provideFakeDshServices(ctx, {
      typertGateway: createFakeTypertGateway(),
      storage: createFakeStorage(),
    })
    await ctx.plugin({
      apply: (serviceCtx: Context) => void serviceCtx.provide('credentials', credentials),
    })
    const messages = captureLogs(ctx)
    const fiber = await ctx.plugin(
      host,
      createValidHostConfig({ relayUrl: `http://127.0.0.1:${await reserveClosedPort()}` }),
    )
    cleanups.push(async () => {
      if (fiber.state !== FIBER_STATE_DISPOSED) await fiber.dispose()
    })
    const server = ctx['remora-rcp-server']
    expect(server).toBeDefined()
    if (server === undefined) throw new Error('unreachable: the assertion above failed')

    const res = await request(server, DEVICE_A_ID, 1, 'devices.unpair', { requestId: ROTATION_REQUEST_ID })
    expect(res.ok, `devices.unpair failed: ${JSON.stringify(res.e)}`).toBe(true)
    expect(res.r).toEqual({ ok: true })

    // The authoritative revocation write (crypto-v1.md §10): revoked flag set,
    // and the device's PSK, push key, and preferences dropped by the very same
    // whole-record write — never stored for a revoked device.
    const dropped = await waitFor(async () => {
      const payload = await readStoredPayload(credentials)
      const device = storedDevice(payload, DEVICE_A_ID)
      return device.revoked === true && device.devicePsk === undefined && device.pushKey === undefined
    })
    expect(dropped, 'the revocation write did not drop the device secrets atomically').toBe(true)
    const payload = await readStoredPayload(credentials)
    expect(storedDevice(payload, DEVICE_A_ID).revoked).toBe(true)
    expect(payload.notifyPrefs[DEVICE_A_ID]).toBeUndefined()

    // The unpaired device's key material never reaches the log (AGENTS.md §1.8).
    for (const message of messages) {
      const text = renderedArgs(message)
      expect(text, 'device key material leaked into a log record').not.toContain(encodeBase64Url(PSK_SEED))
      expect(text, 'device key material leaked into a log record').not.toContain(encodeBase64Url(PUSH_KEY_SEED))
    }
  }, 15_000)

  it('refuses a second unpair once the caller is revoked (fail closed)', async () => {
    const { credentials, server } = await mountHostWithPairedDevice()

    const first = await request(server, DEVICE_A_ID, 1, 'devices.unpair', { requestId: ROTATION_REQUEST_ID })
    expect(first.ok).toBe(true)
    await waitFor(async () => storedDevice(await readStoredPayload(credentials), DEVICE_A_ID).revoked === true)

    const second = await request(server, DEVICE_A_ID, 2, 'devices.unpair', { requestId: ROTATION_REQUEST_ID_2 })
    expect(second.ok, 'a revoked device must not unpair again').toBe(false)
    expect(second.e?.code).toBe('forbidden')
  }, 15_000)
})

describe('devices.rotateApprovalKey (P7-H7, crypto-v1.md §10)', () => {
  it('answers pending_pc_confirmation and activates the key only after the management page confirms', async () => {
    const { credentials, routes, server } = await mountHostWithPairedDevice()

    const res = await request(server, DEVICE_A_ID, 1, 'devices.rotateApprovalKey', {
      approvalPub: encodeBase64Url(KEY_NEW),
      requestId: ROTATION_REQUEST_ID,
    })
    expect(res.ok, `rotateApprovalKey failed: ${JSON.stringify(res.e)}`).toBe(true)
    expect(res.r).toEqual({ status: 'pending_pc_confirmation' })

    // The management page shows the pending confirmation.
    const dashboard = await dashboardBody(routes)
    expect(dashboard.pendingRotations).toEqual([
      expect.objectContaining({ deviceId: DEVICE_A_ID, name: 'Pixel 8' }),
    ])

    // The key is NOT active while pending: the stored record keeps the old one.
    const payloadWhilePending = await readStoredPayload(credentials)
    expect(storedDevice(payloadWhilePending, DEVICE_A_ID).approvalPublicKey).toBe(encodeBase64Url(KEY_OLD))

    // PC confirmation (the Confirm route) activates the new key through the
    // registry's atomic record write.
    const confirmed = await postAction(routes, ROTATION_CONFIRM_PATH, { deviceId: DEVICE_A_ID })
    expect(confirmed.status, `confirm failed: ${JSON.stringify(confirmed.body)}`).toBe(200)

    const activated = await waitFor(async () => {
      const payload = await readStoredPayload(credentials)
      return storedDevice(payload, DEVICE_A_ID).approvalPublicKey === encodeBase64Url(KEY_NEW)
    })
    expect(activated, 'the new approval key never became active after PC confirmation').toBe(true)

    const dashboardAfter = await dashboardBody(routes)
    expect(dashboardAfter.pendingRotations).toEqual([])
  }, 15_000)

  it('leaves the old key active when the PC rejects or never confirms', async () => {
    const { credentials, routes, server } = await mountHostWithPairedDevice()

    const res = await request(server, DEVICE_A_ID, 1, 'devices.rotateApprovalKey', {
      approvalPub: encodeBase64Url(KEY_NEW),
      requestId: ROTATION_REQUEST_ID,
    })
    expect(res.ok).toBe(true)

    const rejected = await postAction(routes, ROTATION_REJECT_PATH, { deviceId: DEVICE_A_ID })
    expect(rejected.status).toBe(200)

    const payload = await readStoredPayload(credentials)
    expect(storedDevice(payload, DEVICE_A_ID).approvalPublicKey).toBe(encodeBase64Url(KEY_OLD))
    const dashboard = await dashboardBody(routes)
    expect(dashboard.pendingRotations).toEqual([])

    // Nothing is left to confirm afterwards.
    const lateConfirm = await postAction(routes, ROTATION_CONFIRM_PATH, { deviceId: DEVICE_A_ID })
    expect(lateConfirm.status).toBe(409)
  }, 15_000)

  it('validates the approval public key shape and encoding (fail closed)', async () => {
    const { server } = await mountHostWithPairedDevice()

    const notP256 = await request(server, DEVICE_A_ID, 1, 'devices.rotateApprovalKey', {
      approvalPub: encodeBase64Url(new Uint8Array(64).fill(4)),
      requestId: ROTATION_REQUEST_ID,
    })
    expect(notP256.ok).toBe(false)
    expect(notP256.e?.code).toBe('invalid_params')

    const wrongPrefix = await request(server, DEVICE_A_ID, 2, 'devices.rotateApprovalKey', {
      approvalPub: encodeBase64Url(KEY_NEW.subarray(0, 65).map((byte, index) => (index === 0 ? 0x03 : byte))),
      requestId: ROTATION_REQUEST_ID,
    })
    expect(wrongPrefix.ok).toBe(false)
    expect(wrongPrefix.e?.code).toBe('invalid_params')

    const garbage = await request(server, DEVICE_A_ID, 3, 'devices.rotateApprovalKey', {
      approvalPub: '!!!not-base64url!!!',
      requestId: ROTATION_REQUEST_ID,
    })
    expect(garbage.ok).toBe(false)
    expect(garbage.e?.code).toBe('invalid_params')
  }, 15_000)

  // Own mount: the per-device limit is 5 mutating requests/s (RCP/1 §11), and
  // this test sends three of its own.
  it('honors the requestId exactly-once and allows one pending rotation per device', async () => {
    const { server } = await mountHostWithPairedDevice()

    const first = await request(server, DEVICE_A_ID, 1, 'devices.rotateApprovalKey', {
      approvalPub: encodeBase64Url(KEY_NEW),
      requestId: ROTATION_REQUEST_ID,
    })
    expect(first.ok).toBe(true)

    // A retry with the SAME requestId is the same request (exactly-once).
    const retry = await request(server, DEVICE_A_ID, 2, 'devices.rotateApprovalKey', {
      approvalPub: encodeBase64Url(KEY_NEW),
      requestId: ROTATION_REQUEST_ID,
    })
    expect(retry.ok).toBe(true)
    expect(retry.r).toEqual({ status: 'pending_pc_confirmation' })

    // A different requestId while one is pending conflicts.
    const second = await request(server, DEVICE_A_ID, 3, 'devices.rotateApprovalKey', {
      approvalPub: encodeBase64Url(KEY_NEW),
      requestId: ROTATION_REQUEST_ID_2,
    })
    expect(second.ok, 'a second pending rotation must conflict').toBe(false)
    expect(second.e?.code).toBe('conflict')
  }, 15_000)

  it('answers 409 on confirm and reports nothing to reject without a pending rotation', async () => {
    const { routes } = await mountHostWithPairedDevice()

    const confirm = await postAction(routes, ROTATION_CONFIRM_PATH, { deviceId: DEVICE_A_ID })
    expect(confirm.status).toBe(409)

    const reject = await postAction(routes, ROTATION_REJECT_PATH, { deviceId: DEVICE_A_ID })
    expect(reject.status).toBe(200)
    expect(reject.body).toEqual({ ok: true, rejected: false })
  }, 15_000)
})

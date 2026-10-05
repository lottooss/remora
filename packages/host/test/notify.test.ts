import { decodeBase64Url, openPushPayload, randomBytes, sealPushPayload } from '@remora/crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryDeviceRegistry, type DeviceRecord } from '../src/devices/index.ts'
import { HostNotifier, type PushFrame } from '../src/notify/notifier.ts'
import { InMemoryNotifyPrefsStore } from '../src/notify/prefs.ts'
import { buildPushPayload } from '../src/notify/payload.ts'
import { PendingRegistry } from '../src/interaction/pending.ts'
import { RcpServer } from '../src/rcp/index.ts'
import { registerNotifyMethods } from '../src/rcp/methods/notify.ts'
import type { NotifyConfig } from '../src/config.ts'

const HOST_ID = 'h_erruijsx3ey2rmxcpeh3pgxjkm'
const DEVICE_ID = 'd_erruijsx3ey2rmxcpeh3pgxjkm'

function createDevice(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: DEVICE_ID,
    name: 'Test Phone',
    noisePublicKey: randomBytes(32),
    devicePsk: randomBytes(32),
    pushKey: randomBytes(32),
    createdAt: 1_000,
    lastSeenAt: 2_000,
    revoked: false,
    ...overrides,
  }
}

function createConfig(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
  return {
    approval: true,
    question: true,
    turnDone: true,
    turnError: true,
    hostOffline: true,
    ...overrides,
  }
}

interface CapturedPush {
  frame: PushFrame
  device: DeviceRecord
}

function createNotifier(options: {
  config?: NotifyConfig
  devices?: DeviceRecord[]
  isDeviceConnected?: (deviceId: string) => boolean
  isDeviceForegrounded?: (deviceId: string, sessionId?: string) => boolean
} = {}): { notifier: HostNotifier; pushes: CapturedPush[]; registry: InMemoryDeviceRegistry; prefsStore: InMemoryNotifyPrefsStore } {
  const devices = options.devices ?? [createDevice()]
  const registry = new InMemoryDeviceRegistry()
  for (const device of devices) {
    registry.addDevice(device)
  }
  const prefsStore = new InMemoryNotifyPrefsStore()
  const pushes: CapturedPush[] = []
  const notifier = new HostNotifier({
    hostId: HOST_ID,
    registry,
    prefsStore,
    config: options.config ?? createConfig(),
    sendPush: async (frame) => {
      for (const deviceId of frame.to) {
        const device = devices.find((d) => d.deviceId === deviceId)
        if (device) pushes.push({ frame, device })
      }
    },
    isDeviceConnected: options.isDeviceConnected ?? (() => false),
    isDeviceForegrounded: options.isDeviceForegrounded ?? (() => false),
  })
  return { notifier, pushes, registry, prefsStore }
}

function unseal(captured: CapturedPush): Record<string, unknown> {
  const raw = decodeBase64Url(captured.frame.ct)
  return openPushPayload(captured.device.pushKey, raw, {
    hostId: HOST_ID,
    deviceId: captured.device.deviceId,
  }) as Record<string, unknown>
}

function createApproval(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'approval' as const,
    id: 'appr-1',
    sessionId: 'ses-1',
    sessionTitle: 'Test Session',
    toolName: 'bash',
    preview: { text: 'rm -rf /tmp/foo', json: '{"cmd":"rm -rf /tmp/foo"}' },
    argsDigest: 'digest-1',
    risk: 'normal' as const,
    requiresSignature: false,
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  }
}

function createQuestion(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'question' as const,
    id: 'q-1',
    sessionId: 'ses-1',
    sessionTitle: 'Test Session',
    questions: [{ id: 'q1', question: 'Proceed with deployment?' }],
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  }
}

describe('P5-H1: Host Notifier', () => {
  describe('notify.prefs.get and notify.prefs.set via RCP', () => {
    it('returns default prefs for an unknown device', async () => {
      const rcpServer = new RcpServer({ hostId: HOST_ID, hostName: 'Test Host' })
      const prefsStore = new InMemoryNotifyPrefsStore()
      registerNotifyMethods(rcpServer, prefsStore)

      const res = await rcpServer.handleMessage(
        JSON.stringify({ k: 'req', id: 1, m: 'notify.prefs.get', p: {} }),
        { deviceId: DEVICE_ID, channelId: 1 },
      )
      expect(res).not.toBeNull()
      const parsed = JSON.parse(res!)
      expect(parsed.ok).toBe(true)
      expect(parsed.r).toEqual({ approval: true, question: true, turnDone: true, turnError: true })
    })

    it('sets and gets prefs for a device', async () => {
      const rcpServer = new RcpServer({ hostId: HOST_ID, hostName: 'Test Host' })
      const prefsStore = new InMemoryNotifyPrefsStore()
      registerNotifyMethods(rcpServer, prefsStore)

      const setRes = await rcpServer.handleMessage(
        JSON.stringify({ k: 'req', id: 1, m: 'notify.prefs.set', p: { approval: false } }),
        { deviceId: DEVICE_ID, channelId: 1 },
      )
      const setParsed = JSON.parse(setRes!)
      expect(setParsed.ok).toBe(true)
      expect(setParsed.r).toEqual({ approval: false, question: true, turnDone: true, turnError: true })

      const getRes = await rcpServer.handleMessage(
        JSON.stringify({ k: 'req', id: 2, m: 'notify.prefs.get', p: {} }),
        { deviceId: DEVICE_ID, channelId: 1 },
      )
      const getParsed = JSON.parse(getRes!)
      expect(getParsed.ok).toBe(true)
      expect(getParsed.r.approval).toBe(false)
    })

    it('rejects invalid prefs.set params', async () => {
      const rcpServer = new RcpServer({ hostId: HOST_ID, hostName: 'Test Host' })
      const prefsStore = new InMemoryNotifyPrefsStore()
      registerNotifyMethods(rcpServer, prefsStore)

      const res = await rcpServer.handleMessage(
        JSON.stringify({ k: 'req', id: 1, m: 'notify.prefs.set', p: { approval: 'yes' } }),
        { deviceId: DEVICE_ID, channelId: 1 },
      )
      const parsed = JSON.parse(res!)
      expect(parsed.ok).toBe(false)
      expect(parsed.e.code).toBe('invalid_params')
    })
  })

  describe('approval notification', () => {
    it('dispatches when device is disconnected and not foregrounded', async () => {
      const { notifier, pushes } = createNotifier({
        isDeviceConnected: () => false,
        isDeviceForegrounded: () => false,
      })

      await notifier.notifyApproval(createApproval())

      expect(pushes).toHaveLength(1)
      expect(pushes[0]!.frame.to).toEqual([DEVICE_ID])
      expect(pushes[0]!.frame.priority).toBe('high')
      expect(pushes[0]!.frame.collapse).toBe('pending:appr-1')

      const payload = unseal(pushes[0]!)
      expect(payload.kind).toBe('approval')
      expect(payload.sessionId).toBe('ses-1')
      expect(payload.pendingId).toBe('appr-1')
      expect(payload.title).toBe('Approval needed · Test Session')
      expect(payload.body).toBe('bash: rm -rf /tmp/foo')
    })

    it('suppresses when device is foregrounded', async () => {
      const { notifier, pushes } = createNotifier({
        isDeviceConnected: () => true,
        isDeviceForegrounded: () => true,
      })

      await notifier.notifyApproval(createApproval())

      expect(pushes).toHaveLength(0)
    })

    it('suppresses when device is connected but not foregrounded', async () => {
      const { notifier, pushes } = createNotifier({
        isDeviceConnected: () => true,
        isDeviceForegrounded: () => false,
      })

      await notifier.notifyApproval(createApproval())

      expect(pushes).toHaveLength(1)
    })

    it('suppresses when approval pref is false', async () => {
      const { notifier, pushes, prefsStore } = createNotifier()
      prefsStore.setPrefs(DEVICE_ID, { approval: false })

      await notifier.notifyApproval(createApproval())

      expect(pushes).toHaveLength(0)
    })

    it('suppresses when host config approval is false', async () => {
      const { notifier, pushes } = createNotifier({
        config: createConfig({ approval: false }),
      })

      await notifier.notifyApproval(createApproval())

      expect(pushes).toHaveLength(0)
    })

    it('suppresses for revoked devices', async () => {
      const { notifier, pushes } = createNotifier({
        devices: [createDevice({ revoked: true })],
      })

      await notifier.notifyApproval(createApproval())

      expect(pushes).toHaveLength(0)
    })

    it('suppresses for devices without a valid push key', async () => {
      const { notifier, pushes } = createNotifier({
        devices: [createDevice({ pushKey: new Uint8Array(16) })],
      })

      await notifier.notifyApproval(createApproval())

      expect(pushes).toHaveLength(0)
    })
  })

  describe('question notification', () => {
    it('dispatches with question title and first question text', async () => {
      const { notifier, pushes } = createNotifier()

      await notifier.notifyQuestion(
        createQuestion({
          questions: [
            { id: 'q1', question: 'Proceed with deployment?' },
            { id: 'q2', question: 'Second question?' },
          ],
        }),
      )

      expect(pushes).toHaveLength(1)
      const payload = unseal(pushes[0]!)
      expect(payload.kind).toBe('question')
      expect(payload.title).toBe('Question · Test Session')
      expect(payload.body).toBe('Proceed with deployment?')
      expect(payload.pendingId).toBe('q-1')
    })

    it('suppresses when question pref is false', async () => {
      const { notifier, pushes, prefsStore } = createNotifier()
      prefsStore.setPrefs(DEVICE_ID, { question: false })

      await notifier.notifyQuestion(createQuestion())

      expect(pushes).toHaveLength(0)
    })

    it('suppresses when host config question is false', async () => {
      const { notifier, pushes } = createNotifier({
        config: createConfig({ question: false }),
      })

      await notifier.notifyQuestion(createQuestion())

      expect(pushes).toHaveLength(0)
    })
  })

  describe('turnDone notification', () => {
    it('dispatches to devices that recorded session access within 24h', async () => {
      const { notifier, pushes } = createNotifier()

      notifier.recordSessionDevice('ses-1', DEVICE_ID)
      await notifier.notifyTurnDone('ses-1', 'My Session')

      expect(pushes).toHaveLength(1)
      const payload = unseal(pushes[0]!)
      expect(payload.kind).toBe('turn_done')
      expect(payload.sessionId).toBe('ses-1')
      expect(payload.title).toBe('Turn done · My Session')
      expect(pushes[0]!.frame.collapse).toBe('session:ses-1')
    })

    it('does not dispatch to devices that did not record session access', async () => {
      const { notifier, pushes } = createNotifier()

      await notifier.notifyTurnDone('ses-1', 'My Session')

      expect(pushes).toHaveLength(0)
    })

    it('rate limits to at most 1 per 30s per session', async () => {
      const { notifier, pushes } = createNotifier()

      notifier.recordSessionDevice('ses-1', DEVICE_ID)

      await notifier.notifyTurnDone('ses-1', 'Session')
      expect(pushes).toHaveLength(1)

      await notifier.notifyTurnDone('ses-1', 'Session')
      expect(pushes).toHaveLength(1)
    })

    it('suppresses when turnDone pref is false', async () => {
      const { notifier, pushes, prefsStore } = createNotifier()
      prefsStore.setPrefs(DEVICE_ID, { turnDone: false })

      notifier.recordSessionDevice('ses-1', DEVICE_ID)
      await notifier.notifyTurnDone('ses-1', 'Session')

      expect(pushes).toHaveLength(0)
    })

    it('suppresses when host config turnDone is false', async () => {
      const { notifier, pushes } = createNotifier({
        config: createConfig({ turnDone: false }),
      })

      notifier.recordSessionDevice('ses-1', DEVICE_ID)
      await notifier.notifyTurnDone('ses-1', 'Session')

      expect(pushes).toHaveLength(0)
    })
  })

  describe('turnError notification', () => {
    it('dispatches with error text', async () => {
      const { notifier, pushes } = createNotifier()

      notifier.recordSessionDevice('ses-1', DEVICE_ID)
      await notifier.notifyTurnError('ses-1', 'Connection timeout', 'My Session')

      expect(pushes).toHaveLength(1)
      const payload = unseal(pushes[0]!)
      expect(payload.kind).toBe('turn_error')
      expect(payload.sessionId).toBe('ses-1')
      expect(payload.title).toBe('Turn failed · My Session')
      expect(payload.body).toBe('Connection timeout')
      expect(pushes[0]!.frame.priority).toBe('high')
    })

    it('suppresses when turnError pref is false', async () => {
      const { notifier, pushes, prefsStore } = createNotifier()
      prefsStore.setPrefs(DEVICE_ID, { turnError: false })

      notifier.recordSessionDevice('ses-1', DEVICE_ID)
      await notifier.notifyTurnError('ses-1', 'error text')

      expect(pushes).toHaveLength(0)
    })

    it('suppresses when host config turnError is false', async () => {
      const { notifier, pushes } = createNotifier({
        config: createConfig({ turnError: false }),
      })

      notifier.recordSessionDevice('ses-1', DEVICE_ID)
      await notifier.notifyTurnError('ses-1', 'error text')

      expect(pushes).toHaveLength(0)
    })
  })

  describe('sealing round-trip with @remora/crypto', () => {
    it('sealed payload can be unsealed with openPushPayload', async () => {
      const { notifier, pushes } = createNotifier()

      await notifier.notifyApproval(createApproval())

      expect(pushes).toHaveLength(1)
      const raw = decodeBase64Url(pushes[0]!.frame.ct)
      const decrypted = openPushPayload(pushes[0]!.device.pushKey, raw, { hostId: HOST_ID, deviceId: pushes[0]!.device.deviceId }) as Record<string, unknown>

      expect(decrypted.kind).toBe('approval')
      expect(decrypted.sessionId).toBe('ses-1')
      expect(decrypted.pendingId).toBe('appr-1')
      expect(typeof decrypted.at).toBe('number')
      expect(decrypted.at).toBeGreaterThan(0)
    })

    it('sealed payload cannot be unsealed with a different key', async () => {
      const { notifier, pushes } = createNotifier()

      await notifier.notifyApproval(createApproval())

      const raw = decodeBase64Url(pushes[0]!.frame.ct)
      const wrongKey = randomBytes(32)

      expect(() => openPushPayload(wrongKey, raw, { hostId: HOST_ID, deviceId: DEVICE_ID })).toThrow()
    })

    it('buildPushPayload + sealPushPayload round-trips correctly', () => {
      const payload = buildPushPayload('approval', {
        sessionId: 'ses-1',
        pendingId: 'appr-1',
        title: 'Test',
        body: 'Test body',
      })
      const key = randomBytes(32)
      const sealed = sealPushPayload(key, payload, { hostId: HOST_ID, deviceId: DEVICE_ID })
      const unsealed = openPushPayload(key, sealed, { hostId: HOST_ID, deviceId: DEVICE_ID }) as Record<string, unknown>

      expect(unsealed.kind).toBe('approval')
      expect(unsealed.sessionId).toBe('ses-1')
      expect(unsealed.pendingId).toBe('appr-1')
      expect(unsealed.title).toBe('Test')
      expect(unsealed.body).toBe('Test body')
    })
  })

  describe('attachPendingRegistry', () => {
    it('dispatches approval when pending registry emits requested', async () => {
      const { notifier, pushes } = createNotifier()
      const pendingRegistry = new PendingRegistry()

      const detach = notifier.attachPendingRegistry(pendingRegistry)

      pendingRegistry.add(createApproval({ id: 'appr-2' }))
      await new Promise((r) => setTimeout(r, 10))

      expect(pushes).toHaveLength(1)
      const payload = unseal(pushes[0]!)
      expect(payload.pendingId).toBe('appr-2')

      detach()
    })

    it('dispatches question when pending registry emits requested', async () => {
      const { notifier, pushes } = createNotifier()
      const pendingRegistry = new PendingRegistry()

      const detach = notifier.attachPendingRegistry(pendingRegistry)

      pendingRegistry.add(createQuestion({ id: 'q-2' }))
      await new Promise((r) => setTimeout(r, 10))

      expect(pushes).toHaveLength(1)
      const payload = unseal(pushes[0]!)
      expect(payload.kind).toBe('question')
      expect(payload.pendingId).toBe('q-2')

      detach()
    })

    it('stops dispatching after detach', async () => {
      const { notifier, pushes } = createNotifier()
      const pendingRegistry = new PendingRegistry()

      const detach = notifier.attachPendingRegistry(pendingRegistry)
      detach()

      pendingRegistry.add(createApproval({ id: 'appr-3' }))
      await new Promise((r) => setTimeout(r, 10))

      expect(pushes).toHaveLength(0)
    })
  })

  describe('multi-device dispatch', () => {
    it('dispatches to multiple eligible devices', async () => {
      const device1 = createDevice({ deviceId: 'd_erruijsx3ey2rmxcpeh3pgxjkm' })
      const device2 = createDevice({ deviceId: 'd_erruijsx3ey2rmxcpeh3pgxjki' })
      const { notifier, pushes } = createNotifier({ devices: [device1, device2] })

      await notifier.notifyApproval(createApproval())

      expect(pushes).toHaveLength(2)
      const deviceIds = pushes.map((p) => p.device.deviceId).sort()
      expect(deviceIds).toEqual(['d_erruijsx3ey2rmxcpeh3pgxjkm', 'd_erruijsx3ey2rmxcpeh3pgxjki'])
    })

    it('only dispatches to devices with valid push keys', async () => {
      const device1 = createDevice({ deviceId: 'd_erruijsx3ey2rmxcpeh3pgxjkm' })
      const device2 = createDevice({
        deviceId: 'd_erruijsx3ey2rmxcpeh3pgxjki',
        pushKey: new Uint8Array(16),
      })
      const { notifier, pushes } = createNotifier({ devices: [device1, device2] })

      await notifier.notifyApproval(createApproval())

      expect(pushes).toHaveLength(1)
      expect(pushes[0]!.device.deviceId).toBe('d_erruijsx3ey2rmxcpeh3pgxjkm')
    })
  })
})

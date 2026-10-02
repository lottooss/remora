/**
 * P7-H4 acceptance tests: the paired-device registry and the per-device
 * notification preferences persist in the dsh credentials record
 * `remora/devices` (docs/tasks/P7-H4.md; crypto-v1.md §3 stores devicePsk and
 * pushKey in dsh credentials, §9 "secrets only through ctx.credentials
 * records", §10 revocation deletes the device's secrets).
 *
 * `loadPersistentDeviceRegistry` must read the record, create it atomically
 * when absent (the loadOrCreateHostIdentity pattern of P7-H2), admit a paired
 * device again after a reload from the same store, delete a revoked device's
 * secrets in the very write that revokes it so the revocation survives a
 * restart, keep the per-device notify preferences across a restart, and fail
 * closed on a stored record it cannot parse. Secret material never appears in
 * logs or error messages (AGENTS.md §1.8).
 */
import { encodeBase64Url } from '@remora/crypto'
import { describe, expect, it } from 'vitest'
import {
  DEVICES_RECORD_KEY,
  DeviceRegistryRecordError,
  loadPersistentDeviceRegistry,
  type DeviceRecord,
} from '../../src/devices/index.ts'
import { DEFAULT_NOTIFY_PREFS } from '../../src/notify/prefs.ts'
import type { FakeCredentialRecord, FakeGrantRecord } from '../identity/fake-credentials.ts'
import { createInMemoryCredentialsStore } from '../identity/fake-credentials.ts'

/** The stored device record shape the credentials record carries (b64u keys). */
interface StoredDevice {
  deviceId: string
  name: string
  noisePublicKey: string
  devicePsk?: string
  pushKey?: string
  approvalPublicKey?: string
  createdAt: number
  lastSeenAt: number
  revoked: boolean
}

interface StoredPayload {
  v: number
  devices: StoredDevice[]
  notifyPrefs: Record<string, Record<string, boolean>>
}

/** Fixed, obviously fake test keys (AGENTS.md §10); never real key material. */
function key(fill: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(fill)
}

/** One paired-but-active device record as pairing would produce it. */
function activeDevice(): DeviceRecord {
  return {
    deviceId: 'd_abcdefghijklmnopqrstuvwxyz',
    name: 'Pixel 8',
    noisePublicKey: key(1),
    devicePsk: key(2),
    pushKey: key(3),
    approvalPublicKey: key(4, 65),
    createdAt: 1_000,
    lastSeenAt: 2_000,
    revoked: false,
  }
}

/** A second device id in the endpoint-id shape (crypto-v1.md §2). */
const SECOND_DEVICE_ID = 'd_mzxw6ytboirx24dhmzxw6ytboi'

/** Builds a grant record with the given payload. */
function grant(payload: unknown): FakeCredentialRecord {
  return { kind: 'grant', payload } satisfies FakeGrantRecord
}

/** The `remora/devices` payload as the persistent registry serializes it. */
function storedPayload(record: FakeCredentialRecord | undefined): StoredPayload {
  expect(record?.kind).toBe('grant')
  return (record as FakeGrantRecord).payload as StoredPayload
}

/** One stored active-device entry matching the activeDevice() record. */
function storedActiveDevice(): StoredDevice {
  return {
    deviceId: 'd_abcdefghijklmnopqrstuvwxyz',
    name: 'Pixel 8',
    noisePublicKey: encodeBase64Url(key(1)),
    devicePsk: encodeBase64Url(key(2)),
    pushKey: encodeBase64Url(key(3)),
    approvalPublicKey: encodeBase64Url(key(4, 65)),
    createdAt: 1_000,
    lastSeenAt: 2_000,
    revoked: false,
  }
}

describe('loadPersistentDeviceRegistry', () => {
  it('creates the record when absent and admits a paired device again after a reload', async () => {
    const store = createInMemoryCredentialsStore()

    const first = await loadPersistentDeviceRegistry(store)
    expect(await store.readRecord(DEVICES_RECORD_KEY), 'the empty record must be created on first start').toBeDefined()

    const device = activeDevice()
    first.addDevice(device)
    await first.flush()

    // A restart: a fresh registry over the SAME credentials store.
    const second = await loadPersistentDeviceRegistry(store)

    const reloaded = second.getDeviceById(device.deviceId)
    expect(reloaded, 'the paired device must be admitted again after the reload').not.toBeNull()
    expect(reloaded?.deviceId).toBe(device.deviceId)
    expect(reloaded?.name).toBe('Pixel 8')
    expect(reloaded?.revoked).toBe(false)
    expect(reloaded?.createdAt).toBe(1_000)
    expect(reloaded?.lastSeenAt).toBe(2_000)
    expect(reloaded?.noisePublicKey).toEqual(device.noisePublicKey)
    expect(reloaded?.devicePsk).toEqual(device.devicePsk)
    expect(reloaded?.pushKey).toEqual(device.pushKey)
    expect(reloaded?.approvalPublicKey).toEqual(device.approvalPublicKey)
    // The session-admission lookup (crypto-v1.md §6) goes through the noise key.
    expect(second.getDeviceByNoiseKey(device.noisePublicKey)?.deviceId).toBe(device.deviceId)
  })

  it('deletes the device secrets in the revocation write and the revocation survives a reload', async () => {
    const store = createInMemoryCredentialsStore()
    const first = await loadPersistentDeviceRegistry(store)

    const device = activeDevice()
    first.addDevice(device)
    first.revokeDevice(device.deviceId)
    await first.flush()

    // The write that revokes is the same write that drops the secrets.
    const payload = storedPayload(await store.readRecord(DEVICES_RECORD_KEY))
    expect(payload.devices).toHaveLength(1)
    expect(payload.devices[0]?.revoked).toBe(true)
    expect(payload.devices[0]?.name).toBe('Pixel 8')
    expect(payload.devices[0]?.devicePsk).toBeUndefined()
    expect(payload.devices[0]?.pushKey).toBeUndefined()

    const second = await loadPersistentDeviceRegistry(store)
    const reloaded = second.getDeviceById(device.deviceId)
    expect(reloaded?.revoked, 'the revocation must survive the restart').toBe(true)
    expect(second.getDeviceByNoiseKey(device.noisePublicKey)?.revoked).toBe(true)
  })

  it('serializes an add immediately followed by a revoke into the final state', async () => {
    const store = createInMemoryCredentialsStore()
    const registry = await loadPersistentDeviceRegistry(store)

    const device = activeDevice()
    registry.addDevice(device)
    registry.revokeDevice(device.deviceId)
    await registry.flush()

    const payload = storedPayload(await store.readRecord(DEVICES_RECORD_KEY))
    expect(payload.devices).toHaveLength(1)
    expect(payload.devices[0]?.revoked).toBe(true)
    expect(payload.devices[0]?.devicePsk).toBeUndefined()
    expect(payload.devices[0]?.pushKey).toBeUndefined()
  })

  it('keeps the per-device notify preferences across a reload', async () => {
    const store = createInMemoryCredentialsStore()
    const first = await loadPersistentDeviceRegistry(store)
    const device = activeDevice()
    first.addDevice(device)
    first.setPrefs(device.deviceId, { approval: false, turnDone: false })
    await first.flush()

    const second = await loadPersistentDeviceRegistry(store)

    expect(second.getPrefs(device.deviceId)).toEqual({
      approval: false,
      question: true,
      turnDone: false,
      turnError: true,
    })
    expect(second.getPrefs('d_zzzzzzzzzzzzzzzzzzzzzzzzzz')).toEqual(DEFAULT_NOTIFY_PREFS)
  })

  it("drops the revoked device's preferences in the revocation write", async () => {
    const store = createInMemoryCredentialsStore()
    const registry = await loadPersistentDeviceRegistry(store)
    const device = activeDevice()
    registry.addDevice(device)
    registry.setPrefs(device.deviceId, { turnError: false })
    registry.revokeDevice(device.deviceId)
    await registry.flush()

    const payload = storedPayload(await store.readRecord(DEVICES_RECORD_KEY))
    expect(payload.notifyPrefs[device.deviceId]).toBeUndefined()

    const second = await loadPersistentDeviceRegistry(store)
    expect(second.getPrefs(device.deviceId)).toEqual(DEFAULT_NOTIFY_PREFS)
  })

  it('persists a rename', async () => {
    const store = createInMemoryCredentialsStore()
    const first = await loadPersistentDeviceRegistry(store)
    const device = activeDevice()
    first.addDevice(device)
    first.renameDevice?.(device.deviceId, 'Pixel 9')
    await first.flush()

    const second = await loadPersistentDeviceRegistry(store)
    expect(second.getDeviceById(device.deviceId)?.name).toBe('Pixel 9')
  })

  it('reports a failed credentials write through onWriteError instead of losing it silently', async () => {
    const store = createInMemoryCredentialsStore()
    let failWrites = false
    const flaky = {
      readRecord: (key: string) => store.readRecord(key),
      async modifyRecord(
        key: string,
        mutate: (current: FakeCredentialRecord | undefined) => Promise<FakeCredentialRecord | undefined>,
      ) {
        if (failWrites) throw new Error('credentials store refused the write')
        return store.modifyRecord(key, mutate)
      },
      describeRecord: (key: string) => store.describeRecord(key),
      deleteRecord: (key: string) => store.deleteRecord(key),
    }
    const writeErrors: unknown[] = []
    const registry = await loadPersistentDeviceRegistry(flaky, {
      onWriteError: (error: unknown) => {
        writeErrors.push(error)
      },
    })

    failWrites = true
    registry.addDevice(activeDevice())
    await registry.flush()

    expect(writeErrors).toHaveLength(1)
    expect(writeErrors[0]).toBeInstanceOf(Error)
    // The stored record is unchanged (still the empty record of the load).
    expect(storedPayload(await store.readRecord(DEVICES_RECORD_KEY)).devices).toHaveLength(0)
    // The in-memory state keeps the device so the running session is unaffected.
    expect(registry.listDevices()).toHaveLength(1)
  })

  it('fails closed on a stored record it cannot parse and leaves it untouched', async () => {
    const cases: Array<{ name: string; record: FakeCredentialRecord }> = [
      { name: 'a non-grant record', record: { kind: 'api-key', key: 'sk-not-a-device-record' } },
      { name: 'an unknown payload version', record: grant({ v: 2, devices: [], notifyPrefs: {} }) },
      { name: 'a payload without a device array', record: grant({ v: 1, devices: 42, notifyPrefs: {} }) },
      {
        name: 'an active device without its PSK',
        record: grant({
          v: 1,
          devices: [
            {
              deviceId: 'd_abcdefghijklmnopqrstuvwxyz',
              name: 'Pixel 8',
              noisePublicKey: encodeBase64Url(key(1)),
              createdAt: 1,
              lastSeenAt: 2,
              revoked: false,
            },
          ],
          notifyPrefs: {},
        }),
      },
      {
        name: 'a device key that is not base64url',
        record: grant({
          v: 1,
          devices: [
            {
              deviceId: 'd_abcdefghijklmnopqrstuvwxyz',
              name: 'Pixel 8',
              noisePublicKey: 'not base64url!',
              devicePsk: encodeBase64Url(key(2)),
              pushKey: encodeBase64Url(key(3)),
              createdAt: 1,
              lastSeenAt: 2,
              revoked: false,
            },
          ],
          notifyPrefs: {},
        }),
      },
      {
        name: 'a PSK of the wrong length',
        record: grant({
          v: 1,
          devices: [
            {
              deviceId: 'd_abcdefghijklmnopqrstuvwxyz',
              name: 'Pixel 8',
              noisePublicKey: encodeBase64Url(key(1)),
              devicePsk: encodeBase64Url(key(2, 16)),
              pushKey: encodeBase64Url(key(3)),
              createdAt: 1,
              lastSeenAt: 2,
              revoked: false,
            },
          ],
          notifyPrefs: {},
        }),
      },
      {
        name: 'a duplicate device id',
        record: grant({
          v: 1,
          devices: [
            storedActiveDevice(),
            {
              deviceId: 'd_abcdefghijklmnopqrstuvwxyz',
              name: 'Clone',
              noisePublicKey: encodeBase64Url(key(5)),
              devicePsk: encodeBase64Url(key(6)),
              pushKey: encodeBase64Url(key(7)),
              createdAt: 3,
              lastSeenAt: 4,
              revoked: false,
            },
          ],
          notifyPrefs: {},
        }),
      },
    ]

    for (const { name, record } of cases) {
      const store = createInMemoryCredentialsStore({ [DEVICES_RECORD_KEY]: record })
      await expect(loadPersistentDeviceRegistry(store), `must fail closed on ${name}`).rejects.toBeInstanceOf(
        DeviceRegistryRecordError,
      )
      // Fail closed: a corrupt record is never silently replaced.
      expect(await store.readRecord(DEVICES_RECORD_KEY), `${name}: the record must stay untouched`).toBe(record)
    }
  })

  it('never puts key material into rejection messages', async () => {
    const leakedPsk = 'topsecret-psk-marker'
    const leakedPushKey = 'topsecret-pushkey-marker'
    const store = createInMemoryCredentialsStore({
      [DEVICES_RECORD_KEY]: grant({
        v: 1,
        devices: [
          {
            deviceId: 'd_abcdefghijklmnopqrstuvwxyz',
            name: 'Pixel 8',
            noisePublicKey: 'also-a-marker',
            devicePsk: leakedPsk,
            pushKey: leakedPushKey,
            createdAt: 1,
            lastSeenAt: 2,
            revoked: false,
          },
        ],
        notifyPrefs: {},
      }),
    })

    const outcome = await loadPersistentDeviceRegistry(store).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
    )

    expect(outcome).not.toContain(leakedPsk)
    expect(outcome).not.toContain(leakedPushKey)
  })

  it('loads a revoked entry that is stored without secrets', async () => {
    const store = createInMemoryCredentialsStore({
      [DEVICES_RECORD_KEY]: grant({
        v: 1,
        devices: [
          {
            deviceId: SECOND_DEVICE_ID,
            name: 'Old Phone',
            noisePublicKey: encodeBase64Url(key(5)),
            createdAt: 3_000,
            lastSeenAt: 4_000,
            revoked: true,
          },
        ],
        notifyPrefs: {},
      }),
    })

    const registry = await loadPersistentDeviceRegistry(store)

    const device = registry.getDeviceById(SECOND_DEVICE_ID)
    expect(device?.revoked).toBe(true)
    expect(device?.name).toBe('Old Phone')
    expect(registry.getDeviceByNoiseKey(key(5))?.revoked).toBe(true)
  })

  it('adopts the record a concurrent start created instead of overwriting it', async () => {
    const store = createInMemoryCredentialsStore()

    const [first, second] = await Promise.all([
      loadPersistentDeviceRegistry(store),
      loadPersistentDeviceRegistry(store),
    ])
    expect(await store.readRecord(DEVICES_RECORD_KEY)).toBeDefined()

    // Both registries work against the single record the race produced.
    first.addDevice(activeDevice())
    await first.flush()
    const third = await loadPersistentDeviceRegistry(store)
    expect(third.listDevices()).toHaveLength(1)
    expect(second.listDevices()).toHaveLength(0)
  })
})

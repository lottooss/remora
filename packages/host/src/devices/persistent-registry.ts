/**
 * Persistent paired-device registry and notify preferences in dsh credentials
 * (docs/tasks/P7-H4.md).
 *
 * Everything persists in the single dsh credentials record `remora/devices`
 * (crypto-v1.md §3 stores devicePsk/pushKey in dsh credentials, §9 "secrets
 * only through ctx.credentials records"): one grant payload holding the device
 * entries (public keys, names, revoked flags, and — for non-revoked devices —
 * the 32-byte devicePsk and pushKey) plus the per-device notify preferences.
 * Every change is written with `modifyRecord`, the seam's only write path,
 * whose mutation observes the committed record at the moment the write is
 * exclusive — so a revocation deletes the device's secrets in the very write
 * that revokes it, and there is no committed state where a revoked device's
 * secrets outlive the revocation (crypto-v1.md §10).
 *
 * A stored record that cannot be parsed fails closed with
 * {@link DeviceRegistryRecordError} instead of being replaced — starting over
 * with an empty registry would silently unpair every phone. Secret material
 * never appears in logs or error messages; error messages name fields and
 * entry indexes only (crypto-v1.md §9, AGENTS.md §1.8).
 *
 * The dsh side of the boundary is the record seam of `ctx.credentials`
 * (@deepseek-ai/dsh-credentials), declared structurally as
 * {@link HostCredentialsStore} exactly like the host-identity loader of
 * P7-H2 (packages/host/src/identity/credentials.ts), whose atomic
 * create-if-absent first write this module also mirrors.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bytesToHex, decodeBase64Url, encodeBase64Url, hexToBytes } from '@remora/crypto'
import type { NotifyPrefs } from '@remora/protocol'
import type { HostCredentialRecord, HostCredentialsStore } from '../identity/credentials.ts'
import type { NotifyPrefsStore } from '../notify/prefs.ts'
import { DEFAULT_NOTIFY_PREFS } from '../notify/prefs.ts'
import type { DeviceRecord, DeviceRegistry } from './index.ts'

/** dsh credentials record holding the paired devices and their prefs. */
export const DEVICES_RECORD_KEY = 'remora/devices'

/**
 * A stored devices record that cannot be used. Fail closed: callers must
 * never regenerate around it — an empty registry would silently unpair every
 * paired phone and let re-pairing create duplicate device identities.
 */
export class DeviceRegistryRecordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeviceRegistryRecordError'
  }
}

/** Callbacks for the credentials-backed registry. */
export interface PersistentDeviceRegistryOptions {
  /** Called when a credentials write fails; the in-memory state stays authoritative. */
  onWriteError?: ((error: unknown) => void) | undefined
}

/** One stored device entry; the secrets are absent once the device is revoked. */
interface StoredDeviceRecord {
  deviceId: string
  name: string
  /** 32-byte Noise static public key, base64url. */
  noisePublicKey: string
  /** 32-byte device PSK, base64url; never stored for a revoked device. */
  devicePsk?: string
  /** 32-byte push encryption key, base64url; never stored for a revoked device. */
  pushKey?: string
  /** Uncompressed P-256 approval public key, base64url, when present. */
  approvalPublicKey?: string
  createdAt: number
  lastSeenAt: number
  revoked: boolean
}

/** The `remora/devices` grant payload (one record for devices and prefs). */
interface DevicesPayload {
  v: 1
  devices: StoredDeviceRecord[]
  notifyPrefs: Record<string, NotifyPrefs>
}

/** The in-memory state parsed out of the stored record. */
interface ParsedDevicesState {
  devices: DeviceRecord[]
  notifyPrefs: Map<string, NotifyPrefs>
}

/** Device endpoint id: `d_` plus 26 lowercase base32 characters (crypto-v1.md §2). */
const DEVICE_ID_PATTERN = /^d_[a-z2-7]{26}$/

/** Builds the grant payload for the current in-memory state (JSON-safe). */
function devicesPayload(devices: Iterable<DeviceRecord>, notifyPrefs: Map<string, NotifyPrefs>): DevicesPayload {
  const stored: StoredDeviceRecord[] = []
  for (const device of devices) {
    const entry: StoredDeviceRecord = {
      deviceId: device.deviceId,
      name: device.name,
      noisePublicKey: encodeBase64Url(device.noisePublicKey),
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      revoked: device.revoked,
    }
    // The revocation write drops the secrets: a revoked device never has its
    // devicePsk or pushKey persisted (crypto-v1.md §10).
    if (!device.revoked) {
      entry.devicePsk = encodeBase64Url(device.devicePsk)
      entry.pushKey = encodeBase64Url(device.pushKey)
    }
    if (device.approvalPublicKey !== undefined) {
      entry.approvalPublicKey = encodeBase64Url(device.approvalPublicKey)
    }
    stored.push(entry)
  }
  return { v: 1, devices: stored, notifyPrefs: Object.fromEntries(notifyPrefs) }
}

/** Decodes one 32-byte base64url key field; the value never reaches the message. */
function decodeKeyField(entry: Record<string, unknown>, index: number, field: string): Uint8Array {
  const value = entry[field]
  if (typeof value !== 'string') {
    throw new DeviceRegistryRecordError(
      `dsh credentials record ${DEVICES_RECORD_KEY} device entry ${index} field ${field} must be a base64url string`,
    )
  }
  let decoded: Uint8Array
  try {
    decoded = decodeBase64Url(value)
  } catch {
    throw new DeviceRegistryRecordError(
      `dsh credentials record ${DEVICES_RECORD_KEY} device entry ${index} field ${field} is not canonical base64url`,
    )
  }
  if (decoded.length !== 32) {
    throw new DeviceRegistryRecordError(
      `dsh credentials record ${DEVICES_RECORD_KEY} device entry ${index} field ${field} must decode to 32 bytes`,
    )
  }
  return decoded
}

/** Rebuilds one device entry. Anything unexpected fails closed. */
function deviceFromStoredEntry(rawEntry: unknown, index: number): DeviceRecord {
  if (typeof rawEntry !== 'object' || rawEntry === null) {
    throw new DeviceRegistryRecordError(
      `dsh credentials record ${DEVICES_RECORD_KEY} device entry ${index} must be an object`,
    )
  }
  const entry = rawEntry as Record<string, unknown>
  if (typeof entry.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(entry.deviceId)) {
    throw new DeviceRegistryRecordError(
      `dsh credentials record ${DEVICES_RECORD_KEY} device entry ${index} deviceId is not a device endpoint id`,
    )
  }
  if (typeof entry.name !== 'string') {
    throw new DeviceRegistryRecordError(
      `dsh credentials record ${DEVICES_RECORD_KEY} device entry ${index} name must be a string`,
    )
  }
  if (
    typeof entry.revoked !== 'boolean' ||
    typeof entry.createdAt !== 'number' ||
    typeof entry.lastSeenAt !== 'number'
  ) {
    throw new DeviceRegistryRecordError(
      `dsh credentials record ${DEVICES_RECORD_KEY} device entry ${index} must carry boolean revoked and number timestamps`,
    )
  }
  const noisePublicKey = decodeKeyField(entry, index, 'noisePublicKey')
  // A non-revoked device needs its secrets to be admitted again; a revoked
  // one must not keep them — any secrets still stored for a revoked device
  // are dropped here and never loaded into memory (crypto-v1.md §10).
  const revoked = entry.revoked
  const devicePsk = revoked ? new Uint8Array(32) : decodeKeyField(entry, index, 'devicePsk')
  const pushKey = revoked ? new Uint8Array(32) : decodeKeyField(entry, index, 'pushKey')
  let approvalPublicKey: Uint8Array | undefined
  if (entry.approvalPublicKey !== undefined) {
    const value = entry.approvalPublicKey
    if (typeof value !== 'string') {
      throw new DeviceRegistryRecordError(
        `dsh credentials record ${DEVICES_RECORD_KEY} device entry ${index} field approvalPublicKey must be a base64url string`,
      )
    }
    try {
      approvalPublicKey = decodeBase64Url(value)
    } catch {
      throw new DeviceRegistryRecordError(
        `dsh credentials record ${DEVICES_RECORD_KEY} device entry ${index} field approvalPublicKey is not canonical base64url`,
      )
    }
  }
  return {
    deviceId: entry.deviceId,
    name: entry.name,
    noisePublicKey,
    devicePsk,
    pushKey,
    createdAt: entry.createdAt,
    lastSeenAt: entry.lastSeenAt,
    revoked,
    ...(approvalPublicKey === undefined ? {} : { approvalPublicKey }),
  }
}

/** Parses the per-device notify preferences; every entry must be complete. */
function parseNotifyPrefs(raw: unknown): Map<string, NotifyPrefs> {
  const prefs = new Map<string, NotifyPrefs>()
  if (raw === undefined) return prefs
  if (typeof raw !== 'object' || raw === null) {
    throw new DeviceRegistryRecordError(`dsh credentials record ${DEVICES_RECORD_KEY} notifyPrefs must be an object`)
  }
  for (const [deviceId, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) {
      throw new DeviceRegistryRecordError(
        `dsh credentials record ${DEVICES_RECORD_KEY} notifyPrefs entry for ${deviceId} must be an object`,
      )
    }
    const entry = value as Record<string, unknown>
    if (
      typeof entry.approval !== 'boolean' ||
      typeof entry.question !== 'boolean' ||
      typeof entry.turnDone !== 'boolean' ||
      typeof entry.turnError !== 'boolean'
    ) {
      throw new DeviceRegistryRecordError(
        `dsh credentials record ${DEVICES_RECORD_KEY} notifyPrefs entry for ${deviceId} must carry four booleans`,
      )
    }
    prefs.set(deviceId, {
      approval: entry.approval,
      question: entry.question,
      turnDone: entry.turnDone,
      turnError: entry.turnError,
    })
  }
  return prefs
}

/**
 * Rebuilds the state from a stored record. Anything but a grant carrying the
 * version-1 payload throws {@link DeviceRegistryRecordError} — a corrupt
 * record is never silently replaced or started over.
 */
function devicesStateFromRecord(record: HostCredentialRecord): ParsedDevicesState {
  if (record.kind !== 'grant') {
    throw new DeviceRegistryRecordError(
      `dsh credentials record ${DEVICES_RECORD_KEY} must be a grant record (found kind: ${record.kind})`,
    )
  }
  const payload: unknown = record.payload
  if (typeof payload !== 'object' || payload === null) {
    throw new DeviceRegistryRecordError(`dsh credentials record ${DEVICES_RECORD_KEY} payload must be an object`)
  }
  const raw = payload as Record<string, unknown>
  if (raw.v !== 1) {
    throw new DeviceRegistryRecordError(`dsh credentials record ${DEVICES_RECORD_KEY} payload version must be 1`)
  }
  if (!Array.isArray(raw.devices)) {
    throw new DeviceRegistryRecordError(
      `dsh credentials record ${DEVICES_RECORD_KEY} payload must carry a devices array`,
    )
  }
  const devices: DeviceRecord[] = []
  const seenIds = new Set<string>()
  const seenNoiseKeys = new Set<string>()
  for (const [index, entry] of raw.devices.entries()) {
    const device = deviceFromStoredEntry(entry, index)
    if (seenIds.has(device.deviceId)) {
      throw new DeviceRegistryRecordError(
        `dsh credentials record ${DEVICES_RECORD_KEY} carries a duplicate device entry (index ${index})`,
      )
    }
    const noiseHex = bytesToHex(device.noisePublicKey)
    if (seenNoiseKeys.has(noiseHex)) {
      throw new DeviceRegistryRecordError(
        `dsh credentials record ${DEVICES_RECORD_KEY} carries a duplicate noise public key (device entry ${index})`,
      )
    }
    seenIds.add(device.deviceId)
    seenNoiseKeys.add(noiseHex)
    devices.push(device)
  }
  return { devices, notifyPrefs: parseNotifyPrefs(raw.notifyPrefs) }
}

/** The serialized device record of the legacy file mode (tests only). */
interface SerializedDeviceRecord {
  deviceId: string
  name: string
  noisePublicKeyHex: string
  devicePskHex: string
  pushKeyHex: string
  approvalPublicKeyHex?: string | undefined
  createdAt: number
  lastSeenAt: number
  revoked: boolean
}

/** How this instance persists. `file` and `memory` exist for tests only. */
type RegistryBacking =
  | { kind: 'memory' }
  | { kind: 'file'; filePath: string }
  | { kind: 'credentials'; store: HostCredentialsStore; options: PersistentDeviceRegistryOptions }

/**
 * The paired-device registry. Production persists in the dsh credentials
 * record `remora/devices` through {@link loadPersistentDeviceRegistry}; the
 * constructor's file-path and memory modes are kept for the pairing-service
 * tests only (docs/tasks/P7-H4.md: "Remove the file-path mode or keep it for
 * tests only") and never run in dsh.
 *
 * The same instance is the per-device {@link NotifyPrefsStore}: preferences
 * live in the `remora/devices` record beside the device entries and share its
 * serialized write queue, so a revocation that drops a device's preferences
 * and a preference change cannot interleave.
 */
export class PersistentDeviceRegistry implements DeviceRegistry, NotifyPrefsStore {
  private readonly devicesById = new Map<string, DeviceRecord>()
  private readonly devicesByNoiseKeyHex = new Map<string, DeviceRecord>()
  private readonly prefsByDevice = new Map<string, NotifyPrefs>()
  private readonly backing: RegistryBacking
  private onRevokeListener: ((deviceId: string) => void) | null = null
  /** Serialized tail of the credentials writes: every write observes the previous one. */
  private writeQueue: Promise<void> = Promise.resolve()
  private latestWrite: Promise<void> = Promise.resolve()

  /** File mode (tests only): loads the JSON file when it exists. */
  constructor(storageFilePath?: string)
  /** Credentials mode (the loader's constructor): backs onto the dsh credentials record. */
  constructor(credentialsBacking: {
    credentials: HostCredentialsStore
    state: ParsedDevicesState
  } & PersistentDeviceRegistryOptions)
  constructor(
    arg?: string | ({ credentials: HostCredentialsStore; state: ParsedDevicesState } & PersistentDeviceRegistryOptions),
  ) {
    if (typeof arg === 'string') {
      this.backing = { kind: 'file', filePath: arg }
      this.loadFromFile(arg)
    } else if (arg !== undefined && typeof arg === 'object') {
      this.backing = {
        kind: 'credentials',
        store: arg.credentials,
        options: { onWriteError: arg.onWriteError },
      }
      for (const device of arg.state.devices) {
        this.indexDevice(device)
      }
      for (const [deviceId, prefs] of arg.state.notifyPrefs) {
        this.prefsByDevice.set(deviceId, { ...prefs })
      }
    } else {
      this.backing = { kind: 'memory' }
    }
  }

  setOnRevoke(listener: (deviceId: string) => void): void {
    this.onRevokeListener = listener
  }

  getDeviceByNoiseKey(noisePub: Uint8Array): DeviceRecord | null {
    if (noisePub.length !== 32) return null
    return this.devicesByNoiseKeyHex.get(bytesToHex(noisePub)) ?? null
  }

  getDeviceById(deviceId: string): DeviceRecord | null {
    return this.devicesById.get(deviceId) ?? null
  }

  addDevice(record: DeviceRecord): void {
    if (record.noisePublicKey.length !== 32) {
      throw new Error('Device noisePublicKey must be 32 bytes')
    }
    if (record.devicePsk.length !== 32) {
      throw new Error('Device devicePsk must be 32 bytes')
    }
    if (record.pushKey.length !== 32) {
      throw new Error('Device pushKey must be 32 bytes')
    }
    this.indexDevice(record)
    this.persist()
  }

  revokeDevice(deviceId: string): void {
    const existing = this.devicesById.get(deviceId)
    if (!existing) return
    existing.revoked = true
    // Zeroize the secrets and drop the device's preferences as part of the
    // same change: the snapshot this write persists carries no devicePsk or
    // pushKey for the revoked device (crypto-v1.md §10).
    existing.devicePsk.fill(0)
    existing.pushKey.fill(0)
    this.prefsByDevice.delete(deviceId)
    this.persist()
    this.onRevokeListener?.(deviceId)
  }

  renameDevice(deviceId: string, newName: string): void {
    const existing = this.devicesById.get(deviceId)
    if (!existing) return
    existing.name = newName
    this.persist()
  }

  listDevices(): DeviceRecord[] {
    return Array.from(this.devicesById.values())
  }

  getPrefs(deviceId: string): NotifyPrefs {
    return { ...(this.prefsByDevice.get(deviceId) ?? DEFAULT_NOTIFY_PREFS) }
  }

  setPrefs(deviceId: string, prefs: Partial<NotifyPrefs>): NotifyPrefs {
    const current = this.getPrefs(deviceId)
    const updated: NotifyPrefs = {
      approval: prefs.approval ?? current.approval,
      question: prefs.question ?? current.question,
      turnDone: prefs.turnDone ?? current.turnDone,
      turnError: prefs.turnError ?? current.turnError,
    }
    this.prefsByDevice.set(deviceId, updated)
    this.persist()
    return updated
  }

  /**
   * Resolves once every queued credentials write has settled. A revoke right
   * before disposal must not be lost, so the plugin flushes on unload; each
   * write is one small record write.
   */
  async flush(): Promise<void> {
    await this.latestWrite
  }

  private indexDevice(record: DeviceRecord): void {
    const previous = this.devicesById.get(record.deviceId)
    if (previous) this.devicesByNoiseKeyHex.delete(bytesToHex(previous.noisePublicKey))
    const hex = bytesToHex(record.noisePublicKey)
    this.devicesById.set(record.deviceId, record)
    this.devicesByNoiseKeyHex.set(hex, record)
  }

  /** Persists the current state through the backing (no-op in memory mode). */
  private persist(): void {
    const backing = this.backing
    if (backing.kind === 'file') {
      this.persistToFile(backing.filePath)
    } else if (backing.kind === 'credentials') {
      this.enqueueWrite(backing)
    }
  }

  /**
   * Queues one whole-record `modifyRecord` write. Writes run strictly in
   * mutation order and each observes the committed record before replacing
   * it; a failing write is reported through `onWriteError` instead of
   * breaking the queue or throwing from the synchronous mutation.
   */
  private enqueueWrite(backing: Extract<RegistryBacking, { kind: 'credentials' }>): void {
    const run = async (): Promise<void> => {
      await backing.store.modifyRecord(DEVICES_RECORD_KEY, async (current) => {
        if (current !== undefined) {
          // Only overwrite a record this module still understands: a foreign
          // or corrupt record fails the write instead of being clobbered.
          devicesStateFromRecord(current)
        }
        return { kind: 'grant', payload: devicesPayload(this.devicesById.values(), this.prefsByDevice) }
      })
    }
    const write = this.writeQueue.then(run)
    const settled = write.then(
      () => undefined,
      (error: unknown) => {
        backing.options.onWriteError?.(error)
      },
    )
    this.latestWrite = settled
    this.writeQueue = settled
  }

  /** File mode only (tests): the legacy JSON-array format, unchanged. */
  private loadFromFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return
    try {
      const data = fs.readFileSync(filePath, 'utf8')
      const records: SerializedDeviceRecord[] = JSON.parse(data)
      for (const rec of records) {
        const record: DeviceRecord = {
          deviceId: rec.deviceId,
          name: rec.name,
          noisePublicKey: hexToBytes(rec.noisePublicKeyHex),
          devicePsk: hexToBytes(rec.devicePskHex),
          pushKey: hexToBytes(rec.pushKeyHex),
          approvalPublicKey: rec.approvalPublicKeyHex ? hexToBytes(rec.approvalPublicKeyHex) : undefined,
          createdAt: rec.createdAt,
          lastSeenAt: rec.lastSeenAt,
          revoked: rec.revoked,
        }
        this.indexDevice(record)
      }
    } catch {
      // If file is corrupt or unreadable, preserve memory state
    }
  }

  /** File mode only (tests): writes the legacy JSON-array format. */
  private persistToFile(filePath: string): void {
    try {
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const serialized: SerializedDeviceRecord[] = Array.from(this.devicesById.values()).map((rec) => ({
        deviceId: rec.deviceId,
        name: rec.name,
        noisePublicKeyHex: bytesToHex(rec.noisePublicKey),
        devicePskHex: bytesToHex(rec.devicePsk),
        pushKeyHex: bytesToHex(rec.pushKey),
        approvalPublicKeyHex: rec.approvalPublicKey ? bytesToHex(rec.approvalPublicKey) : undefined,
        createdAt: rec.createdAt,
        lastSeenAt: rec.lastSeenAt,
        revoked: rec.revoked,
      }))
      fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2), 'utf8')
    } catch {
      // Non-fatal if write fails
    }
  }
}

/**
 * Loads the paired devices and their notify preferences from the dsh
 * credentials record `remora/devices`, creating the record atomically on
 * first start: when the record is absent, an empty one is written with an
 * atomic create-if-absent `modifyRecord` — if another start wins the write,
 * its record is adopted (the loadOrCreateHostIdentity pattern of P7-H2). A
 * stored record that cannot be parsed fails closed with
 * {@link DeviceRegistryRecordError} instead of being replaced.
 */
export async function loadPersistentDeviceRegistry(
  credentials: HostCredentialsStore,
  options: PersistentDeviceRegistryOptions = {},
): Promise<PersistentDeviceRegistry> {
  const stored = await credentials.readRecord(DEVICES_RECORD_KEY)
  if (stored === undefined) {
    const empty: HostCredentialRecord = { kind: 'grant', payload: { v: 1, devices: [], notifyPrefs: {} } }
    await credentials.modifyRecord(DEVICES_RECORD_KEY, async (current) => {
      if (current !== undefined) return undefined // lost the create race; adopt the winner below
      return empty
    })
  }

  const settled = await credentials.readRecord(DEVICES_RECORD_KEY)
  if (settled === undefined) {
    throw new DeviceRegistryRecordError(
      `dsh credentials record ${DEVICES_RECORD_KEY} is absent after the create-if-absent write`,
    )
  }
  const state = devicesStateFromRecord(settled)
  return new PersistentDeviceRegistry({ credentials, state, onWriteError: options.onWriteError })
}

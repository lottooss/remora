import { bytesToHex } from '@remora/crypto'

export interface DeviceRecord {
  /** Device endpoint id ('d_' + 26 base32 characters). */
  deviceId: string
  /** Human-readable device name (e.g. 'Pixel 8'). */
  name: string
  /** 32-byte static Noise X25519 public key. */
  noisePublicKey: Uint8Array
  /** 32-byte device PSK derived at pairing. */
  devicePsk: Uint8Array
  /** 32-byte push encryption key. */
  pushKey: Uint8Array
  /** Unix timestamp in ms when paired. */
  createdAt: number
  /** Unix timestamp in ms when last active. */
  lastSeenAt: number
  /** Whether the device has been revoked. */
  revoked: boolean
  /** Uncompressed EC P-256 approval public key. */
  approvalPublicKey?: Uint8Array | undefined
}

export interface DeviceRegistry {
  getDeviceByNoiseKey(noisePub: Uint8Array): DeviceRecord | null
  getDeviceById(deviceId: string): DeviceRecord | null
  addDevice(record: DeviceRecord): void
  revokeDevice(deviceId: string): void
  renameDevice?(deviceId: string, name: string): void
  listDevices(): DeviceRecord[]
  /** Wait for durable writes; rejects if the latest write failed. */
  flush?(): Promise<void>
}

export {
  DEVICES_RECORD_KEY,
  DeviceRegistryRecordError,
  PersistentDeviceRegistry,
  loadPersistentDeviceRegistry,
} from './persistent-registry.ts'
export type { PersistentDeviceRegistryOptions } from './persistent-registry.ts'

/**
 * In-memory device registry used for testing and baseline host operation.
 */
export class InMemoryDeviceRegistry implements DeviceRegistry {
  private readonly devicesById = new Map<string, DeviceRecord>()
  private readonly devicesByNoiseKeyHex = new Map<string, DeviceRecord>()

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
    const hex = bytesToHex(record.noisePublicKey)
    this.devicesById.set(record.deviceId, record)
    this.devicesByNoiseKeyHex.set(hex, record)
  }

  revokeDevice(deviceId: string): void {
    const existing = this.devicesById.get(deviceId)
    if (existing) {
      existing.revoked = true
    }
  }

  listDevices(): DeviceRecord[] {
    return Array.from(this.devicesById.values())
  }
}

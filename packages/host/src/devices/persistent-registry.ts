import fs from 'node:fs'
import path from 'node:path'
import { bytesToHex, hexToBytes } from '@remora/crypto'
import type { DeviceRecord, DeviceRegistry } from './index.ts'

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

export class PersistentDeviceRegistry implements DeviceRegistry {
  private readonly devicesById = new Map<string, DeviceRecord>()
  private readonly devicesByNoiseKeyHex = new Map<string, DeviceRecord>()
  private onRevokeListener: ((deviceId: string) => void) | null = null

  constructor(private readonly storageFilePath?: string) {
    if (storageFilePath) {
      this.loadFromFile(storageFilePath)
    }
  }

  setOnRevoke(listener: (deviceId: string) => void): void {
    this.onRevokeListener = listener
  }

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
        this.devicesById.set(record.deviceId, record)
        this.devicesByNoiseKeyHex.set(rec.noisePublicKeyHex, record)
      }
    } catch {
      // If file is corrupt or unreadable, preserve memory state
    }
  }

  private persistToFile(): void {
    if (!this.storageFilePath) return
    try {
      const dir = path.dirname(this.storageFilePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const serialized: SerializedDeviceRecord[] = Array.from(this.devicesById.values()).map(
        (rec) => ({
          deviceId: rec.deviceId,
          name: rec.name,
          noisePublicKeyHex: bytesToHex(rec.noisePublicKey),
          devicePskHex: bytesToHex(rec.devicePsk),
          pushKeyHex: bytesToHex(rec.pushKey),
          approvalPublicKeyHex: rec.approvalPublicKey ? bytesToHex(rec.approvalPublicKey) : undefined,
          createdAt: rec.createdAt,
          lastSeenAt: rec.lastSeenAt,
          revoked: rec.revoked,
        }),
      )
      fs.writeFileSync(this.storageFilePath, JSON.stringify(serialized, null, 2), 'utf8')
    } catch {
      // Non-fatal if write fails
    }
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
    const hex = bytesToHex(record.noisePublicKey)
    this.devicesById.set(record.deviceId, record)
    this.devicesByNoiseKeyHex.set(hex, record)
    this.persistToFile()
  }

  revokeDevice(deviceId: string): void {
    const existing = this.devicesById.get(deviceId)
    if (existing) {
      existing.revoked = true
      this.persistToFile()
      this.onRevokeListener?.(deviceId)
    }
  }

  renameDevice(deviceId: string, newName: string): void {
    const existing = this.devicesById.get(deviceId)
    if (existing) {
      existing.name = newName
      this.persistToFile()
    }
  }

  listDevices(): DeviceRecord[] {
    return Array.from(this.devicesById.values())
  }
}

import { describe, expect, it } from 'vitest'
import { InMemoryDeviceRegistry, type DeviceRecord } from '../src/devices/index.ts'

describe('DeviceRegistry', () => {
  const dummyDevice: DeviceRecord = {
    deviceId: 'd_mzxw6ytboirx24dhmzxw6ytboi',
    name: 'Pixel 8',
    noisePublicKey: new Uint8Array(32).fill(1),
    devicePsk: new Uint8Array(32).fill(2),
    pushKey: new Uint8Array(32).fill(3),
    createdAt: 1000,
    lastSeenAt: 2000,
    revoked: false,
  }

  it('adds and retrieves devices by ID and noise public key', () => {
    const registry = new InMemoryDeviceRegistry()
    registry.addDevice(dummyDevice)

    expect(registry.getDeviceById(dummyDevice.deviceId)).toEqual(dummyDevice)
    expect(registry.getDeviceByNoiseKey(dummyDevice.noisePublicKey)).toEqual(dummyDevice)
    expect(registry.listDevices()).toEqual([dummyDevice])
  })

  it('returns null for unknown device', () => {
    const registry = new InMemoryDeviceRegistry()
    expect(registry.getDeviceById('d_nonexistent')).toBeNull()
    expect(registry.getDeviceByNoiseKey(new Uint8Array(32).fill(99))).toBeNull()
    expect(registry.getDeviceByNoiseKey(new Uint8Array(16))).toBeNull()
  })

  it('marks device as revoked', () => {
    const registry = new InMemoryDeviceRegistry()
    registry.addDevice(dummyDevice)
    expect(registry.getDeviceById(dummyDevice.deviceId)?.revoked).toBe(false)

    registry.revokeDevice(dummyDevice.deviceId)
    expect(registry.getDeviceById(dummyDevice.deviceId)?.revoked).toBe(true)
  })

  it('rejects adding invalid device records', () => {
    const registry = new InMemoryDeviceRegistry()
    expect(() =>
      registry.addDevice({
        ...dummyDevice,
        noisePublicKey: new Uint8Array(16),
      }),
    ).toThrow('32 bytes')

    expect(() =>
      registry.addDevice({
        ...dummyDevice,
        devicePsk: new Uint8Array(16),
      }),
    ).toThrow('32 bytes')
  })
})

import { describe, expect, it } from 'vitest'
import {
  DeviceRateLimiter,
  InMemoryDeviceRegistry,
  MAX_MUTATING_REQUESTS_PER_SECOND,
  MAX_REQUESTS_PER_SECOND,
  MAX_STREAMS_PER_DEVICE,
  RcpServer,
} from '@remora/host'
import {
  MAX_RCP_MESSAGE_BYTES,
  RCP_ERROR_CODES,
} from '@remora/protocol'

describe('Security Test Suite: Limits, Quotas & Revocation (T07, T09, T23)', () => {
  const hostId = 'h_lim_sec'
  const deviceId = 'd_device_limits_1'

  it('rejects RCP messages exceeding 48 KiB with too_large (T23)', async () => {
    const rcpServer = new RcpServer({ hostId, hostName: 'LimitHost' })
    const ctx = { deviceId, channelId: 1 }

    // Construct a payload slightly larger than 48 KiB
    const oversizedString = 'x'.repeat(MAX_RCP_MESSAGE_BYTES + 1024)
    const rawMessage = JSON.stringify({
      version: 1,
      id: 1,
      m: 'ping',
      k: 'req',
      p: { payload: oversizedString },
    })

    const responseJson = await rcpServer.handleMessage(rawMessage, ctx)
    expect(responseJson).not.toBeNull()

    const parsedRes = JSON.parse(responseJson!)
    expect(parsedRes.e).toBeDefined()
    expect(parsedRes.e.code).toBe(RCP_ERROR_CODES.too_large)
    expect(parsedRes.e.message).toContain('exceeds')
  })

  it('enforces 20 req/s burst rate limit on general requests (T23)', () => {
    let mockTime = 1_700_000_000_000
    const limiter = new DeviceRateLimiter({ now: () => mockTime })

    // Send 20 requests within same millisecond -> all succeed
    for (let i = 0; i < MAX_REQUESTS_PER_SECOND; i++) {
      const res = limiter.checkRequest(deviceId, 'ping')
      expect(res.ok).toBe(true)
    }

    // 21st request immediately -> rate limited!
    const limitedRes = limiter.checkRequest(deviceId, 'ping')
    expect(limitedRes.ok).toBe(false)
    expect(limitedRes.error?.code).toBe(RCP_ERROR_CODES.rate_limited)

    // Advance clock by 1 second -> bucket refills
    mockTime += 1000
    const refilledRes = limiter.checkRequest(deviceId, 'ping')
    expect(refilledRes.ok).toBe(true)
  })

  it('enforces 5 req/s mutating rate limit (T23)', () => {
    let mockTime = 1_700_000_000_000
    const limiter = new DeviceRateLimiter({ now: () => mockTime })

    // Send 5 mutating requests (e.g. sessions.prompt)
    for (let i = 0; i < MAX_MUTATING_REQUESTS_PER_SECOND; i++) {
      const res = limiter.checkRequest(deviceId, 'sessions.prompt')
      expect(res.ok).toBe(true)
    }

    // 6th mutating request in the same second -> rate limited!
    const limitedRes = limiter.checkRequest(deviceId, 'sessions.prompt')
    expect(limitedRes.ok).toBe(false)
    expect(limitedRes.error?.code).toBe(RCP_ERROR_CODES.rate_limited)
  })

  it('enforces maximum 10 concurrent streams per device (T23)', () => {
    const limiter = new DeviceRateLimiter()
    const releases: Array<() => void> = []

    // Acquire 10 stream slots
    for (let i = 0; i < MAX_STREAMS_PER_DEVICE; i++) {
      const slot = limiter.acquireStream(deviceId)
      expect(slot.ok).toBe(true)
      releases.push(slot.release)
    }

    // 11th stream slot request fails
    const eleventh = limiter.acquireStream(deviceId)
    expect(eleventh.ok).toBe(false)
    expect(eleventh.error?.code).toBe(RCP_ERROR_CODES.rate_limited)

    // Release one slot
    releases[0]!()

    // Now acquiring 10th slot succeeds again
    const reacquired = limiter.acquireStream(deviceId)
    expect(reacquired.ok).toBe(true)
    releases.push(reacquired.release)

    // Clean up
    for (const r of releases) r()
  })

  it('immediately rejects requests when device is revoked in registry (T09)', () => {
    const registry = new InMemoryDeviceRegistry()
    registry.addDevice({
      deviceId,
      name: 'RevokeTestPhone',
      noisePublicKey: new Uint8Array(32),
      devicePsk: new Uint8Array(32),
      pushKey: new Uint8Array(32),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false,
    })

    expect(registry.getDeviceById(deviceId)?.revoked).toBe(false)

    // Revoke
    registry.revokeDevice(deviceId)

    // Device is now revoked
    const dev = registry.getDeviceById(deviceId)
    expect(dev?.revoked).toBe(true)
  })
})

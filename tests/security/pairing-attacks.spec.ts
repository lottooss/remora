import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest'
import {
  ChannelManager,
  HostRelayConnection,
  InMemoryDeviceRegistry,
  PairingService,
  RcpServer,
  createHostIdentity,
  enrollHost,
} from '@remora/host'
import { decodeBase64Url, encodeBase64Url, generateKeypair } from '@remora/crypto'
import { E2eEnvironment, FakeDevice } from '@remora/testkit'

describe('Security Test Suite: Pairing Attacks & Mitigations (T03, T06, ADV11)', () => {
  let env: E2eEnvironment
  let hostRelay: HostRelayConnection | null = null
  let device: FakeDevice | null = null

  beforeAll(async () => {
    env = new E2eEnvironment({ useRealDsh: false })
    await env.start()
  }, 45_000)

  afterAll(async () => {
    if (env) {
      await env.teardown()
    }
  })

  afterEach(async () => {
    if (device) {
      await device.disconnect()
      device = null
    }
    if (hostRelay) {
      await hostRelay.stop()
      hostRelay = null
    }
  })

  async function setupHost(env: E2eEnvironment, hostSuffix: string) {
    const hostIdentity = createHostIdentity()
    const hostName = `Sec-Pair-Host-${hostSuffix}`
    await enrollHost(env.relayHttpUrl, env.enrollSecret, hostIdentity, hostName)

    const registry = new InMemoryDeviceRegistry()
    const rcpServer = new RcpServer({
      hostId: hostIdentity.hostId,
      hostName,
    })

    hostRelay = new HostRelayConnection({
      relayUrl: env.relayWsUrl,
      identity: hostIdentity,
    })

    const pairingService = new PairingService({
      identity: hostIdentity,
      hostName,
      relayOrigin: env.relayHttpUrl,
      registry,
      sendFrame: (bytes) => hostRelay!.sendFrameBytes(bytes),
      requestEnrollmentTicket: async () => {
        const res = await hostRelay!.link.request<{ ticket: string }>({ t: 'enroll.ticket' })
        return decodeBase64Url(res.ticket)
      },
    })

    const channelManager = new ChannelManager({
      identity: hostIdentity,
      registry,
      rcpServer,
      pairingService,
      sendFrame: (bytes) => hostRelay!.sendFrameBytes(bytes),
    })

    hostRelay.attachChannelManager(channelManager)
    hostRelay.start()

    await new Promise<void>((resolve) => {
      if (hostRelay!.isConnected) return resolve()
      hostRelay!.link.once('ready', () => resolve())
    })

    return {
      hostIdentity,
      registry,
      rcpServer,
      pairingService,
      channelManager,
    }
  }

  it('rejects pairing when PC user rejects or does not confirm SAS (T06)', async () => {
    const { pairingService, registry } = await setupHost(env, 'reject')

    const attempt = await pairingService.beginPairing()
    device = new FakeDevice({ name: 'UnconfirmedPhone' })

    const pairFlow = await device.startPairing(attempt.qrPayload, env.relayHttpUrl)
    expect(pairFlow.sasCode.length).toBe(6)

    // PC operator rejects
    await pairingService.rejectPairing('rejected')

    const pairResult = await pairFlow.waitForResult()
    expect(pairResult.ok).toBe(false)
    if (!pairResult.ok) {
      expect(pairResult.reason).toBe('rejected')
    }

    // Registry must NOT contain the unconfirmed device
    expect(registry.getDeviceById(device.deviceId)).toBeNull()
  })

  it('rejects wrong SAS confirmation code on PC (T06)', async () => {
    const { pairingService, registry } = await setupHost(env, 'wrongsas')

    const attempt = await pairingService.beginPairing()
    device = new FakeDevice({ name: 'WrongSasPhone' })

    const pairFlow = await device.startPairing(attempt.qrPayload, env.relayHttpUrl)
    expect(pairFlow.sasCode.length).toBe(6)

    // Attacker or operator inputs incorrect SAS code
    const wrongSas = pairFlow.sasCode === '123456' ? '654321' : '123456'
    const confirmed = await pairingService.confirmPairing(wrongSas)
    expect(confirmed).toBe(false)

    // Device should not be confirmed
    expect(registry.getDeviceById(device.deviceId)).toBeNull()
  })

  it('rejects pairing ticket reuse (T06)', async () => {
    const { pairingService } = await setupHost(env, 'reuse')

    const attempt = await pairingService.beginPairing()
    device = new FakeDevice({ name: 'Device1' })

    // First device pairs successfully
    const pairFlow1 = await device.startPairing(attempt.qrPayload, env.relayHttpUrl)
    await pairingService.confirmPairing(pairFlow1.sasCode)
    const res1 = await pairFlow1.waitForResult()
    expect(res1.ok).toBe(true)

    // Second device (or attacker who captured QR) tries to use same ticket
    const attackerDevice = new FakeDevice({ name: 'AttackerCloner' })
    try {
      await expect(
        attackerDevice.startPairing(attempt.qrPayload, env.relayHttpUrl),
      ).rejects.toThrow()
    } finally {
      await attackerDevice.disconnect()
    }
  })

  it('rejects substituted host key in QR payload (T03)', async () => {
    const { pairingService } = await setupHost(env, 'subhost')

    const attempt = await pairingService.beginPairing()

    // Attacker modifies the QR payload to replace host static key with attacker's key
    const parts = attempt.qrPayload.split(':')
    const forgedHostNoise = generateKeypair()
    parts[3] = encodeBase64Url(forgedHostNoise.publicKey)
    const tamperedQrPayload = parts.join(':')

    device = new FakeDevice({ name: 'VictimPhone' })

    // When phone starts pairing with tampered QR, handshake cannot decrypt msg1 on genuine host
    await expect(
      device.startPairing(tamperedQrPayload, env.relayHttpUrl),
    ).rejects.toThrow()
  })
})

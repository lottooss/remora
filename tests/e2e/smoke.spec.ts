import { describe, expect, it, afterEach } from 'vitest'
import {
  ChannelManager,
  HostRelayConnection,
  InMemoryDeviceRegistry,
  RcpServer,
  createHostIdentity,
  enrollHost,
} from '@remora/host'
import { E2eEnvironment, FakeDevice } from '@remora/testkit'

describe('End-to-End Smoke Tests (P1-T1)', () => {
  let env: E2eEnvironment | null = null
  let hostRelay: HostRelayConnection | null = null
  let device: FakeDevice | null = null

  afterEach(async () => {
    if (device) {
      await device.disconnect()
      device = null
    }
    if (hostRelay) {
      await hostRelay.stop()
      hostRelay = null
    }
    if (env) {
      await env.teardown()
      env = null
    }
  })

  it('runs complete end-to-end smoke: relay enrollment -> WebSocket auth -> Noise IKpsk2 channel -> RCP hello/ping/status', async () => {
    env = new E2eEnvironment({ useRealDsh: false })
    await env.start()

    // 1. Setup Host Identity and enroll at relay
    const hostIdentity = createHostIdentity()
    await enrollHost(env.relayHttpUrl, env.enrollSecret, hostIdentity, 'E2E-Host')

    // 2. Setup Host RcpServer, Registry, and ChannelManager
    const registry = new InMemoryDeviceRegistry()
    const rcpServer = new RcpServer({
      hostId: hostIdentity.hostId,
      hostName: 'E2E-Host',
      statusProvider: {
        isRelayConnected: () => hostRelay?.isConnected ?? false,
        getPairedDevicesCount: () => registry.listDevices().filter((d) => !d.revoked).length,
      },
    })

    hostRelay = new HostRelayConnection({
      relayUrl: env.relayWsUrl,
      identity: hostIdentity,
    })

    const channelManager = new ChannelManager({
      identity: hostIdentity,
      registry,
      rcpServer,
      sendFrame: (bytes) => {
        hostRelay!.sendFrameBytes(bytes)
      },
    })

    hostRelay.attachChannelManager(channelManager)
    hostRelay.start()

    // Wait until host connects and authenticates with relay
    const hostConnected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000)
      if (hostRelay!.isConnected) {
        clearTimeout(timer)
        resolve(true)
        return
      }
      hostRelay!.link.once('ready', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    expect(hostConnected).toBe(true)

    // 3. Request enrollment ticket from relay
    const ticketRes = await hostRelay.link.request<{ ticket: string; expiresAt: number }>({
      t: 'enroll.ticket',
    })
    expect(ticketRes.ticket).toBeDefined()

    // 4. Enroll fake phone/device at relay using ticket
    device = new FakeDevice({ name: 'Pixel 8 E2E' })
    const devEnrollRes = await device.enrollAtRelay(env.relayHttpUrl, ticketRes.ticket)
    expect(devEnrollRes.id).toBe(device.deviceId)
    expect(devEnrollRes.hostId).toBe(hostIdentity.hostId)

    // Pre-register device in host's device registry (as established during pairing)
    registry.addDevice({
      deviceId: device.deviceId,
      devicePsk: device.devicePsk,
      noisePublicKey: device.noiseKeypair.publicKey,
      createdAt: Date.now(),
      name: device.name,
      revoked: false,
    })

    // 5. Connect device to relay
    await device.connectToRelay(env.relayWsUrl)
    expect(device.isConnected).toBe(true)

    // 6. Open Noise IKpsk2 secure channel from device to host through relay
    const channel = await device.openSecureChannel({
      hostId: hostIdentity.hostId,
      hostNoisePublicKey: hostIdentity.noiseKeypair.publicKey,
      channelId: 1,
    })
    expect(channel.channelId).toBe(1)
    expect(channel.handshakeHash.length).toBe(32)

    // 7. Send RCP hello RPC
    const helloRes = await channel.hello('Remora-Android', '0.1.0')
    expect(helloRes.rcp).toEqual([1])
    expect(helloRes.host.id).toBe(hostIdentity.hostId)
    expect(helloRes.host.name).toBe('E2E-Host')
    expect(helloRes.features).toContain('sessions')

    // 8. Send RCP ping RPC
    const pingRes = await channel.ping(4242)
    expect(pingRes.t).toBe(4242)
    expect(typeof pingRes.hostTime).toBe('number')

    // 9. Send RCP host.status RPC
    const statusRes = await channel.hostStatus()
    expect(statusRes.relayConnected).toBe(true)
    expect(statusRes.pairedDevicesCount).toBe(1)
    expect(statusRes.uptimeMs).toBeGreaterThanOrEqual(0)
  })

  describe('Later Phase E2E Placeholders', () => {
    it.skip('P2: pairing QR flow, session list, prompt dispatch, and live follow streaming', () => {})
    it.skip('P3: approval and question answering with biometric signature verification', () => {})
    it.skip('P4: workspace creation and directory browse in allowlisted roots', () => {})
    it.skip('P5: FCM push notifications and host offline alarm dispatch', () => {})
  })
})

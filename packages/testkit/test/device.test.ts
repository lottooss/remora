import { describe, expect, it } from 'vitest'
import {
  createHostIdentity,
  InMemoryDeviceRegistry,
  RcpServer,
  ChannelManager,
} from '@remora/host'
import { decodeBase32 } from '@remora/crypto'
import { decodeDataFrame, PeerKind } from '@remora/protocol'
import { FakeDevice } from '../src/device.ts'

describe('FakeDevice', () => {
  it('generates deterministic endpoint IDs from relay keys', () => {
    const dev = new FakeDevice()
    expect(dev.deviceId.startsWith('d_')).toBe(true)
    expect(dev.deviceId.length).toBe(28)
  })

  it('performs complete Noise IKpsk2 handshake and RCP hello with host ChannelManager', async () => {
    const hostIdentity = createHostIdentity()
    const registry = new InMemoryDeviceRegistry()
    const device = new FakeDevice()

    // Pre-register device in host registry (P1-H1 / P1-T1 acceptance)
    registry.addDevice({
      deviceId: device.deviceId,
      devicePsk: device.devicePsk,
      noisePublicKey: device.noiseKeypair.publicKey,
      pushKey: new Uint8Array(32),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      name: 'Test Device',
      revoked: false,
    })

    const rcpServer = new RcpServer({
      hostId: hostIdentity.hostId,
      hostName: 'TestHost',
      runtimeProvider: {
        hello: () => ({
          os: 'linux', pathSeparator: '/', versions: { remora: '1.0.0-test', dsh: '0.0.0-test' },
          features: [], roots: [], policy: { approvalBiometric: 'high', allowRemoteSessionStart: false },
        }),
        status: () => ({ agentsRunning: 0, keepAwake: false, dsh: { version: '0.0.0-test', profile: 'remora-test' } }),
      },
    })

    let hostSendCallback: ((frame: Uint8Array) => void) | null = null

    const channelManager = new ChannelManager({
      identity: hostIdentity,
      registry,
      rcpServer,
      sendFrame: (bytes) => {
        if (hostSendCallback) hostSendCallback(bytes)
      },
    })

    const deviceRawId = decodeBase32(device.deviceId.slice(2))

    // Mock relay transport linking device and host
    const deviceRelayLinkMock: any = {
      state: 'ready',
      stop: async () => {},
      sendData: (_dest: any, channel: number, payload: Uint8Array) => {
        const frame = {
          channel,
          peerKind: PeerKind.DEVICE,
          peerId: deviceRawId,
          payload,
        }
        void channelManager.handleDataFrame(frame as any)
      },
    }

    ;(device as any).link = deviceRelayLinkMock

    hostSendCallback = (bytes) => {
      const frame = decodeDataFrame(bytes)
      ;(device as any).handleIncomingDataFrame(frame)
    }

    const channel = await device.openSecureChannel({
      hostId: hostIdentity.hostId,
      hostNoisePublicKey: hostIdentity.noiseKeypair.publicKey,
      channelId: 1,
    })

    expect(channel.channelId).toBe(1)
    expect(channel.handshakeHash.length).toBe(32)

    // Call hello
    const helloRes = await channel.hello('Remora-Testkit', '1.0.0')
    expect(helloRes.rcp).toBe(1)
    expect(helloRes.host.id).toBe(hostIdentity.hostId)
    expect(helloRes.host.name).toBe('TestHost')

    // Call ping
    const pingRes = await channel.ping(12345)
    expect(pingRes.t).toBe(12345)
    expect(typeof pingRes.hostTime).toBe('number')

    // Call host.status
    const statusRes = await channel.hostStatus()
    expect(statusRes.agentsRunning).toBe(0)
    expect(statusRes.dsh.profile).toBe('remora-test')

    // Cleanup
    channel.close()
    await device.disconnect()
    channelManager.closeAll()
  })
})

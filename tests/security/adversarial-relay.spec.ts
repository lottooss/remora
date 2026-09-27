import { describe, expect, it, afterEach } from 'vitest'
import {
  ChannelManager,
  HostRelayConnection,
  InMemoryDeviceRegistry,
  RcpServer,
  RECORD_TYPE,
  createHostIdentity,
  enrollHost,
} from '@remora/host'
import {
  concatBytes,
  createInitiatorHandshake,
  encodeBase32,
  generateKeypair,
  randomBytes,
  utf8ToBytes,
} from '@remora/crypto'
import { PeerKind, encodeDataFrame, decodeDataFrame } from '@remora/protocol'
import { AdversaryRelayProxy, E2eEnvironment, FakeDevice } from '@remora/testkit'

describe('Security Test Suite: Adversarial Relay & Crypto Invariants (T01, T02, T03, T04, T05)', () => {
  let env: E2eEnvironment | null = null
  let proxy: AdversaryRelayProxy | null = null
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
    if (proxy) {
      await proxy.close()
      proxy = null
    }
    if (env) {
      await env.teardown()
      env = null
    }
  })

  function createTestChannelPair() {
    const hostIdentity = createHostIdentity()
    const registry = new InMemoryDeviceRegistry()
    const rcpServer = new RcpServer({ hostId: hostIdentity.hostId, hostName: 'SecHost' })

    const deviceNoise = generateKeypair()
    const devicePsk = randomBytes(32)
    const peerRawId = randomBytes(16)
    const deviceId = `d_${encodeBase32(peerRawId)}`

    registry.addDevice({
      deviceId,
      name: 'Phone',
      noisePublicKey: deviceNoise.publicKey,
      devicePsk,
      pushKey: new Uint8Array(32),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false,
    })

    const sentHostFrames: Uint8Array[] = []
    const manager = new ChannelManager({
      identity: hostIdentity,
      registry,
      rcpServer,
      sendFrame: (bytes) => {
        sentHostFrames.push(bytes)
      },
    })

    return {
      hostIdentity,
      registry,
      rcpServer,
      deviceNoise,
      devicePsk,
      deviceId,
      peerRawId,
      manager,
      sentHostFrames,
    }
  }

  async function establishSession(t: ReturnType<typeof createTestChannelPair>, channelId = 1) {
    const prologue = utf8ToBytes(
      `remora/1\x00session\x00${t.hostIdentity.hostId}\x00${t.deviceId}`,
    )
    const initiator = createInitiatorHandshake({
      staticKey: t.deviceNoise.privateKey,
      remoteStaticKey: t.hostIdentity.noiseKeypair.publicKey,
      psk: t.devicePsk,
      prologue,
    })

    const msg1 = initiator.writeMessage(new Uint8Array(0))

    // Deliver msg1 to host
    await t.manager.handleDataFrame({
      channel: channelId,
      peerKind: PeerKind.DEVICE,
      peerId: t.peerRawId,
      payload: concatBytes(Uint8Array.of(RECORD_TYPE.HANDSHAKE_MSG1), msg1),
    })

    expect(t.sentHostFrames.length).toBe(1)
    const hostFrame = decodeDataFrame(t.sentHostFrames[0]!)
    expect(hostFrame.payload[0]).toBe(RECORD_TYPE.HANDSHAKE_MSG2)
    const msg2 = hostFrame.payload.subarray(1)

    // Read msg2 on device
    initiator.readMessage(msg2)
    expect(initiator.isComplete).toBe(true)

    expect(t.manager.hasSession(t.deviceId, channelId)).toBe(true)

    return {
      initiatorCipher: initiator.result,
      peerRawId: t.peerRawId,
    }
  }

  it('closes channel immediately upon bit flip in transport ciphertext (T01, T02)', async () => {
    const t = createTestChannelPair()
    const { initiatorCipher, peerRawId } = await establishSession(t, 1)

    // Device encrypts a valid RCP ping
    const rcpPing = JSON.stringify({ k: 'req', id: 1, m: 'ping', p: { t: Date.now() } })
    const ciphertext = initiatorCipher.sendCipher.encryptWithAd(new Uint8Array(0), utf8ToBytes(rcpPing))

    // Adversary flips a bit in the encrypted payload
    const corruptedCiphertext = new Uint8Array(ciphertext)
    corruptedCiphertext[5] = corruptedCiphertext[5]! ^ 0x01

    // Send corrupted frame to host
    await t.manager.handleDataFrame({
      channel: 1,
      peerKind: PeerKind.DEVICE,
      peerId: peerRawId,
      payload: concatBytes(Uint8Array.of(RECORD_TYPE.TRANSPORT), corruptedCiphertext),
    })

    // Host must fail closed: session closed, no response sent, no plaintext processed
    expect(t.manager.hasSession(t.deviceId, 1)).toBe(false)
    expect(t.sentHostFrames.length).toBe(1) // only msg2 from handshake was sent
  })

  it('rejects frame replay and closes channel (T05)', async () => {
    const t = createTestChannelPair()
    const { initiatorCipher, peerRawId } = await establishSession(t, 2)

    const rcpPing = JSON.stringify({ k: 'req', id: 2, m: 'ping', p: { t: Date.now() } })
    const ciphertext = initiatorCipher.sendCipher.encryptWithAd(new Uint8Array(0), utf8ToBytes(rcpPing))

    const transportPayload = concatBytes(Uint8Array.of(RECORD_TYPE.TRANSPORT), ciphertext)

    // First arrival -> succeeds and host responds
    await t.manager.handleDataFrame({
      channel: 2,
      peerKind: PeerKind.DEVICE,
      peerId: peerRawId,
      payload: transportPayload,
    })
    expect(t.sentHostFrames.length).toBe(2) // msg2 + response

    // Adversary replays identical frame with duplicate nonce counter
    await t.manager.handleDataFrame({
      channel: 2,
      peerKind: PeerKind.DEVICE,
      peerId: peerRawId,
      payload: transportPayload,
    })

    // Decryption with duplicated counter fails -> session closed
    expect(t.manager.hasSession(t.deviceId, 2)).toBe(false)
  })

  it('rejects frame splicing (tampered ciphertext bytes) (T02)', async () => {
    const t = createTestChannelPair()
    const { initiatorCipher, peerRawId } = await establishSession(t, 3)

    const rcpPing = JSON.stringify({ k: 'req', id: 3, m: 'ping', p: { t: Date.now() } })
    const ciphertext = initiatorCipher.sendCipher.encryptWithAd(new Uint8Array(0), utf8ToBytes(rcpPing))

    // Splice 8 bytes of garbage into ciphertext
    const spliced = new Uint8Array(ciphertext.length + 8)
    spliced.set(ciphertext.subarray(0, 10), 0)
    spliced.set(randomBytes(8), 10)
    spliced.set(ciphertext.subarray(10), 18)

    await t.manager.handleDataFrame({
      channel: 3,
      peerKind: PeerKind.DEVICE,
      peerId: peerRawId,
      payload: concatBytes(Uint8Array.of(RECORD_TYPE.TRANSPORT), spliced),
    })

    // Session must be closed
    expect(t.manager.hasSession(t.deviceId, 3)).toBe(false)
  })

  it('silently denies handshake from unknown/unallowlisted device static key (T04)', async () => {
    const t = createTestChannelPair()
    const unknownDeviceNoise = generateKeypair()
    const unknownPeerRawId = randomBytes(16)
    const unknownDeviceId = `d_${encodeBase32(unknownPeerRawId)}`
    const prologue = utf8ToBytes(
      `remora/1\x00session\x00${t.hostIdentity.hostId}\x00${unknownDeviceId}`,
    )

    const initiator = createInitiatorHandshake({
      staticKey: unknownDeviceNoise.privateKey,
      remoteStaticKey: t.hostIdentity.noiseKeypair.publicKey,
      psk: t.devicePsk,
      prologue,
    })

    const msg1 = initiator.writeMessage(new Uint8Array(0))

    await t.manager.handleDataFrame({
      channel: 4,
      peerKind: PeerKind.DEVICE,
      peerId: unknownPeerRawId,
      payload: concatBytes(Uint8Array.of(RECORD_TYPE.HANDSHAKE_MSG1), msg1),
    })

    // Host must NOT respond to unknown static key and must NOT create a session
    expect(t.sentHostFrames.length).toBe(0)
    expect(t.manager.getActiveSessionsCount()).toBe(0)
  })

  it('fails closed when initiator uses wrong PSK (T04)', async () => {
    const t = createTestChannelPair()
    const wrongPsk = randomBytes(32)
    const prologue = utf8ToBytes(
      `remora/1\x00session\x00${t.hostIdentity.hostId}\x00${t.deviceId}`,
    )

    const initiator = createInitiatorHandshake({
      staticKey: t.deviceNoise.privateKey,
      remoteStaticKey: t.hostIdentity.noiseKeypair.publicKey,
      psk: wrongPsk, // Wrong PSK!
      prologue,
    })

    const msg1 = initiator.writeMessage(new Uint8Array(0))

    await t.manager.handleDataFrame({
      channel: 5,
      peerKind: PeerKind.DEVICE,
      peerId: t.peerRawId,
      payload: concatBytes(Uint8Array.of(RECORD_TYPE.HANDSHAKE_MSG1), msg1),
    })

    // Host responds with msg2 encrypted under the registered device PSK
    expect(t.sentHostFrames.length).toBe(1)
    const hostFrame = decodeDataFrame(t.sentHostFrames[0]!)
    const msg2 = hostFrame.payload.subarray(1)

    // Initiator with wrong PSK cannot read msg2 (PSK tag verification fails)
    expect(() => initiator.readMessage(msg2)).toThrow()

    // Host session will fail closed on any mismatched transport ciphertext
    const fakeCiphertext = randomBytes(48)
    await t.manager.handleDataFrame({
      channel: 5,
      peerKind: PeerKind.DEVICE,
      peerId: t.peerRawId,
      payload: concatBytes(Uint8Array.of(RECORD_TYPE.TRANSPORT), fakeCiphertext),
    })
    expect(t.manager.hasSession(t.deviceId, 5)).toBe(false)
  })

  it('fails closed when responder key is substituted (T03)', async () => {
    const t = createTestChannelPair()
    const fakeHostNoise = generateKeypair()
    const prologue = utf8ToBytes(
      `remora/1\x00session\x00${t.hostIdentity.hostId}\x00${t.deviceId}`,
    )

    // Phone attempts handshake with wrong host key
    const initiator = createInitiatorHandshake({
      staticKey: t.deviceNoise.privateKey,
      remoteStaticKey: fakeHostNoise.publicKey, // Substituted key!
      psk: t.devicePsk,
      prologue,
    })

    const msg1 = initiator.writeMessage(new Uint8Array(0))

    await t.manager.handleDataFrame({
      channel: 6,
      peerKind: PeerKind.DEVICE,
      peerId: t.peerRawId,
      payload: concatBytes(Uint8Array.of(RECORD_TYPE.HANDSHAKE_MSG1), msg1),
    })

    // Host cannot decrypt msg1 encrypted for fake host key -> fails closed
    expect(t.sentHostFrames.length).toBe(0)
  })

  it('runs E2E adversarial proxy test: bit-flipped frame causes channel teardown (T01, T02)', async () => {
    env = new E2eEnvironment({ useRealDsh: false })
    await env.start()

    // Start AdversaryRelayProxy intercepting traffic to the real relay
    proxy = new AdversaryRelayProxy({ targetRelayUrl: env.relayWsUrl })
    await proxy.start()

    const hostIdentity = createHostIdentity()
    await enrollHost(env.relayHttpUrl, env.enrollSecret, hostIdentity, 'Sec-Host-Adv')

    const registry = new InMemoryDeviceRegistry()
    const rcpServer = new RcpServer({ hostId: hostIdentity.hostId, hostName: 'Sec-Host-Adv' })

    hostRelay = new HostRelayConnection({
      relayUrl: env.relayWsUrl,
      identity: hostIdentity,
    })

    const channelManager = new ChannelManager({
      identity: hostIdentity,
      registry,
      rcpServer,
      sendFrame: (bytes) => hostRelay!.sendFrameBytes(bytes),
    })

    hostRelay.attachChannelManager(channelManager)
    hostRelay.start()

    await new Promise<void>((resolve) => {
      if (hostRelay!.isConnected) return resolve()
      hostRelay!.link.once('ready', () => resolve())
    })

    // Device connects through AdversaryRelayProxy
    const deviceNoise = generateKeypair()
    const devicePsk = randomBytes(32)

    device = new FakeDevice({
      noiseKeypair: deviceNoise,
      devicePsk,
      name: 'AdversaryPhone',
    })

    // Enroll device at relay
    const ticketRes = await hostRelay!.link.request<{ ticket: string }>({ t: 'enroll.ticket' })
    await device.enrollAtRelay(env.relayHttpUrl, ticketRes.ticket)

    // Pair device directly into registry
    registry.addDevice({
      deviceId: device.deviceId,
      name: 'AdversaryPhone',
      noisePublicKey: deviceNoise.publicKey,
      devicePsk,
      pushKey: new Uint8Array(32),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false,
    })

    // Connect device via proxy
    await device.connectToRelay(proxy.proxyUrl)

    // Open channel 1 successfully
    const channel = await device.openSecureChannel({
      hostId: hostIdentity.hostId,
      hostNoisePublicKey: hostIdentity.noiseKeypair.publicKey,
      channelId: 1,
    })

    expect(channelManager.hasSession(device.deviceId, 1)).toBe(true)

    // Configure adversary proxy to flip 1 bit in the next upstream binary frame (device -> host)
    proxy.flipBitNext((f) => f.direction === 'upstream' && f.isBinary, 32, 0x01)

    // Perform an RPC call whose request will be corrupted in-flight by the proxy
    await expect(channel.call('ping', {}, 1000)).rejects.toThrow()

    // Host session must be terminated upon receiving corrupted ciphertext
    expect(channelManager.hasSession(device.deviceId, 1)).toBe(false)
  })
})

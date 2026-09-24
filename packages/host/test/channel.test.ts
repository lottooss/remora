import {
  concatBytes,
  createInitiatorHandshake,
  encodeBase32,
  generateKeypair,
  utf8ToBytes,
  type HandshakeState,
  type Keypair,
} from '@remora/crypto'
import {
  DATA_FRAME_TYPE,
  PeerKind,
  RLY_VERSION,
  decodeDataFrame,
  type DataFrame,
} from '@remora/protocol'
import { describe, expect, it } from 'vitest'
import { ChannelManager, RECORD_TYPE } from '../src/channel/index.ts'
import { InMemoryDeviceRegistry, type DeviceRecord } from '../src/devices/index.ts'
import { createHostIdentity, type HostIdentity } from '../src/identity/index.ts'
import { RcpServer } from '../src/rcp/index.ts'

describe('ChannelManager', () => {
  function setupTest() {
    const identity: HostIdentity = createHostIdentity()
    const registry = new InMemoryDeviceRegistry()
    const rcpServer = new RcpServer({
      hostId: identity.hostId,
      hostName: 'TestHost',
    })

    const sentFrames: Uint8Array[] = []
    const sendFrame = (frame: Uint8Array) => {
      sentFrames.push(frame)
    }

    const channelManager = new ChannelManager({
      identity,
      registry,
      rcpServer,
      sendFrame,
    })

    const deviceNoiseKey: Keypair = generateKeypair()
    const devicePsk = new Uint8Array(32).fill(0x55)
    const deviceRawId = new Uint8Array(16).fill(0x22)
    const deviceId = `d_${encodeBase32(deviceRawId)}`

    const deviceRecord: DeviceRecord = {
      deviceId,
      name: 'Test Device',
      noisePublicKey: deviceNoiseKey.publicKey,
      devicePsk,
      pushKey: new Uint8Array(32).fill(0x33),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false,
    }

    registry.addDevice(deviceRecord)

    return {
      identity,
      registry,
      rcpServer,
      channelManager,
      deviceNoiseKey,
      devicePsk,
      deviceRawId,
      deviceId,
      deviceRecord,
      sentFrames,
    }
  }

  type Ctx = ReturnType<typeof setupTest>

  /**
   * One inbound RLY/1 data frame as the relay delivers it: the header carries
   * the *source* endpoint, so a frame from a device has kind `device` (RLY/1 §6).
   */
  function deviceFrame(channel: number, peerId: Uint8Array, payload: Uint8Array): DataFrame {
    return {
      version: RLY_VERSION,
      type: DATA_FRAME_TYPE,
      channel,
      peerKind: PeerKind.DEVICE,
      peerId,
      payload,
    }
  }

  interface Msg1Options {
    channelId?: number
    peerRawId?: Uint8Array
    deviceId?: string
    staticKey?: Keypair
    psk?: Uint8Array
  }

  /** Builds and sends a handshake msg1, returning the initiator half-handshake. */
  async function sendMsg1(ctx: Ctx, options: Msg1Options = {}): Promise<HandshakeState> {
    const channelId = options.channelId ?? 42
    const peerRawId = options.peerRawId ?? ctx.deviceRawId
    const deviceId = options.deviceId ?? ctx.deviceId
    const staticKey = options.staticKey ?? ctx.deviceNoiseKey
    const psk = options.psk ?? ctx.devicePsk

    const prologue = utf8ToBytes(`remora/1\x00session\x00${ctx.identity.hostId}\x00${deviceId}`)
    const initiator = createInitiatorHandshake({
      staticKey: staticKey.privateKey,
      remoteStaticKey: ctx.identity.noiseKeypair.publicKey,
      psk,
      prologue,
    })

    const msg1Bytes = initiator.writeMessage(utf8ToBytes(JSON.stringify({ v: 1, purpose: 'session' })))
    await ctx.channelManager.handleDataFrame(
      deviceFrame(
        channelId,
        peerRawId,
        concatBytes(Uint8Array.of(RECORD_TYPE.HANDSHAKE_MSG1), msg1Bytes),
      ),
    )
    return initiator
  }

  /** Runs the device side through msg2; resolves with a completed initiator. */
  async function completeHandshake(ctx: Ctx, options: Msg1Options = {}): Promise<HandshakeState> {
    const channelId = options.channelId ?? 42
    const framesBefore = ctx.sentFrames.length
    const initiator = await sendMsg1(ctx, options)

    expect(ctx.sentFrames).toHaveLength(framesBefore + 1)
    const resFrame = decodeDataFrame(ctx.sentFrames.at(-1)!)
    expect(resFrame.channel).toBe(channelId)
    expect(resFrame.peerKind).toBe(PeerKind.DEVICE)
    expect(resFrame.payload[0]).toBe(RECORD_TYPE.HANDSHAKE_MSG2)

    const plainMsg2 = initiator.readMessage(resFrame.payload.subarray(1))
    expect(initiator.isComplete).toBe(true)
    const parsedMsg2: unknown = JSON.parse(new TextDecoder().decode(plainMsg2))
    expect(parsedMsg2).toMatchObject({ v: 1 })
    return initiator
  }

  it('completes the Noise IKpsk2 handshake with a paired device', async () => {
    const ctx = setupTest()

    await completeHandshake(ctx, { channelId: 42 })

    expect(ctx.channelManager.getActiveSessionsCount()).toBe(1)
    expect(ctx.channelManager.getAuthFailureCount()).toBe(0)
    expect(ctx.deviceRecord.lastSeenAt).toBeGreaterThan(0)
  })

  it('round-trips an encrypted RCP request and response', async () => {
    const ctx = setupTest()
    const channelId = 42
    const initiator = await completeHandshake(ctx, { channelId })

    const reqJson = JSON.stringify({ k: 'req', id: 101, m: 'ping', p: { t: 999 } })
    const requestCiphertext = initiator.result.sendCipher.encryptWithAd(
      new Uint8Array(0),
      utf8ToBytes(reqJson),
    )
    await ctx.channelManager.handleDataFrame(
      deviceFrame(
        channelId,
        ctx.deviceRawId,
        concatBytes(Uint8Array.of(RECORD_TYPE.TRANSPORT), requestCiphertext),
      ),
    )

    expect(ctx.sentFrames).toHaveLength(2)
    const resFrame = decodeDataFrame(ctx.sentFrames[1]!)
    expect(resFrame.channel).toBe(channelId)
    expect(resFrame.peerKind).toBe(PeerKind.DEVICE)
    expect(resFrame.payload[0]).toBe(RECORD_TYPE.TRANSPORT)

    const resPlain = initiator.result.recvCipher.decryptWithAd(
      new Uint8Array(0),
      resFrame.payload.subarray(1),
    )
    const res = JSON.parse(new TextDecoder().decode(resPlain))
    expect(res.k).toBe('res')
    expect(res.id).toBe(101)
    expect(res.ok).toBe(true)
    expect(res.r.t).toBe(999)
  })

  it('drops a handshake from a device that is not in the registry', async () => {
    const ctx = setupTest()
    const unregisteredRawId = new Uint8Array(16).fill(0x44)

    await sendMsg1(ctx, {
      channelId: 43,
      peerRawId: unregisteredRawId,
      deviceId: `d_${encodeBase32(unregisteredRawId)}`,
    })

    expect(ctx.sentFrames).toHaveLength(0)
    expect(ctx.channelManager.getActiveSessionsCount()).toBe(0)
    expect(ctx.channelManager.getAuthFailureCount()).toBe(1)
  })

  it('drops a handshake whose static key does not match the registered device key', async () => {
    const ctx = setupTest()

    await sendMsg1(ctx, { channelId: 44, staticKey: generateKeypair() })

    expect(ctx.sentFrames).toHaveLength(0)
    expect(ctx.channelManager.getActiveSessionsCount()).toBe(0)
    expect(ctx.channelManager.getAuthFailureCount()).toBe(1)
  })

  it('drops a handshake from a revoked device', async () => {
    const ctx = setupTest()
    ctx.registry.revokeDevice(ctx.deviceId)

    await sendMsg1(ctx, { channelId: 45 })

    expect(ctx.sentFrames).toHaveLength(0)
    expect(ctx.channelManager.getActiveSessionsCount()).toBe(0)
    expect(ctx.channelManager.getAuthFailureCount()).toBe(1)
  })

  it('drops frames whose relay header is not a device source', async () => {
    const ctx = setupTest()
    const prologue = utf8ToBytes(`remora/1\x00session\x00${ctx.identity.hostId}\x00${ctx.deviceId}`)
    const initiator = createInitiatorHandshake({
      staticKey: ctx.deviceNoiseKey.privateKey,
      remoteStaticKey: ctx.identity.noiseKeypair.publicKey,
      psk: ctx.devicePsk,
      prologue,
    })
    const msg1Bytes = initiator.writeMessage(utf8ToBytes('{}'))

    await ctx.channelManager.handleDataFrame({
      version: RLY_VERSION,
      type: DATA_FRAME_TYPE,
      channel: 46,
      peerKind: PeerKind.HOST,
      peerId: ctx.deviceRawId,
      payload: concatBytes(Uint8Array.of(RECORD_TYPE.HANDSHAKE_MSG1), msg1Bytes),
    })

    expect(ctx.sentFrames).toHaveLength(0)
    expect(ctx.channelManager.getActiveSessionsCount()).toBe(0)
  })

  it('closes the channel upon corrupted transport ciphertext', async () => {
    const ctx = setupTest()
    const channelId = 47
    await completeHandshake(ctx, { channelId })
    expect(ctx.channelManager.getActiveSessionsCount()).toBe(1)

    const corruptPayload = concatBytes(
      Uint8Array.of(RECORD_TYPE.TRANSPORT),
      new Uint8Array(32).fill(0xff),
    )
    await ctx.channelManager.handleDataFrame(
      deviceFrame(channelId, ctx.deviceRawId, corruptPayload),
    )

    expect(ctx.channelManager.getActiveSessionsCount()).toBe(0)
  })

  it('closes every channel of a device when it is revoked', async () => {
    const ctx = setupTest()
    await completeHandshake(ctx, { channelId: 48 })
    await completeHandshake(ctx, { channelId: 49 })
    expect(ctx.channelManager.getActiveSessionsCount()).toBe(2)

    ctx.registry.revokeDevice(ctx.deviceId)
    ctx.channelManager.closeDevice(ctx.deviceId)

    expect(ctx.channelManager.getActiveSessionsCount()).toBe(0)
  })
})

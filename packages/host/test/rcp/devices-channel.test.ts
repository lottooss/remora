/**
 * P7-H7 acceptance — the channel half of `devices.unpair` (RCP/1 §7: the host
 * answers `{ ok: true }` and THEN closes the channel), proven against the real
 * channel stack: a real Noise IKpsk2 handshake into the real ChannelManager,
 * the real RcpServer with the real registerDevicesMethods registration, and
 * the real PersistentDeviceRegistry (memory mode, tests only) hooked to the
 * channel manager exactly the way apply() wires it in src/index.ts. There are
 * no fakes here; the injected `scheduleRelayRevoke` recorder stands only for
 * the relay boundary (crypto-v1.md §10), whose deferral is exercised by the
 * plugin-level tests in test/rcp/devices-methods.test.ts.
 */
import {
  concatBytes,
  createInitiatorHandshake,
  encodeBase32,
  encodeBase64Url,
  generateKeypair,
  utf8ToBytes,
  type HandshakeState,
} from '@remora/crypto'
import { DATA_FRAME_TYPE, PeerKind, RLY_VERSION, decodeDataFrame, type DataFrame } from '@remora/protocol'
import { describe, expect, it } from 'vitest'
import { ChannelManager, RECORD_TYPE } from '../../src/channel/index.ts'
import type { DeviceRecord } from '../../src/devices/index.ts'
import { PersistentDeviceRegistry } from '../../src/devices/persistent-registry.ts'
import { createHostIdentity, type HostIdentity } from '../../src/identity/index.ts'
import { RcpServer } from '../../src/rcp/index.ts'
import { ApprovalKeyRotationManager, registerDevicesMethods } from '../../src/rcp/methods/devices.ts'

/** Fixed, obviously fake test key material (AGENTS.md §10). */
const DEVICE_PSK = new Uint8Array(32).fill(0x55)
const PUSH_KEY = new Uint8Array(32).fill(0x33)
/** Uncompressed P-256 approval public keys (0x04 || X || Y), old and new. */
const KEY_OLD = new Uint8Array(65).fill(1)
const KEY_NEW = new Uint8Array(65).fill(9)
KEY_OLD[0] = 0x04
KEY_NEW[0] = 0x04
const ROTATION_REQUEST_ID = '5e22e13c-1111-4222-8333-000000000001'

function setupTest() {
  const identity: HostIdentity = createHostIdentity()
  const registry = new PersistentDeviceRegistry()
  const rcpServer = new RcpServer({
    hostId: identity.hostId,
    hostName: 'TestHost',
  })

  const sentFrames: Uint8Array[] = []
  const channelManager = new ChannelManager({
    identity,
    registry,
    rcpServer,
    sendFrame: (frame: Uint8Array) => {
      sentFrames.push(frame)
    },
  })

  // The exact revocation wiring apply() performs in src/index.ts.
  registry.setOnRevoke((deviceId: string) => {
    channelManager.closeDeviceChannels(deviceId)
  })

  const relayRevokes: string[] = []
  const rotations = new ApprovalKeyRotationManager({ registry })
  registerDevicesMethods(rcpServer, {
    registry,
    rotations,
    scheduleRelayRevoke: (deviceId: string) => {
      relayRevokes.push(deviceId)
    },
  })

  const deviceNoiseKey = generateKeypair()
  const deviceRawId = new Uint8Array(16).fill(0x22)
  const deviceId = `d_${encodeBase32(deviceRawId)}`

  const deviceRecord: DeviceRecord = {
    deviceId,
    name: 'Test Device',
    noisePublicKey: deviceNoiseKey.publicKey,
    devicePsk: DEVICE_PSK,
    pushKey: PUSH_KEY,
    approvalPublicKey: KEY_OLD,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    revoked: false,
  }
  registry.addDevice(deviceRecord)

  return {
    identity,
    registry,
    rotations,
    rcpServer,
    channelManager,
    deviceNoiseKey,
    deviceRawId,
    deviceId,
    deviceRecord,
    sentFrames,
    relayRevokes,
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

/** Runs the device side through the full Noise IKpsk2 handshake; real crypto. */
async function completeHandshake(ctx: Ctx, channelId: number): Promise<HandshakeState> {
  const prologue = utf8ToBytes(`remora/1\x00session\x00${ctx.identity.hostId}\x00${ctx.deviceId}`)
  const initiator = createInitiatorHandshake({
    staticKey: ctx.deviceNoiseKey.privateKey,
    remoteStaticKey: ctx.identity.noiseKeypair.publicKey,
    psk: DEVICE_PSK,
    prologue,
  })
  const msg1Bytes = initiator.writeMessage(utf8ToBytes(JSON.stringify({ v: 1, purpose: 'session' })))

  await ctx.channelManager.handleDataFrame(
    deviceFrame(channelId, ctx.deviceRawId, concatBytes(Uint8Array.of(RECORD_TYPE.HANDSHAKE_MSG1), msg1Bytes)),
  )
  expect(ctx.sentFrames).toHaveLength(1)
  const resFrame = decodeDataFrame(ctx.sentFrames[0]!)
  expect(resFrame.payload[0]).toBe(RECORD_TYPE.HANDSHAKE_MSG2)
  initiator.readMessage(resFrame.payload.subarray(1))
  expect(initiator.isComplete).toBe(true)
  return initiator
}

/** Sends one RCP request over the established channel as the device would. */
async function sendRequest(
  ctx: Ctx,
  initiator: HandshakeState,
  channelId: number,
  id: number,
  m: string,
  p?: Record<string, unknown>,
): Promise<void> {
  const reqJson = JSON.stringify(p === undefined ? { k: 'req', id, m } : { k: 'req', id, m, p })
  const requestCiphertext = initiator.result.sendCipher.encryptWithAd(new Uint8Array(0), utf8ToBytes(reqJson))
  await ctx.channelManager.handleDataFrame(
    deviceFrame(channelId, ctx.deviceRawId, concatBytes(Uint8Array.of(RECORD_TYPE.TRANSPORT), requestCiphertext)),
  )
}

/** Decodes the last sent frame's RCP reply envelope. */
function lastReply(ctx: Ctx, initiator: HandshakeState): { id: number; ok: boolean; r?: Record<string, unknown> } {
  const resFrame = decodeDataFrame(ctx.sentFrames.at(-1)!)
  expect(resFrame.payload[0]).toBe(RECORD_TYPE.TRANSPORT)
  const resPlain = initiator.result.recvCipher.decryptWithAd(new Uint8Array(0), resFrame.payload.subarray(1))
  return JSON.parse(new TextDecoder().decode(resPlain))
}

describe('devices.* over the real secure channel (P7-H7, RCP/1 §7)', () => {
  it('unpair delivers { ok: true } over the channel and THEN closes it', async () => {
    const ctx = setupTest()
    const channelId = 42
    const initiator = await completeHandshake(ctx, channelId)
    expect(ctx.channelManager.hasDeviceSession(ctx.deviceId)).toBe(true)

    await sendRequest(ctx, initiator, channelId, 7, 'devices.unpair', { requestId: ROTATION_REQUEST_ID })

    // The reply is still delivered over the channel the request came in on.
    expect(ctx.sentFrames).toHaveLength(2)
    const reply = lastReply(ctx, initiator)
    expect(reply).toMatchObject({ k: 'res', id: 7, ok: true, r: { ok: true } })

    // ...and THEN the channel is closed: no session remains, so a follow-up
    // request on the same channel is dropped without a reply.
    expect(ctx.channelManager.hasSession(ctx.deviceId, channelId)).toBe(false)
    expect(ctx.channelManager.hasDeviceSession(ctx.deviceId)).toBe(false)

    const framesBefore = ctx.sentFrames.length
    await sendRequest(ctx, initiator, channelId, 8, 'ping', { t: 1 })
    expect(ctx.sentFrames, 'a request after unpair must not be answered').toHaveLength(framesBefore)

    // The authoritative local revocation landed, and the relay-side revoke
    // was scheduled for after the reply (crypto-v1.md §10).
    expect(ctx.registry.getDeviceById(ctx.deviceId)?.revoked).toBe(true)
    expect(ctx.relayRevokes).toEqual([ctx.deviceId])
  })

  it('rotateApprovalKey stays pending over the channel until the PC confirms', async () => {
    const ctx = setupTest()
    const channelId = 43
    const initiator = await completeHandshake(ctx, channelId)

    await sendRequest(ctx, initiator, channelId, 9, 'devices.rotateApprovalKey', {
      approvalPub: encodeBase64Url(KEY_NEW),
      requestId: ROTATION_REQUEST_ID,
    })
    expect(ctx.sentFrames).toHaveLength(2)
    const reply = lastReply(ctx, initiator)
    expect(reply.ok).toBe(true)
    expect(reply.r).toEqual({ status: 'pending_pc_confirmation' })

    // Pending only: the device record still holds the old approval key.
    expect(ctx.registry.getDeviceById(ctx.deviceId)?.approvalPublicKey).toEqual(KEY_OLD)

    // The PC confirmation (management page) activates the new key.
    expect(ctx.rotations.confirm(ctx.deviceId)).toBe('resolved')
    expect(ctx.registry.getDeviceById(ctx.deviceId)?.approvalPublicKey).toEqual(KEY_NEW)
  })
})

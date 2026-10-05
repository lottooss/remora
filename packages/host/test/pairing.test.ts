import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createInitiatorHandshake,
  derivePairPsk,
  deriveSasCode,
  encodeBase32,
  encodeBase64Url,
  generateKeypair,
  getRelayPublicKey,
  parsePairingQr,
  randomBytes,
  utf8ToBytes,
} from '@remora/crypto'
import { PeerKind, decodeDataFrame, encodeDataFrame } from '@remora/protocol'
import { ChannelManager } from '../src/channel/index.ts'
import { PersistentDeviceRegistry } from '../src/devices/index.ts'
import { createHostIdentity } from '../src/identity/index.ts'
import { PairingService } from '../src/pairing/index.ts'
import { RcpServer } from '../src/rcp/index.ts'
import { formatSas, generateQrSvg, renderDashboardHtml } from '../src/web/index.ts'

function createDeviceKeys() {
  const seed = randomBytes(32)
  const deviceRelayKey = { privateKey: seed, publicKey: getRelayPublicKey(seed) }
  const deviceNoiseKey = generateKeypair()
  return { deviceRelayKey, deviceNoiseKey }
}

describe('P2-H1: Pairing and Device Registry', () => {
  it('PersistentDeviceRegistry saves, reloads, and revokes devices', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remora-registry-test-'))
    const filePath = path.join(tmpDir, 'devices.json')

    const reg1 = new PersistentDeviceRegistry(filePath)
    const noisePub = randomBytes(32)
    const devicePsk = randomBytes(32)
    const pushKey = randomBytes(32)

    reg1.addDevice({
      deviceId: 'd_test123',
      name: 'Pixel 8',
      noisePublicKey: noisePub,
      devicePsk,
      pushKey,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false,
    })

    expect(reg1.listDevices()).toHaveLength(1)
    expect(reg1.getDeviceById('d_test123')?.name).toBe('Pixel 8')

    // Reload from file
    const reg2 = new PersistentDeviceRegistry(filePath)
    expect(reg2.listDevices()).toHaveLength(1)
    const dev = reg2.getDeviceById('d_test123')
    expect(dev?.name).toBe('Pixel 8')
    expect(dev?.revoked).toBe(false)

    // Revoke
    let revokedId: string | null = null
    reg2.setOnRevoke((id) => {
      revokedId = id
    })
    reg2.revokeDevice('d_test123')
    expect(dev?.revoked).toBe(true)
    expect(revokedId).toBe('d_test123')

    // Verify revoked status persists
    const reg3 = new PersistentDeviceRegistry(filePath)
    expect(reg3.getDeviceById('d_test123')?.revoked).toBe(true)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs full pairing handshake, SAS computation, and confirmation', async () => {
    const hostIdentity = createHostIdentity()
    const registry = new PersistentDeviceRegistry()
    const hostFrames: Uint8Array[] = []

    const pairingService = new PairingService({
      identity: hostIdentity,
      hostName: 'TestHost',
      relayOrigin: 'https://relay.test',
      registry,
      sendFrame: (bytes) => {
        hostFrames.push(bytes)
      },
    })

    const attempt = await pairingService.beginPairing()
    expect(attempt.qrPayload).toContain('remora://pair?')
    const parsedQr = parsePairingQr(attempt.qrPayload)
    expect(parsedQr.hostId).toBe(hostIdentity.hostId)

    // Fake device setup
    const { deviceRelayKey, deviceNoiseKey } = createDeviceKeys()
    const deviceId = `d_${encodeBase32(deviceRelayKey.publicKey.subarray(0, 16))}`
    const peerRawId = deviceRelayKey.publicKey.subarray(0, 16)
    const channelId = 42

    const pairPsk = derivePairPsk(attempt.pairingSecret, hostIdentity.hostId)
    const prologue = utf8ToBytes(`remora/1\x00pair\x00${hostIdentity.hostId}\x00${deviceId}`)

    const initiator = createInitiatorHandshake({
      staticKey: deviceNoiseKey.privateKey,
      remoteStaticKey: hostIdentity.noiseKeypair.publicKey,
      psk: pairPsk,
      prologue,
    })

    const msg1Payload = utf8ToBytes(
      JSON.stringify({
        v: 1,
        purpose: 'pair',
        deviceId,
        relayPub: encodeBase64Url(deviceRelayKey.publicKey),
        name: 'Pixel 8',
      }),
    )
    const msg1 = initiator.writeMessage(msg1Payload)

    // Host processes msg1
    const handled = await pairingService.handlePairingHandshake(
      deviceId,
      channelId,
      peerRawId,
      msg1,
    )
    expect(handled).toBe(true)
    expect(hostFrames).toHaveLength(1)

    // Check msg2 delivered by host
    const msg2Frame = decodeDataFrame(hostFrames[0]!)
    expect(msg2Frame.channel).toBe(channelId)
    expect(msg2Frame.payload[0]).toBe(0x02) // HANDSHAKE_MSG2

    const msg2Bytes = msg2Frame.payload.subarray(1)
    const decryptedMsg2 = initiator.readMessage(msg2Bytes)
    const parsedMsg2 = JSON.parse(new TextDecoder().decode(decryptedMsg2))
    expect(parsedMsg2.hostId).toBe(hostIdentity.hostId)

    // SAS match (host and client derive it from the completed transcript)
    const clientSas = deriveSasCode(initiator.result.handshakeHash)
    expect(attempt.sasCode).toBe(clientSas)

    // Host confirms pairing
    const confirmed = await pairingService.confirmPairing(clientSas)
    expect(confirmed).toBe(true)

    // Device stored in registry
    const storedDevice = registry.getDeviceById(deviceId)
    expect(storedDevice).toBeDefined()
    expect(storedDevice?.name).toBe('Pixel 8')
    expect(storedDevice?.devicePsk).toHaveLength(32)
    expect(storedDevice?.revoked).toBe(false)

    // Frame 2 is pair.complete RCP message
    expect(hostFrames).toHaveLength(2)
    const completeFrame = decodeDataFrame(hostFrames[1]!)
    expect(completeFrame.payload[0]).toBe(0x03) // TRANSPORT

    const completePlaintext = initiator.result.recvCipher.decryptWithAd(
      new Uint8Array(0),
      completeFrame.payload.subarray(1),
    )
    const completeRcp = JSON.parse(new TextDecoder().decode(completePlaintext))
    expect(completeRcp.m).toBe('pair.complete')
    expect(completeRcp.p.host.id).toBe(hostIdentity.hostId)
  })

  it('rejects pairing with wrong SAS code', async () => {
    const hostIdentity = createHostIdentity()
    const registry = new PersistentDeviceRegistry()

    const pairingService = new PairingService({
      identity: hostIdentity,
      hostName: 'TestHost',
      relayOrigin: 'https://relay.test',
      registry,
      sendFrame: () => {},
    })

    const attempt = await pairingService.beginPairing()
    const { deviceRelayKey, deviceNoiseKey } = createDeviceKeys()
    const deviceId = `d_${encodeBase32(deviceRelayKey.publicKey.subarray(0, 16))}`
    const peerRawId = deviceRelayKey.publicKey.subarray(0, 16)

    const pairPsk = derivePairPsk(attempt.pairingSecret, hostIdentity.hostId)
    const prologue = utf8ToBytes(`remora/1\x00pair\x00${hostIdentity.hostId}\x00${deviceId}`)

    const initiator = createInitiatorHandshake({
      staticKey: deviceNoiseKey.privateKey,
      remoteStaticKey: hostIdentity.noiseKeypair.publicKey,
      psk: pairPsk,
      prologue,
    })

    const msg1 = initiator.writeMessage(
      utf8ToBytes(
        JSON.stringify({
          v: 1,
          purpose: 'pair',
          deviceId,
          relayPub: encodeBase64Url(deviceRelayKey.publicKey),
        }),
      ),
    )

    await pairingService.handlePairingHandshake(deviceId, 1, peerRawId, msg1)
    const confirmed = await pairingService.confirmPairing('000000')
    expect(confirmed).toBe(false)
    expect(registry.getDeviceById(deviceId)).toBeNull()
  })

  it('rejects pairing with wrong PSK or device ID mismatch', async () => {
    const hostIdentity = createHostIdentity()
    const registry = new PersistentDeviceRegistry()

    const pairingService = new PairingService({
      identity: hostIdentity,
      hostName: 'TestHost',
      relayOrigin: 'https://relay.test',
      registry,
      sendFrame: () => {},
    })

    await pairingService.beginPairing()
    const { deviceRelayKey, deviceNoiseKey } = createDeviceKeys()
    const deviceId = `d_${encodeBase32(deviceRelayKey.publicKey.subarray(0, 16))}`
    const peerRawId = deviceRelayKey.publicKey.subarray(0, 16)

    // Wrong PSK
    const wrongPsk = randomBytes(32)
    const prologue = utf8ToBytes(`remora/1\x00pair\x00${hostIdentity.hostId}\x00${deviceId}`)

    const initiator = createInitiatorHandshake({
      staticKey: deviceNoiseKey.privateKey,
      remoteStaticKey: hostIdentity.noiseKeypair.publicKey,
      psk: wrongPsk,
      prologue,
    })

    // 1. Device ID mismatch
    const badMsg1 = initiator.writeMessage(
      utf8ToBytes(
        JSON.stringify({
          v: 1,
          purpose: 'pair',
          deviceId: 'd_mismatched',
          relayPub: encodeBase64Url(deviceRelayKey.publicKey),
        }),
      ),
    )
    const handledMismatch = await pairingService.handlePairingHandshake(deviceId, 1, peerRawId, badMsg1)
    expect(handledMismatch).toBe(false)

    // 2. Wrong PSK causes initiator msg2 decryption failure
    let hostSentMsg2: Uint8Array | null = null
    const pairingServiceWithFrame = new PairingService({
      identity: hostIdentity,
      hostName: 'TestHost',
      relayOrigin: 'https://relay.test',
      registry,
      sendFrame: (frameBytes) => {
        hostSentMsg2 = frameBytes
      },
    })
    await pairingServiceWithFrame.beginPairing()

    const initiator2 = createInitiatorHandshake({
      staticKey: deviceNoiseKey.privateKey,
      remoteStaticKey: hostIdentity.noiseKeypair.publicKey,
      psk: wrongPsk,
      prologue,
    })

    const validMsg1 = initiator2.writeMessage(
      utf8ToBytes(
        JSON.stringify({
          v: 1,
          purpose: 'pair',
          deviceId,
          relayPub: encodeBase64Url(deviceRelayKey.publicKey),
        }),
      ),
    )
    await pairingServiceWithFrame.handlePairingHandshake(deviceId, 1, peerRawId, validMsg1)
    expect(hostSentMsg2).not.toBeNull()

    const msg2Payload = decodeDataFrame(hostSentMsg2!).payload.subarray(1)
    // Initiator was created with wrongPsk, so reading msg2 must fail with a NoiseError
    expect(() => initiator2.readMessage(msg2Payload)).toThrow()
  })

  it('ChannelManager integration with pairing and revocation', async () => {
    const hostIdentity = createHostIdentity()
    const registry = new PersistentDeviceRegistry()
    const rcpServer = new RcpServer({ hostId: hostIdentity.hostId, hostName: 'Host' })
    const outFrames: Uint8Array[] = []

    let pairingService!: PairingService
    const channelManager = new ChannelManager({
      identity: hostIdentity,
      registry,
      rcpServer,
      sendFrame: (bytes) => {
        outFrames.push(bytes)
      },
      pairingService: {
        hasActiveAttempt: () => pairingService.hasActiveAttempt(),
        handlePairingHandshake: (d, c, p, m) => pairingService.handlePairingHandshake(d, c, p, m),
      },
    })

    pairingService = new PairingService({
      identity: hostIdentity,
      hostName: 'Host',
      relayOrigin: 'https://relay.test',
      registry,
      sendFrame: (bytes) => {
        outFrames.push(bytes)
      },
    })

    registry.setOnRevoke((id) => {
      channelManager.closeDeviceChannels(id)
    })

    const attempt = await pairingService.beginPairing()
    const { deviceRelayKey, deviceNoiseKey } = createDeviceKeys()
    const deviceId = `d_${encodeBase32(deviceRelayKey.publicKey.subarray(0, 16))}`
    const peerRawId = deviceRelayKey.publicKey.subarray(0, 16)
    const channelId = 100

    const pairPsk = derivePairPsk(attempt.pairingSecret, hostIdentity.hostId)
    const prologue = utf8ToBytes(`remora/1\x00pair\x00${hostIdentity.hostId}\x00${deviceId}`)

    const initiator = createInitiatorHandshake({
      staticKey: deviceNoiseKey.privateKey,
      remoteStaticKey: hostIdentity.noiseKeypair.publicKey,
      psk: pairPsk,
      prologue,
    })

    const msg1 = initiator.writeMessage(
      utf8ToBytes(
        JSON.stringify({
          v: 1,
          purpose: 'pair',
          deviceId,
          relayPub: encodeBase64Url(deviceRelayKey.publicKey),
        }),
      ),
    )

    // Deliver msg1 via ChannelManager's handleDataFrame
    const dataFrameBytes = encodeDataFrame({
      channel: channelId,
      peerKind: PeerKind.DEVICE,
      peerId: peerRawId,
      payload: new Uint8Array([0x01, ...msg1]),
    })

    await channelManager.handleDataFrame(decodeDataFrame(dataFrameBytes))
    expect(attempt.state).toBe('awaiting_confirmation')

    // Confirm
    await pairingService.confirmPairing(attempt.sasCode!)
    expect(registry.getDeviceById(deviceId)).toBeDefined()

    // Now device connects a regular session channel with devicePsk
    const storedDevice = registry.getDeviceById(deviceId)!
    const sessionChannelId = 101
    const sessionPrologue = utf8ToBytes(
      `remora/1\x00session\x00${hostIdentity.hostId}\x00${deviceId}`,
    )

    const sessionInitiator = createInitiatorHandshake({
      staticKey: deviceNoiseKey.privateKey,
      remoteStaticKey: hostIdentity.noiseKeypair.publicKey,
      psk: storedDevice.devicePsk,
      prologue: sessionPrologue,
    })

    const sessionMsg1 = sessionInitiator.writeMessage(
      utf8ToBytes(JSON.stringify({ v: 1, purpose: 'session' })),
    )

    outFrames.length = 0
    const sessionFrameBytes = encodeDataFrame({
      channel: sessionChannelId,
      peerKind: PeerKind.DEVICE,
      peerId: peerRawId,
      payload: new Uint8Array([0x01, ...sessionMsg1]),
    })
    await channelManager.handleDataFrame(decodeDataFrame(sessionFrameBytes))

    expect(outFrames).toHaveLength(1) // msg2 sent!

    // Revoke device
    registry.revokeDevice(deviceId)

    // New handshake after revoke is dropped
    outFrames.length = 0
    const revokedFrameBytes = encodeDataFrame({
      channel: 102,
      peerKind: PeerKind.DEVICE,
      peerId: peerRawId,
      payload: new Uint8Array([0x01, ...sessionMsg1]),
    })
    await channelManager.handleDataFrame(decodeDataFrame(revokedFrameBytes))
    expect(outFrames).toHaveLength(0) // dropped silently
  })

  it('renders web dashboard and SVG QR code', async () => {
    const qrSvg = await generateQrSvg('remora://pair?v=1&h=h_1234')
    expect(qrSvg).toContain('<svg')

    const html = renderDashboardHtml({
      hostId: 'h_test1234567890',
      hostName: 'MyPC',
      relayStatus: 'ready',
      devices: [
        { deviceId: 'd_abc', name: 'Pixel', pairedAt: 123456, revoked: false },
        { deviceId: 'd_def', name: 'Tablet', pairedAt: 123457, revoked: true },
      ],
      activePairing: { sasCode: '482193', expiresAt: Date.now() + 100000, state: 'awaiting_confirmation' },
    })

    expect(html).toContain('Remora Host Management')
    expect(html).toContain('Pixel')
    expect(html).toContain('Tablet')
    expect(html).toContain('482 193')
    expect(formatSas('482193')).toBe('482 193')
  })
})

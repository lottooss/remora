/**
 * End-to-end scenarios with random keys and a Remora-shaped prologue:
 * payload edge cases, tamper/replay behavior, mismatch failures, size limits.
 */
import { describe, expect, it } from 'vitest'
import {
  HandshakeState,
  MAX_TRANSPORT_PAYLOAD,
  PROTOCOL_NAME,
  generateKeypair,
  keypairFromSecret,
  utf8,
} from '../src/index.ts'
import { INTEROP, TEST_PSK, completeHandshake, newHandshakePair, remoraPrologue } from './helpers.ts'

const EMPTY = new Uint8Array(0)

describe('IKpsk2 handshake', () => {
  it('completes with random keys, matching hashes, and mutual static authentication', () => {
    const pair = newHandshakePair()
    const { msg1, msg2, plain1, plain2 } = completeHandshake(
      pair,
      utf8(INTEROP.msg1),
      utf8(INTEROP.msg2),
    )
    expect(plain1).toEqual(utf8(INTEROP.msg1))
    expect(plain2).toEqual(utf8(INTEROP.msg2))
    expect(pair.initiator.isComplete).toBe(true)
    expect(pair.responder.isComplete).toBe(true)
    expect(pair.initiator.result.handshakeHash).toEqual(pair.responder.result.handshakeHash)
    expect(pair.responder.result.remoteStatic).toEqual(pair.initKeypair.publicKey)
    expect(pair.initiator.result.remoteStatic).toEqual(pair.respKeypair.publicKey)
    // msg1 = e(32) + encrypted s(48) + encrypted payload(16 + n); msg2 = e(32) + payload(16 + n).
    expect(msg1.length).toBe(80 + 16 + INTEROP.msg1.length)
    expect(msg2.length).toBe(48 + INTEROP.msg2.length)
  })

  it('handles zero-length handshake payloads (tag-only fields)', () => {
    const pair = newHandshakePair()
    const { msg1, msg2 } = completeHandshake(pair, EMPTY, EMPTY)
    expect(msg1.length).toBe(96)
    expect(msg2.length).toBe(48)
    expect(pair.initiator.result.handshakeHash).toEqual(pair.responder.result.handshakeHash)
  })

  it('fails when the PSKs differ', () => {
    const prologue = remoraPrologue('pair')
    const init = generateKeypair()
    const resp = generateKeypair()
    const wrongPsk = new Uint8Array(32).fill(0xaa)
    const initiator = new HandshakeState({
      initiator: true,
      prologue,
      staticKeypair: init,
      remoteStatic: resp.publicKey,
      psk: TEST_PSK,
    })
    const responder = new HandshakeState({
      initiator: false,
      prologue,
      staticKeypair: resp,
      psk: wrongPsk,
    })
    const msg1 = initiator.writeMessage(utf8('hello'))
    responder.readMessage(msg1)
    const msg2 = responder.writeMessage(utf8('world'))
    expect(() => initiator.readMessage(msg2)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
  })

  it('fails when the prologues differ', () => {
    const resp = generateKeypair()
    const initiator = new HandshakeState({
      initiator: true,
      prologue: remoraPrologue('pair'),
      staticKeypair: generateKeypair(),
      remoteStatic: resp.publicKey,
      psk: TEST_PSK,
    })
    const responder = new HandshakeState({
      initiator: false,
      prologue: remoraPrologue('session'),
      staticKeypair: resp,
      psk: TEST_PSK,
    })
    const msg1 = initiator.writeMessage(utf8('hello'))
    expect(() => responder.readMessage(msg1)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
  })

  it('rejects a low-order pinned responder key', () => {
    const initiator = new HandshakeState({
      initiator: true,
      prologue: remoraPrologue('session'),
      staticKeypair: generateKeypair(),
      remoteStatic: new Uint8Array(32),
      psk: TEST_PSK,
    })
    expect(() => initiator.writeMessage(utf8('hello'))).toThrow(
      expect.objectContaining({ code: 'invalid_public_key' }),
    )
  })

  it('rejects out-of-turn and post-completion calls', () => {
    const pair = newHandshakePair()
    expect(() => pair.responder.writeMessage(EMPTY)).toThrow(
      expect.objectContaining({ code: 'invalid_message' }),
    )
    const msg1 = pair.initiator.writeMessage(utf8('one'))
    expect(() => pair.initiator.writeMessage(utf8('two'))).toThrow(
      expect.objectContaining({ code: 'invalid_message' }),
    )
    pair.responder.readMessage(msg1)
    const msg2 = pair.responder.writeMessage(utf8('three'))
    pair.initiator.readMessage(msg2)
    expect(() => pair.initiator.writeMessage(utf8('four'))).toThrow(
      expect.objectContaining({ code: 'handshake_exhausted' }),
    )
    expect(() => pair.responder.readMessage(msg1)).toThrow(
      expect.objectContaining({ code: 'handshake_exhausted' }),
    )
  })

  it('rejects truncated and tampered handshake messages', () => {
    const pair = newHandshakePair()
    const msg1 = pair.initiator.writeMessage(utf8('payload'))
    expect(() => pair.responder.readMessage(msg1.subarray(0, 60))).toThrow(
      expect.objectContaining({ code: 'invalid_message' }),
    )
    const other = newHandshakePair({ respStaticSecret: pair.respKeypair.secretKey })
    const tampered = msg1.slice()
    tampered[100] = (tampered[100] as number) ^ 0x01
    expect(() => other.responder.readMessage(tampered)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
  })

  it('rejects handshake messages over the 65535-byte ceiling', () => {
    const pair = newHandshakePair()
    expect(() => pair.initiator.writeMessage(new Uint8Array(65440))).toThrow(
      expect.objectContaining({ code: 'message_too_large' }),
    )
  })

  it('requires a 32-byte PSK and an IK initiator static pin', () => {
    const resp = generateKeypair()
    expect(
      () =>
        new HandshakeState({
          initiator: true,
          prologue: EMPTY,
          staticKeypair: generateKeypair(),
          remoteStatic: resp.publicKey,
          psk: new Uint8Array(16),
        }),
    ).toThrow(expect.objectContaining({ code: 'invalid_key_length' }))
    expect(
      () =>
        new HandshakeState({
          initiator: true,
          prologue: EMPTY,
          staticKeypair: generateKeypair(),
        }),
    ).toThrow(expect.objectContaining({ code: 'missing_key' }))
  })

  it('zeroizes the static and ephemeral secrets after split()', () => {
    const staticSecret = new Uint8Array(32).fill(0x5c)
    const ephemeralSecret = new Uint8Array(32).fill(0xe7)
    const resp = generateKeypair()
    const initiator = new HandshakeState({
      initiator: true,
      prologue: remoraPrologue('session'),
      staticKeypair: keypairFromSecret(staticSecret),
      remoteStatic: resp.publicKey,
      psk: TEST_PSK,
      ephemeralSecret,
    })
    const responder = new HandshakeState({
      initiator: false,
      prologue: remoraPrologue('session'),
      staticKeypair: resp,
      psk: TEST_PSK,
    })
    const msg1 = initiator.writeMessage(utf8('x'))
    responder.readMessage(msg1)
    const msg2 = responder.writeMessage(utf8('y'))
    initiator.readMessage(msg2)
    expect(staticSecret.every((byte) => byte === 0)).toBe(true)
    expect(ephemeralSecret.every((byte) => byte === 0)).toBe(true)
    // Public halves survive.
    expect(initiator.result.handshakeHash).toEqual(responder.result.handshakeHash)
  })
})

describe('transport phase', () => {
  it('exchanges 1000 messages in each direction with exact payloads', () => {
    const pair = newHandshakePair()
    completeHandshake(pair, utf8(INTEROP.msg1), utf8(INTEROP.msg2))
    const iSend = pair.initiator.result.send
    const iRecv = pair.initiator.result.recv
    const rSend = pair.responder.result.send
    const rRecv = pair.responder.result.recv
    for (let i = 0; i < 1000; i += 1) {
      const up = utf8(INTEROP.k2t(i))
      const down = utf8(INTEROP.t2k(i))
      const upCt = iSend.encryptWithAd(EMPTY, up)
      expect(rRecv.decryptWithAd(EMPTY, upCt)).toEqual(up)
      const downCt = rSend.encryptWithAd(EMPTY, down)
      expect(iRecv.decryptWithAd(EMPTY, downCt)).toEqual(down)
    }
    expect(iSend.nonce).toBe(1000n)
    expect(rSend.nonce).toBe(1000n)
  })

  it('encrypts and decrypts empty transport payloads (tag-only frames)', () => {
    const pair = newHandshakePair()
    completeHandshake(pair, EMPTY, EMPTY)
    const ciphertext = pair.initiator.result.send.encryptWithAd(EMPTY, EMPTY)
    expect(ciphertext.length).toBe(16)
    expect(pair.responder.result.recv.decryptWithAd(EMPTY, ciphertext)).toEqual(EMPTY)
  })

  it('supports a payload up to 65519 bytes', () => {
    const pair = newHandshakePair()
    completeHandshake(pair, EMPTY, EMPTY)
    const big = new Uint8Array(MAX_TRANSPORT_PAYLOAD).fill(0x7a)
    const ciphertext = pair.initiator.result.send.encryptWithAd(EMPTY, big)
    expect(ciphertext.length).toBe(65535)
    expect(pair.responder.result.recv.decryptWithAd(EMPTY, ciphertext)).toEqual(big)
  })

  it('fails on one flipped byte and does not consume the nonce', () => {
    const pair = newHandshakePair()
    completeHandshake(pair, EMPTY, EMPTY)
    const send = pair.initiator.result.send
    const recv = pair.responder.result.recv
    const ciphertext = send.encryptWithAd(EMPTY, utf8('frame-0'))
    const tampered = ciphertext.slice()
    tampered[3] = (tampered[3] as number) ^ 0x01
    expect(() => recv.decryptWithAd(EMPTY, tampered)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
    expect(recv.decryptWithAd(EMPTY, ciphertext)).toEqual(utf8('frame-0'))
  })

  it('exposes the pinned protocol name', () => {
    expect(PROTOCOL_NAME).toBe('Noise_IKpsk2_25519_ChaChaPoly_SHA256')
  })
})

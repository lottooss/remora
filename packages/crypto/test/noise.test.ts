import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import cacophonyVectors from '../../../conformance/vectors/crypto/noise-cacophony-ikpsk2.json' with { type: 'json' }
import {
  CipherState,
  HandshakeState,
  MAX_NONCE,
  MAX_NOISE_MESSAGE,
  MAX_TRANSPORT_PAYLOAD,
  NoiseError,
  PROTOCOL_NAME,
  SymmetricState,
  TAGLEN,
  createInitiatorHandshake,
  createResponderHandshake,
  dh,
  encryptWithAd,
  generateKeypair,
  hash,
  hkdf2,
  hkdf3,
  keypairFromPrivate,
  noiseNonce,
  utf8,
} from '../src/noise/index.ts'

const EMPTY = new Uint8Array(0)
const TEST_PSK = hexToBytes('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff')

/** Crypto/1 §6 prologue: "remora/1" ‖ 0x00 ‖ purpose ‖ 0x00 ‖ hostId ‖ 0x00 ‖ deviceId. */
function remoraPrologue(purpose: 'pair' | 'session'): Uint8Array {
  return utf8(`remora/1\0${purpose}\0h_test\0d_test`)
}

interface VectorMessage {
  payload: string
  ciphertext: string
}

interface VectorInput {
  protocolName: string
  initPrologue: string
  initPsks: string[]
  initStatic: string
  initEphemeral: string
  initRemoteStatic: string
  respPrologue: string
  respPsks: string[]
  respStatic: string
  respEphemeral: string
  messages: VectorMessage[]
}

interface VectorCase {
  name: string
  input: VectorInput
  expect: { handshakeHash: string }
}

interface VectorDoc {
  suite: string
  version: number
  source: string
  cases: VectorCase[]
}

const vectors = cacophonyVectors as VectorDoc

describe('Noise primitives (Crypto/1 §1)', () => {
  it('generates 32-byte X25519 keypairs and agrees on DH', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    expect(alice.privateKey).toHaveLength(32)
    expect(alice.publicKey).toHaveLength(32)
    expect(bob.publicKey).not.toEqual(alice.publicKey)
    expect(dh(alice.privateKey, bob.publicKey)).toEqual(dh(bob.privateKey, alice.publicKey))
  })

  it('rejects low-order peer public keys (fail closed)', () => {
    const alice = generateKeypair()
    expect(() => dh(alice.privateKey, new Uint8Array(32))).toThrow(
      expect.objectContaining({ code: 'invalid_public_key' }),
    )
  })

  it('encodes the ChaCha20 nonce as 4 zero bytes + 8-byte LE counter', () => {
    expect(noiseNonce(0n)).toEqual(new Uint8Array(12))
    expect(noiseNonce(1n)).toEqual(Uint8Array.from([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]))
    expect(noiseNonce(0x0102030405060708n)).toEqual(
      Uint8Array.from([0, 0, 0, 0, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]),
    )
    expect(() => noiseNonce(MAX_NONCE + 1n)).toThrow(NoiseError)
    expect(() => noiseNonce(-1n)).toThrow(NoiseError)
  })

  it('computes SHA-256 and the Noise HKDF chain', () => {
    expect(bytesToHex(hash(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    const ck = hash(utf8('chaining-key'))
    const [a1, a2] = hkdf2(ck, TEST_PSK)
    const [b1, b2, b3] = hkdf3(ck, TEST_PSK)
    expect(a1).toHaveLength(32)
    expect(a2).toHaveLength(32)
    expect(b3).toHaveLength(32)
    // hkdf3 extends the same chain: first two outputs match hkdf2.
    expect(b1).toEqual(a1)
    expect(b2).toEqual(a2)
    expect(b3).not.toEqual(a2)
  })

  it('round-trips AEAD encryption at a given nonce', () => {
    const k = hexToBytes('4242424242424242424242424242424242424242424242424242424242424242')
    const ad = utf8('remora/1')
    const plaintext = utf8('frame')
    const ciphertext = encryptWithAd(k, 7n, ad, plaintext)
    expect(ciphertext).toHaveLength(plaintext.length + TAGLEN)
    expect(ciphertext).not.toEqual(encryptWithAd(k, 8n, ad, plaintext))
    expect(() => encryptWithAd(k.slice(0, 16), 0n, ad, plaintext)).toThrow(NoiseError)
  })
})

describe('CipherState (Noise §5.1)', () => {
  it('passes data through when k is empty', () => {
    const cs = new CipherState()
    expect(cs.hasKey()).toBe(false)
    expect(cs.encryptWithAd(utf8('ad'), utf8('clear'))).toEqual(utf8('clear'))
    expect(cs.decryptWithAd(utf8('ad'), utf8('clear'))).toEqual(utf8('clear'))
    expect(cs.nonce).toBe(0n)
  })

  it('increments n and does not advance it on authentication failure', () => {
    const key = hexToBytes('1111111111111111111111111111111111111111111111111111111111111111')
    const ad = utf8('ad')
    const rx = new CipherState()
    rx.initializeKey(key.slice())
    const tx = new CipherState()
    tx.initializeKey(key.slice())
    const first = tx.encryptWithAd(ad, utf8('frame-0'))
    const second = tx.encryptWithAd(ad, utf8('frame-1'))
    expect(rx.decryptWithAd(ad, first)).toEqual(utf8('frame-0'))
    expect(rx.nonce).toBe(1n)
    const tampered = second.slice()
    tampered[0] = (tampered[0] as number) ^ 0x01
    expect(() => rx.decryptWithAd(ad, tampered)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
    expect(rx.nonce).toBe(1n)
    expect(rx.decryptWithAd(ad, second)).toEqual(utf8('frame-1'))
  })

  it('signals nonce_exhausted at the reserved value 2^64-1', () => {
    const cs = new CipherState()
    cs.initializeKey(hexToBytes('2222222222222222222222222222222222222222222222222222222222222222'))
    cs.setNonce(MAX_NONCE - 1n)
    cs.encryptWithAd(EMPTY, utf8('last'))
    expect(() => cs.encryptWithAd(EMPTY, utf8('nope'))).toThrow(
      expect.objectContaining({ code: 'nonce_exhausted' }),
    )
  })

  it('rekeys to ENCRYPT(k, 2^64-1, zerolen, zeros32)[0..32] without resetting n', () => {
    const key = hexToBytes('3333333333333333333333333333333333333333333333333333333333333333')
    // Independent computation of REKEY(k) per Noise §4.2.
    const expectedKey = encryptWithAd(key, MAX_NONCE, EMPTY, new Uint8Array(32)).slice(0, 32)

    const tx = new CipherState()
    tx.initializeKey(key.slice())
    tx.encryptWithAd(EMPTY, utf8('before')) // n: 0 → 1
    tx.rekey()
    expect(tx.nonce).toBe(1n) // §11.3: rekey does not reset n

    const ciphertext = tx.encryptWithAd(EMPTY, utf8('after')) // n = 1 under the rekeyed key
    const rx = new CipherState()
    rx.initializeKey(expectedKey)
    rx.setNonce(1n)
    expect(rx.decryptWithAd(EMPTY, ciphertext)).toEqual(utf8('after'))
    expect(tx.nonce).toBe(2n)
    expect(rx.nonce).toBe(2n)

    // Decrypting the same frame at n = 0 fails: the frame was bound to n = 1.
    const wrongNonce = new CipherState()
    wrongNonce.initializeKey(expectedKey.slice())
    expect(() => wrongNonce.decryptWithAd(EMPTY, ciphertext)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
  })

  it('rejects rekey without a key and zeroizes owned key material', () => {
    const cs = new CipherState()
    expect(() => cs.rekey()).toThrow(expect.objectContaining({ code: 'missing_key' }))
    const owned = hexToBytes('4444444444444444444444444444444444444444444444444444444444444444')
    cs.initializeKey(owned)
    expect(cs.hasKey()).toBe(true)
    cs.zeroize()
    expect(cs.hasKey()).toBe(false)
    expect(owned.every((byte) => byte === 0)).toBe(true)
  })
})

describe('SymmetricState (Noise §5.2)', () => {
  it('hashes a protocol name longer than HASHLEN', () => {
    expect(utf8(PROTOCOL_NAME)).toHaveLength(36)
    const ss = new SymmetricState(PROTOCOL_NAME)
    expect(ss.getHandshakeHash()).toEqual(hash(utf8(PROTOCOL_NAME)))
    expect(ss.cipherState.hasKey()).toBe(false)
  })

  it('zero-pads a protocol name shorter than HASHLEN', () => {
    const name = 'Noise_NN_25519_Ch'
    expect(name.length).toBeLessThanOrEqual(32)
    const ss = new SymmetricState(name)
    const expected = new Uint8Array(32)
    expected.set(utf8(name))
    expect(ss.getHandshakeHash()).toEqual(expected)
  })
})

describe('Cacophony conformance vectors', () => {
  it('imports the official IKpsk2 ChaChaPoly SHA256 suite', () => {
    expect(vectors.suite).toBe('crypto/noise-cacophony-ikpsk2')
    expect(vectors.version).toBe(1)
    expect(vectors.source).toContain('cacophony.txt')
    expect(vectors.cases.length).toBeGreaterThanOrEqual(1)
  })

  for (const testCase of vectors.cases) {
    it(testCase.name, () => {
      const { input, expect: expected } = testCase
      expect(input.protocolName).toBe(PROTOCOL_NAME)
      expect(input.initPrologue).toBe(input.respPrologue)
      expect(input.initPsks).toEqual(input.respPsks)
      const pskHex = input.initPsks[0]
      if (pskHex === undefined) throw new Error('vector case has no PSK')
      const psk = hexToBytes(pskHex)
      const prologue = hexToBytes(input.initPrologue)

      const initKeypair = keypairFromPrivate(hexToBytes(input.initStatic))
      const respKeypair = keypairFromPrivate(hexToBytes(input.respStatic))
      expect(bytesToHex(respKeypair.publicKey)).toBe(input.initRemoteStatic)

      const initiator = createInitiatorHandshake({
        staticKey: hexToBytes(input.initStatic),
        remoteStaticKey: hexToBytes(input.initRemoteStatic),
        psk,
        prologue,
        ephemeralSecret: hexToBytes(input.initEphemeral),
      })
      const responder = createResponderHandshake({
        staticKey: hexToBytes(input.respStatic),
        psk,
        prologue,
        ephemeralSecret: hexToBytes(input.respEphemeral),
      })

      input.messages.forEach((message, index) => {
        const payload = hexToBytes(message.payload)
        if (index === 0) {
          const out = initiator.writeMessage(payload)
          expect(bytesToHex(out)).toBe(message.ciphertext)
          expect(bytesToHex(responder.readMessage(out))).toBe(message.payload)
        } else if (index === 1) {
          const out = responder.writeMessage(payload)
          expect(bytesToHex(out)).toBe(message.ciphertext)
          expect(bytesToHex(initiator.readMessage(out))).toBe(message.payload)
        } else {
          // Transport: even index = initiator → responder (c1), odd = reverse (c2).
          const send = index % 2 === 0 ? initiator.result.sendCipher : responder.result.sendCipher
          const recv = index % 2 === 0 ? responder.result.recvCipher : initiator.result.recvCipher
          const ciphertext = send.encryptWithAd(EMPTY, payload)
          expect(bytesToHex(ciphertext)).toBe(message.ciphertext)
          expect(bytesToHex(recv.decryptWithAd(EMPTY, ciphertext))).toBe(message.payload)
        }
      })

      expect(initiator.isComplete).toBe(true)
      expect(responder.isComplete).toBe(true)
      expect(bytesToHex(initiator.result.handshakeHash)).toBe(expected.handshakeHash)
      expect(bytesToHex(responder.result.handshakeHash)).toBe(expected.handshakeHash)
      expect(bytesToHex(responder.result.remoteStatic)).toBe(bytesToHex(initKeypair.publicKey))
      expect(bytesToHex(initiator.result.remoteStatic)).toBe(bytesToHex(respKeypair.publicKey))
    })
  }
})

describe('handshake roundtrip (Crypto/1 §6)', () => {
  function newPair(overrides?: { prologue?: Uint8Array; psk?: Uint8Array; respPsk?: Uint8Array }) {
    const prologue = overrides?.prologue ?? remoraPrologue('session')
    const psk = overrides?.psk ?? TEST_PSK
    const hostStatic = generateKeypair()
    const deviceStatic = generateKeypair()
    const initiator = createInitiatorHandshake({
      staticKey: deviceStatic.privateKey,
      remoteStaticKey: hostStatic.publicKey,
      psk,
      prologue,
    })
    const responder = createResponderHandshake({
      staticKey: hostStatic.privateKey,
      psk: overrides?.respPsk ?? psk,
      prologue,
    })
    return { initiator, responder, hostStatic, deviceStatic }
  }

  function completeHandshake(pair: ReturnType<typeof newPair>) {
    const msg1Payload = utf8('{"v":1,"purpose":"session"}')
    const msg2Payload = utf8('{"v":1,"time":0}')
    const msg1 = pair.initiator.writeMessage(msg1Payload)
    const plain1 = pair.responder.readMessage(msg1)
    const msg2 = pair.responder.writeMessage(msg2Payload)
    const plain2 = pair.initiator.readMessage(msg2)
    return { msg1, msg2, plain1, plain2, msg1Payload, msg2Payload }
  }

  it('completes with random keys, matching hashes, and mutual static authentication', () => {
    const pair = newPair()
    const { msg1, msg2, plain1, plain2, msg1Payload, msg2Payload } = completeHandshake(pair)
    expect(plain1).toEqual(msg1Payload)
    expect(plain2).toEqual(msg2Payload)
    expect(pair.initiator.isComplete).toBe(true)
    expect(pair.responder.isComplete).toBe(true)
    expect(pair.initiator.result.handshakeHash).toEqual(pair.responder.result.handshakeHash)
    expect(pair.responder.result.remoteStatic).toEqual(pair.deviceStatic.publicKey)
    expect(pair.initiator.result.remoteStatic).toEqual(pair.hostStatic.publicKey)
    // msg1 = e(32) + encrypted s(48) + encrypted payload(16 + n); msg2 = e(32) + payload(16 + n).
    expect(msg1.length).toBe(80 + 16 + msg1Payload.length)
    expect(msg2.length).toBe(48 + msg2Payload.length)
  })

  it('exposes the initiator static key to the responder after message 1 (session admission)', () => {
    const pair = newPair()
    expect(pair.responder.remoteStatic).toBeUndefined()
    const msg1 = pair.initiator.writeMessage(utf8('hello'))
    pair.responder.readMessage(msg1)
    expect(pair.responder.remoteStatic).toEqual(pair.deviceStatic.publicKey)
    expect(pair.responder.isComplete).toBe(false)
    expect(pair.initiator.remoteStatic).toEqual(pair.hostStatic.publicKey)
  })

  it('handles zero-length handshake payloads (tag-only fields)', () => {
    const pair = newPair()
    const msg1 = pair.initiator.writeMessage(EMPTY)
    expect(pair.responder.readMessage(msg1)).toEqual(EMPTY)
    const msg2 = pair.responder.writeMessage(EMPTY)
    expect(pair.initiator.readMessage(msg2)).toEqual(EMPTY)
    expect(pair.initiator.result.handshakeHash).toEqual(pair.responder.result.handshakeHash)
    expect(msg1.length).toBe(96)
    expect(msg2.length).toBe(48)
  })

  it('encrypts and decrypts bidirectionally in the transport phase', () => {
    const pair = newPair()
    completeHandshake(pair)
    const iSend = pair.initiator.result.sendCipher
    const iRecv = pair.initiator.result.recvCipher
    const rSend = pair.responder.result.sendCipher
    const rRecv = pair.responder.result.recvCipher
    // Each side split() into its own pair; keys mirror across the channel.
    for (let i = 0; i < 1000; i += 1) {
      const up = utf8(`K2T:${i}`)
      const down = utf8(`T2K:${i}`)
      expect(rRecv.decryptWithAd(EMPTY, iSend.encryptWithAd(EMPTY, up))).toEqual(up)
      expect(iRecv.decryptWithAd(EMPTY, rSend.encryptWithAd(EMPTY, down))).toEqual(down)
    }
    expect(iSend.nonce).toBe(1000n)
    expect(rSend.nonce).toBe(1000n)
  })

  it('supports an empty transport payload (tag-only frame)', () => {
    const pair = newPair()
    completeHandshake(pair)
    const ciphertext = pair.initiator.result.sendCipher.encryptWithAd(EMPTY, EMPTY)
    expect(ciphertext).toHaveLength(TAGLEN)
    expect(pair.responder.result.recvCipher.decryptWithAd(EMPTY, ciphertext)).toEqual(EMPTY)
  })

  it('supports a transport payload up to MAX_TRANSPORT_PAYLOAD', () => {
    expect(MAX_TRANSPORT_PAYLOAD).toBe(65519)
    const pair = newPair()
    completeHandshake(pair)
    const big = new Uint8Array(MAX_TRANSPORT_PAYLOAD).fill(0x7a)
    const ciphertext = pair.initiator.result.sendCipher.encryptWithAd(EMPTY, big)
    expect(ciphertext).toHaveLength(MAX_NOISE_MESSAGE)
    expect(pair.responder.result.recvCipher.decryptWithAd(EMPTY, ciphertext)).toEqual(big)
  })

  it('fails closed on a tampered transport frame without consuming the nonce', () => {
    const pair = newPair()
    completeHandshake(pair)
    const send = pair.initiator.result.sendCipher
    const recv = pair.responder.result.recvCipher
    const ciphertext = send.encryptWithAd(EMPTY, utf8('frame-0'))
    const tampered = ciphertext.slice()
    tampered[3] = (tampered[3] as number) ^ 0x01
    expect(() => recv.decryptWithAd(EMPTY, tampered)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
    expect(recv.nonce).toBe(0n)
    expect(recv.decryptWithAd(EMPTY, ciphertext)).toEqual(utf8('frame-0'))
  })

  it('fails when the PSKs differ', () => {
    const wrongPsk = new Uint8Array(32).fill(0xaa)
    const pair = newPair({ respPsk: wrongPsk })
    const msg1 = pair.initiator.writeMessage(utf8('hello'))
    pair.responder.readMessage(msg1)
    const msg2 = pair.responder.writeMessage(utf8('world'))
    expect(() => pair.initiator.readMessage(msg2)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
  })

  it('fails when the prologues differ', () => {
    const hostStatic = generateKeypair()
    const initiator = createInitiatorHandshake({
      staticKey: generateKeypair().privateKey,
      remoteStaticKey: hostStatic.publicKey,
      psk: TEST_PSK,
      prologue: remoraPrologue('pair'),
    })
    const responder = createResponderHandshake({
      staticKey: hostStatic.privateKey,
      psk: TEST_PSK,
      prologue: remoraPrologue('session'),
    })
    const msg1 = initiator.writeMessage(utf8('hello'))
    expect(() => responder.readMessage(msg1)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
  })

  it('rejects a low-order pinned responder key', () => {
    const initiator = createInitiatorHandshake({
      staticKey: generateKeypair().privateKey,
      remoteStaticKey: new Uint8Array(32),
      psk: TEST_PSK,
      prologue: remoraPrologue('session'),
    })
    expect(() => initiator.writeMessage(utf8('hello'))).toThrow(
      expect.objectContaining({ code: 'invalid_public_key' }),
    )
  })

  it('rejects out-of-turn and post-completion calls', () => {
    const pair = newPair()
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
    expect(() => pair.initiator.writeMessage(EMPTY)).toThrow(
      expect.objectContaining({ code: 'handshake_exhausted' }),
    )
    expect(() => pair.responder.readMessage(msg1)).toThrow(
      expect.objectContaining({ code: 'handshake_exhausted' }),
    )
    expect(() => pair.initiator.result.sendCipher.encryptWithAd(EMPTY, EMPTY)).not.toThrow()
  })

  it('rejects truncated handshake messages', () => {
    const pair = newPair()
    const msg1 = pair.initiator.writeMessage(utf8('payload'))
    expect(() => pair.responder.readMessage(msg1.subarray(0, 60))).toThrow(
      expect.objectContaining({ code: 'invalid_message' }),
    )
  })

  it('rejects tampered handshake messages', () => {
    const pair = newPair()
    const msg1 = pair.initiator.writeMessage(utf8('payload'))
    const other = newPair()
    const tampered = msg1.slice()
    tampered[40] = (tampered[40] as number) ^ 0x01
    expect(() => other.responder.readMessage(tampered)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
  })

  it('rejects handshake messages over the 65535-byte ceiling', () => {
    const pair = newPair()
    expect(() => pair.initiator.writeMessage(new Uint8Array(65440))).toThrow(
      expect.objectContaining({ code: 'message_too_large' }),
    )
  })

  it('requires a 32-byte PSK and an IK initiator static pin', () => {
    const hostStatic = generateKeypair()
    expect(() =>
      createInitiatorHandshake({
        staticKey: generateKeypair().privateKey,
        remoteStaticKey: hostStatic.publicKey,
        psk: new Uint8Array(16),
        prologue: EMPTY,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_key_length' }))
    // Missing remoteStaticKey is a type error at the factory; the runtime guard lives in HandshakeState.
    expect(
      () =>
        new HandshakeState({
          initiator: true,
          staticKey: generateKeypair().privateKey,
          psk: TEST_PSK,
          prologue: EMPTY,
        }),
    ).toThrow(expect.objectContaining({ code: 'missing_key' }))
  })

  it('rejects accessing the result before the handshake completes', () => {
    const pair = newPair()
    expect(() => pair.initiator.result).toThrow(expect.objectContaining({ code: 'handshake_incomplete' }))
  })

  it('zeroizes the injected ephemeral secret after Split() without touching borrowed keys', () => {
    const ephemeralSecret = new Uint8Array(32).fill(0xe7)
    const borrowedStatic = new Uint8Array(32).fill(0x5c)
    const hostStatic = generateKeypair()
    const initiator = createInitiatorHandshake({
      staticKey: borrowedStatic,
      remoteStaticKey: hostStatic.publicKey,
      psk: TEST_PSK,
      prologue: remoraPrologue('session'),
      ephemeralSecret,
    })
    const responder = createResponderHandshake({
      staticKey: hostStatic.privateKey,
      psk: TEST_PSK,
      prologue: remoraPrologue('session'),
    })
    const msg1 = initiator.writeMessage(utf8('x'))
    responder.readMessage(msg1)
    const msg2 = responder.writeMessage(utf8('y'))
    initiator.readMessage(msg2)
    expect(ephemeralSecret.every((byte) => byte === 0)).toBe(true)
    expect(borrowedStatic.every((byte) => byte === 0x5c)).toBe(true)
    // The PSK is borrowed from the caller and must not be zeroized by the handshake.
    expect(TEST_PSK).toEqual(
      hexToBytes('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'),
    )
    expect(initiator.result.handshakeHash).toEqual(responder.result.handshakeHash)
  })
})

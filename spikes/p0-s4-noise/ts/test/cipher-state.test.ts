/**
 * CipherState-level anchors: Noise §12.3 nonce layout, AEAD behavior around
 * failures and exhaustion, and the empty-key passthrough rule of §5.1.
 */
import { describe, expect, it } from 'vitest'
import {
  CipherState,
  MAX_NOISE_MESSAGE,
  MAX_TRANSPORT_PAYLOAD,
  NoiseError,
  TAGLEN,
  decrypt,
  encrypt,
  noiseNonce,
  utf8,
} from '../src/index.ts'

const EMPTY = new Uint8Array(0)
const KEY = new Uint8Array(32).fill(0x42)
const AD = utf8('remora/1')

describe('Noise §12.3 ChaChaPoly nonce layout', () => {
  it('encodes 32 zero bits followed by little-endian n', () => {
    expect(noiseNonce(0n)).toEqual(new Uint8Array(12))
    expect(noiseNonce(1n)).toEqual(Uint8Array.from([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]))
    expect(noiseNonce(0x0102030405060708n)).toEqual(
      Uint8Array.from([0, 0, 0, 0, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]),
    )
  })

  it('rejects out-of-range counters', () => {
    expect(() => noiseNonce((1n << 64n))).toThrow(NoiseError)
    expect(() => noiseNonce(-1n)).toThrow(NoiseError)
  })

  it('produces different ciphertexts for consecutive nonces', () => {
    const pt = utf8('payload')
    expect(encrypt(KEY, 0n, AD, pt)).not.toEqual(encrypt(KEY, 1n, AD, pt))
    expect(decrypt(KEY, 1n, AD, encrypt(KEY, 1n, AD, pt))).toEqual(pt)
  })
})

describe('CipherState §5.1', () => {
  it('passes plaintext/ciphertext through when k is empty', () => {
    const cs = new CipherState()
    expect(cs.hasKey()).toBe(false)
    expect(cs.encryptWithAd(AD, utf8('clear'))).toEqual(utf8('clear'))
    expect(cs.decryptWithAd(AD, utf8('clear'))).toEqual(utf8('clear'))
    expect(cs.nonce).toBe(0n)
  })

  it('fails closed on tag mismatch and does not advance n', () => {
    const tx = new CipherState()
    tx.initializeKey(KEY)
    const first = tx.encryptWithAd(AD, utf8('frame-0')) // tx n: 0 → 1
    const second = tx.encryptWithAd(AD, utf8('frame-1')) // tx n: 1 → 2

    const rx = new CipherState()
    rx.initializeKey(KEY)
    const tampered = first.slice()
    tampered[0] = (tampered[0] as number) ^ 0x01
    expect(() => rx.decryptWithAd(AD, tampered)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
    expect(rx.nonce).toBe(0n) // failed decrypt must not consume the nonce
    expect(rx.decryptWithAd(AD, first)).toEqual(utf8('frame-0'))
    expect(rx.nonce).toBe(1n)
    expect(rx.decryptWithAd(AD, second)).toEqual(utf8('frame-1'))
    // Replay of an already-consumed frame fails and still does not advance n.
    expect(() => rx.decryptWithAd(AD, first)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
    expect(rx.nonce).toBe(2n)
  })

  it('fails on wrong associated data', () => {
    const cs = new CipherState()
    cs.initializeKey(KEY)
    const ciphertext = cs.encryptWithAd(AD, utf8('frame'))
    const probe = new CipherState()
    probe.initializeKey(KEY)
    expect(() => probe.decryptWithAd(utf8('other'), ciphertext)).toThrow(
      expect.objectContaining({ code: 'aead_verification_failed' }),
    )
  })

  it('signals nonce_exhausted at 2^64-1 (the reserved value)', () => {
    const cs = new CipherState()
    cs.initializeKey(KEY)
    cs.setNonce((1n << 64n) - 2n)
    cs.encryptWithAd(EMPTY, utf8('last'))
    expect(() => cs.encryptWithAd(EMPTY, utf8('nope'))).toThrow(
      expect.objectContaining({ code: 'nonce_exhausted' }),
    )
    expect(() => cs.decryptWithAd(EMPTY, new Uint8Array(TAGLEN))).toThrow(
      expect.objectContaining({ code: 'nonce_exhausted' }),
    )
  })

  it('zeroizes the key', () => {
    const cs = new CipherState()
    cs.initializeKey(KEY)
    cs.zeroize()
    expect(cs.hasKey()).toBe(false)
    expect(KEY.every((byte) => byte === 0x42)).toBe(true)
  })
})

describe('message size ceilings', () => {
  it('pins the Noise §3 constants', () => {
    expect(MAX_NOISE_MESSAGE).toBe(65535)
    expect(MAX_TRANSPORT_PAYLOAD).toBe(65519)
  })
})

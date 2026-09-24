import { p256 } from '@noble/curves/nist.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import {
  buildCanonicalApprovalMessage,
  buildPairingQr,
  computeArgsDigest,
  decodeBase32,
  decodeBase64Url,
  deriveEndpointId,
  derivePairPsk,
  deriveSasCode,
  encodeBase32,
  encodeBase64Url,
  openPushPayload,
  parsePairingQr,
  randomBytes,
  sealPushPayload,
  signRelayChallenge,
  verifyApprovalSignature,
  verifyRelayChallenge,
  type ApprovalOutcome,
  type PairingData,
} from '../src/index.ts'

const RELAY_PUB = Uint8Array.from({ length: 32 }, (_, i) => i)
const HOST_ID = 'h_erruijsx3ey2rmxcpeh3pgxjkm'
const PAIRING_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i)
const HOST_NOISE_PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const DEVICE_NOISE_PUB = Uint8Array.from({ length: 32 }, (_, i) => 100 + i)
const TICKET = Uint8Array.from({ length: 32 }, (_, i) => 0xf0 + (i % 16))

/** Wraps a SEC1 point into a P-256 SubjectPublicKeyInfo DER (test fixture helper). */
function pointToSpki(point: Uint8Array): Uint8Array {
  const algId = Uint8Array.of(
    0x30,
    0x13,
    0x06,
    0x07,
    0x2a,
    0x86,
    0x48,
    0xce,
    0x3d,
    0x02,
    0x01,
    0x06,
    0x08,
    0x2a,
    0x86,
    0x48,
    0xce,
    0x3d,
    0x03,
    0x01,
    0x07,
  )
  const bitString = new Uint8Array(3 + point.length)
  bitString[0] = 0x03
  bitString[1] = 1 + point.length
  bitString[2] = 0x00
  bitString.set(point, 3)
  const spki = new Uint8Array(2 + algId.length + bitString.length)
  spki[0] = 0x30
  spki[1] = algId.length + bitString.length
  spki.set(algId, 2)
  spki.set(bitString, 2 + algId.length)
  return spki
}

describe('b64u (unpadded base64url)', () => {
  it('roundtrips without padding', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const encoded = encodeBase64Url(bytes)
    expect(encoded).not.toContain('=')
    expect(decodeBase64Url(encoded)).toEqual(bytes)
    expect(encodeBase64Url(Uint8Array.from([255, 254]))).toBe('__4')
    expect(encodeBase64Url(new TextEncoder().encode('foobar'))).toBe('Zm9vYmFy')
    expect(decodeBase64Url('')).toEqual(new Uint8Array(0))
  })

  it('rejects "=" padding anywhere (fail closed)', () => {
    expect(() => decodeBase64Url('AAAA=')).toThrow(/padding/)
    expect(() => decodeBase64Url('=AAA')).toThrow(/padding/)
    expect(() => decodeBase64Url('AA==')).toThrow(/padding/)
  })

  it('rejects non-alphabet characters, impossible lengths, and dirty trailing bits', () => {
    expect(() => decodeBase64Url('AA*A')).toThrow(/alphabet/)
    expect(() => decodeBase64Url('A')).toThrow(/length/)
    expect(() => decodeBase64Url('AB')).toThrow(/trailing/)
  })
})

describe('base32 (lowercase, unpadded RFC 4648)', () => {
  it('matches the RFC 4648 test vectors in lowercase', () => {
    const enc = new TextEncoder()
    expect(encodeBase32(enc.encode(''))).toBe('')
    expect(encodeBase32(enc.encode('f'))).toBe('my')
    expect(encodeBase32(enc.encode('fo'))).toBe('mzxq')
    expect(encodeBase32(enc.encode('foo'))).toBe('mzxw6')
    expect(encodeBase32(enc.encode('foob'))).toBe('mzxw6yq')
    expect(encodeBase32(enc.encode('fooba'))).toBe('mzxw6ytb')
    expect(encodeBase32(enc.encode('foobar'))).toBe('mzxw6ytboi')
  })

  it('roundtrips and fails closed on bad input', () => {
    const bytes = Uint8Array.from({ length: 40 }, (_, i) => (i * 37) % 256)
    expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes)
    expect(() => decodeBase32('mzxw6yq=')).toThrow(/padding/)
    expect(() => decodeBase32('a')).toThrow(/length/)
    expect(() => decodeBase32('ab')).toThrow(/trailing/)
    expect(() => decodeBase32('mzxw6yt*')).toThrow(/alphabet/)
  })
})

describe('randomBytes', () => {
  it('produces the requested length of fresh bytes', () => {
    expect(randomBytes(0)).toEqual(new Uint8Array(0))
    const a = randomBytes(32)
    const b = randomBytes(32)
    expect(a.length).toBe(32)
    expect(a).not.toEqual(b)
    expect(randomBytes(65_636).length).toBe(65_636)
  })

  it('rejects invalid lengths', () => {
    expect(() => randomBytes(-1)).toThrow()
    expect(() => randomBytes(1.5)).toThrow()
    expect(() => randomBytes(Number.NaN)).toThrow()
  })
})

describe('endpoint ids (Crypto/1 §2)', () => {
  it('derives the independent reference ids', () => {
    expect(deriveEndpointId('h_', RELAY_PUB)).toBe(HOST_ID)
    expect(deriveEndpointId('d_', RELAY_PUB)).toBe(`d_${HOST_ID.slice(2)}`)
    expect(deriveEndpointId('h_', RELAY_PUB)).toMatch(/^h_[a-z2-7]{26}$/)
  })

  it('is key- and prefix-sensitive and rejects malformed keys', () => {
    const other = Uint8Array.from(RELAY_PUB)
    other[0] = 1
    expect(deriveEndpointId('h_', other)).not.toBe(HOST_ID)
    expect(() => deriveEndpointId('h_', new Uint8Array(31))).toThrow(/32 bytes/)
    expect(() => deriveEndpointId('x_' as unknown as 'h_', RELAY_PUB)).toThrow(/prefix/)
  })
})

describe('relay auth (Crypto/1 §4)', () => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)
  const publicKey = ed25519.getPublicKey(seed)
  const challengeToken = `https://relay.example.test\x00host\x00${HOST_ID}\x00${bytesToHex(randomBytes(16))}`

  it('signs and verifies a challenge', () => {
    const signature = signRelayChallenge(seed, challengeToken)
    expect(signature.length).toBe(64)
    expect(verifyRelayChallenge(publicKey, challengeToken, signature)).toBe(true)
  })

  it('fails closed on tampering and malformed inputs', () => {
    const signature = signRelayChallenge(seed, challengeToken)
    expect(verifyRelayChallenge(publicKey, `${challengeToken}x`, signature)).toBe(false)
    const otherKey = ed25519.getPublicKey(Uint8Array.from(seed).fill(9))
    expect(verifyRelayChallenge(otherKey, challengeToken, signature)).toBe(false)
    const flipped = Uint8Array.from(signature)
    flipped[0] = (flipped[0] ?? 0) ^ 1
    expect(verifyRelayChallenge(publicKey, challengeToken, flipped)).toBe(false)
    expect(verifyRelayChallenge(publicKey, challengeToken, new Uint8Array(63))).toBe(false)
    expect(verifyRelayChallenge(new Uint8Array(31), challengeToken, signature)).toBe(false)
    expect(() => signRelayChallenge(new Uint8Array(31), challengeToken)).toThrow(/32-byte/)
  })
})

describe('pairing (Crypto/1 §5)', () => {
  const fixture: PairingData = {
    relayOrigin: 'https://relay.example.test',
    hostId: HOST_ID,
    hostNoisePub: HOST_NOISE_PUB,
    ticket: TICKET,
    pairingSecret: PAIRING_SECRET,
    hostName: 'DESKTOP-OLSI',
    expiry: 2_000_000_000,
  }

  it('builds and parses a QR roundtrip', () => {
    const qr = buildPairingQr(fixture)
    expect(qr.startsWith('remora://pair?v=1&')).toBe(true)
    expect(parsePairingQr(qr)).toEqual(fixture)
  })

  it('rejects unsupported versions and malformed payloads (fail closed)', () => {
    const qr = buildPairingQr(fixture)
    expect(() => parsePairingQr(qr.replace('pair?v=1&', 'pair?v=2&'))).toThrow(/version/)
    expect(() => parsePairingQr(`${qr}&evil=1`)).toThrow(/unknown/)
    expect(() => parsePairingQr(`${qr}&v=1`)).toThrow(/duplicate/)
    expect(() => parsePairingQr(qr.replace(/&x=\d+$/, ''))).toThrow(/missing/)
    expect(() => parsePairingQr(`${qr}#frag`)).toThrow(/fragment/)
    expect(() => parsePairingQr(qr.replace(/&s=[^&]+/, '&s=AAAA='))).toThrow(/padding/)
    expect(() => parsePairingQr(qr.replace(/&n=[^&]+/, '&n=%zz'))).toThrow(/percent/)
    expect(() => parsePairingQr(qr.replace(/&x=\d+/, '&x=soon'))).toThrow(/expiry/)
    expect(() => parsePairingQr('https://pair.example')).toThrow(/remora/)
  })

  it('enforces host name and relay origin policy on build', () => {
    expect(() => buildPairingQr({ ...fixture, relayOrigin: 'http://evil.example' })).toThrow(/https/)
    expect(() => buildPairingQr({ ...fixture, relayOrigin: 'https://relay.example.test/path' })).toThrow(
      /path/,
    )
    expect(() => buildPairingQr({ ...fixture, hostName: '' })).toThrow(/host name/)
    expect(() => buildPairingQr({ ...fixture, hostName: 'x'.repeat(41) })).toThrow(/host name/)
    expect(() => buildPairingQr({ ...fixture, expiry: 0 })).toThrow(/expiry/)
    expect(() => buildPairingQr({ ...fixture, ticket: new Uint8Array(31) })).toThrow(/32 bytes/)
    expect(buildPairingQr({ ...fixture, relayOrigin: 'http://127.0.0.1:8787' })).toContain(
      'http%3A%2F%2F127.0.0.1%3A8787',
    )
  })

  it('derives pairPsk to the independent HKDF reference', () => {
    const psk = derivePairPsk(PAIRING_SECRET, 'tkt_0192abc')
    expect(psk.length).toBe(32)
    expect(bytesToHex(psk)).toBe('8a8e00280ec19fd3cd1d0f910c39d7243e6effa9523503f84c1c674c662a030d')
    expect(derivePairPsk(PAIRING_SECRET, 'other')).not.toEqual(psk)
    expect(() => derivePairPsk(new Uint8Array(31), 'tkt')).toThrow(/32 bytes/)
  })

  it('derives the six-digit SAS to the independent HMAC reference', () => {
    const psk = derivePairPsk(PAIRING_SECRET, 'tkt_0192abc')
    expect(deriveSasCode(HOST_NOISE_PUB, DEVICE_NOISE_PUB, psk)).toBe('944711')
    expect(deriveSasCode(HOST_NOISE_PUB, DEVICE_NOISE_PUB, psk)).toMatch(/^\d{6}$/)
    expect(deriveSasCode(DEVICE_NOISE_PUB, HOST_NOISE_PUB, psk)).toMatch(/^\d{6}$/)
    expect(() => deriveSasCode(new Uint8Array(31), DEVICE_NOISE_PUB, psk)).toThrow(/32 bytes/)
  })
})

describe('approval signatures (Crypto/1 §7)', () => {
  it('builds the canonical message with the frozen header and field lines', () => {
    const argsDigest = `sha256:${'a'.repeat(64)}`
    const message = buildCanonicalApprovalMessage({
      approvalId: 'appr_01923456789a',
      outcome: 'allowed-once',
      issuedAt: 1_790_000_000_000,
      argsDigest,
    })
    expect(message.split('\n')).toEqual([
      'remora/1 approval',
      'appr_01923456789a',
      argsDigest,
      'allowed-once',
      '1790000000000',
    ])
    expect(message.endsWith('\n')).toBe(false)
  })

  it('rejects malformed canonical fields', () => {
    const base = {
      approvalId: 'a',
      outcome: 'allowed-once' as const,
      issuedAt: 1,
      argsDigest: `sha256:${'a'.repeat(64)}`,
    }
    expect(() => buildCanonicalApprovalMessage({ ...base, approvalId: '' })).toThrow(/approvalId/)
    expect(() => buildCanonicalApprovalMessage({ ...base, approvalId: 'a\nb' })).toThrow(/approvalId/)
    expect(() => buildCanonicalApprovalMessage({ ...base, approvalId: 'a\rb' })).toThrow(/approvalId/)
    expect(() => buildCanonicalApprovalMessage({ ...base, issuedAt: -1 })).toThrow(/issuedAt/)
    expect(() => buildCanonicalApprovalMessage({ ...base, issuedAt: 1.5 })).toThrow(/issuedAt/)
    expect(() => buildCanonicalApprovalMessage({ ...base, argsDigest: 'deadbeef' })).toThrow(/argsDigest/)
    expect(() =>
      buildCanonicalApprovalMessage({ ...base, outcome: 'bogus' as unknown as ApprovalOutcome }),
    ).toThrow(/outcome/)
  })

  it('computes a canonical, key-order-independent args digest', () => {
    const digest = computeArgsDigest({ text: 'bash: pnpm test', json: '{"cmd":"pnpm test"}' })
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(computeArgsDigest({ json: '{"cmd":"pnpm test"}', text: 'bash: pnpm test' })).toBe(digest)
    expect(computeArgsDigest({ text: 'other', json: '{}' })).not.toBe(digest)
    expect(() => computeArgsDigest({ n: Number.POSITIVE_INFINITY })).toThrow(/finite/)
    expect(() => computeArgsDigest(1n)).toThrow(/unsupported/)
  })

  it('verifies P-256 DER signatures and accepts high-S variants', () => {
    const { secretKey, publicKey } = p256.keygen()
    const message = new TextEncoder().encode(
      buildCanonicalApprovalMessage({
        approvalId: 'appr_01923456789a',
        outcome: 'allowed-once',
        issuedAt: 1_790_000_000_000,
        argsDigest: computeArgsDigest({ text: 'bash: pnpm test', json: '{"cmd":"pnpm test"}' }),
      }),
    )
    const spki = pointToSpki(publicKey)
    const signature = p256.sign(message, secretKey, { prehash: true, lowS: true, format: 'der' })
    expect(verifyApprovalSignature(spki, signature, message)).toBe(true)

    const parsed = p256.Signature.fromBytes(signature, 'der')
    const order = p256.Point.CURVE().n
    const highSSignature = new p256.Signature(parsed.r, order - parsed.s).toBytes('der')
    expect(p256.Signature.fromBytes(highSSignature, 'der').hasHighS()).toBe(true)
    expect(p256.verify(highSSignature, message, publicKey, { prehash: true, lowS: true, format: 'der' })).toBe(
      false,
    )
    expect(verifyApprovalSignature(spki, highSSignature, message)).toBe(true)

    const tampered = Uint8Array.from(message)
    tampered[0] = (tampered[0] ?? 0) ^ 1
    expect(verifyApprovalSignature(spki, signature, tampered)).toBe(false)
    expect(verifyApprovalSignature(spki, new Uint8Array(70), message)).toBe(false)
    expect(verifyApprovalSignature(new Uint8Array(0), signature, message)).toBe(false)
    expect(verifyApprovalSignature(Uint8Array.of(0x30, 0x00), signature, message)).toBe(false)
    expect(verifyApprovalSignature(pointToSpki(p256.keygen().publicKey), signature, message)).toBe(false)
  })
})

describe('push payloads (Crypto/1 §8)', () => {
  it('seals and opens a payload with a random nonce prefix', () => {
    const key = randomBytes(32)
    const payload = {
      v: 1,
      kind: 'approval',
      at: 1_790_000_000_000,
      title: 'Approval needed · ds',
      body: 'bash: pnpm test',
    }
    const sealed = sealPushPayload(key, payload)
    expect(sealed.length).toBeGreaterThan(12 + 16)
    expect(openPushPayload(key, sealed)).toEqual(payload)

    const again = sealPushPayload(key, payload)
    expect(again.slice(0, 12)).not.toEqual(sealed.slice(0, 12))
    expect(openPushPayload(key, again)).toEqual(payload)
  })

  it('fails closed on tampering, wrong keys, short input, and oversize payloads', () => {
    const key = randomBytes(32)
    const sealed = sealPushPayload(key, { v: 1, kind: 'question' })
    const flipped = Uint8Array.from(sealed)
    flipped[20] = (flipped[20] ?? 0) ^ 1
    expect(() => openPushPayload(key, flipped)).toThrow()
    expect(() => openPushPayload(randomBytes(32), sealed)).toThrow()
    expect(() => openPushPayload(key, new Uint8Array(27))).toThrow(/too short/)
    expect(() => sealPushPayload(new Uint8Array(16), { v: 1 })).toThrow(/32 bytes/)
    expect(() => sealPushPayload(key, { blob: 'x'.repeat(3_000) })).toThrow(/2048/)
    expect(() => sealPushPayload(key, undefined)).toThrow(/serializable/)
  })
})

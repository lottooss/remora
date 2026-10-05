import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { assertEndpointId, assertUnicode } from './context.ts'

/** Wire outcome of a signed approval answer (RCP/1 §7). */
export type ApprovalOutcome = 'allowed-once' | 'rejected'

/** Fields bound into the canonical approval message. */
export interface ApprovalMessageFields {
  hostId: string
  deviceId: string
  approvalId: string
  sessionId: string
  callId?: string | undefined
  toolName: string
  outcome: ApprovalOutcome
  /** Decimal milliseconds since the Unix epoch. */
  issuedAt: number
  /** Bare lowercase SHA-256 hex from {@link computeArgsDigest}. */
  argsDigest: string
}

const OUTCOMES: ReadonlySet<string> = new Set(['allowed-once', 'rejected'])
const ARGS_DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** P-256 verify options from Crypto/1 §7: hash with SHA-256, accept high-S, DER. */
const APPROVAL_VERIFY_OPTS = { prehash: true, lowS: false, format: 'der' } as const

const SPKI_EC_PUBLIC_KEY_OID = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01)
const SPKI_PRIME256V1_OID = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07)

/**
 * Builds the canonical approval message: UTF-8 lines joined by `\n` with no
 * trailing newline, headed by the frozen `remora/1 approval` domain
 * (Crypto/1 §7). Identity and pending context come from the authenticated channel.
 */
export function buildCanonicalApprovalMessage(fields: ApprovalMessageFields): string {
  const { hostId, deviceId, approvalId, sessionId, callId, toolName, outcome, issuedAt, argsDigest } = fields
  assertEndpointId(hostId, 'host')
  assertEndpointId(deviceId, 'device')
  for (const [name, value] of Object.entries({ approvalId, sessionId, toolName, ...(callId === undefined ? {} : { callId }) })) {
    if (value.length === 0 || value.length > 1024 || /[\r\n\x00]/.test(value)) {
      throw new Error(`approval: malformed ${name}`)
    }
    assertUnicode(value)
  }
  if (approvalId.length > 128 || callId === '-') throw new Error('approval: malformed approvalId or callId')
  if (!OUTCOMES.has(outcome)) throw new Error('approval: outcome must be allowed-once or rejected')
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    throw new Error('approval: issuedAt must be non-negative integer milliseconds')
  }
  if (!ARGS_DIGEST_PATTERN.test(argsDigest)) throw new Error('approval: malformed argsDigest')
  return ['remora/1 approval', hostId, deviceId, approvalId, sessionId, callId ?? '-', toolName, argsDigest, outcome, String(issuedAt)].join('\n')
}

/**
 * RFC 8785 JSON Canonicalization Scheme subset (Crypto/1 changelog): keys
 * sorted lexicographically by UTF-16 code unit, compact separators,
 * ECMAScript string and number serialization. Rejects non-JSON values.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: numbers must be finite')
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
      }
      const record = value as Record<string, unknown>
      const members: string[] = []
      for (const key of Object.keys(record).sort()) {
        const member = record[key]
        if (member === undefined) continue
        members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`)
      }
      return `{${members.join(',')}}`
    }
    default:
      throw new Error(`canonicalJson: unsupported value type ${typeof value}`)
  }
}

/**
 * `argsDigest = hex_lower(SHA-256(UTF-8(text) || 0x00 || UTF-8(json)))`
 * — binds what the phone displayed to the signature (Crypto/1 §7).
 */
export function computeArgsDigest(preview: { text: string; json: string }): string {
  assertUnicode(preview.text)
  assertUnicode(preview.json)
  return bytesToHex(sha256(concatBytes(utf8ToBytes(preview.text), Uint8Array.of(0), utf8ToBytes(preview.json))))
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

function readTlv(buf: Uint8Array, offset: number, tag: number, what: string): { value: Uint8Array; end: number } {
  if (offset >= buf.length) throw new Error(`spki: truncated ${what}`)
  if (buf[offset] !== tag) throw new Error(`spki: expected tag 0x${tag.toString(16)} for ${what}`)
  let pos = offset + 1
  if (pos >= buf.length) throw new Error(`spki: missing length for ${what}`)
  let len = buf[pos] ?? 0
  pos += 1
  if ((len & 0x80) !== 0) {
    const count = len & 0x7f
    if (count === 0 || count > 4 || pos + count > buf.length) throw new Error(`spki: bad length for ${what}`)
    len = 0
    for (let i = 0; i < count; i += 1) {
      len = (len << 8) | (buf[pos] ?? 0)
      pos += 1
    }
  }
  const end = pos + len
  if (end > buf.length) throw new Error(`spki: value overruns buffer for ${what}`)
  return { value: buf.subarray(pos, end), end }
}

/** Strictly parses a P-256 SubjectPublicKeyInfo DER into SEC1 point bytes. */
function spkiToSec1Point(spki: Uint8Array): Uint8Array {
  const outer = readTlv(spki, 0, 0x30, 'SubjectPublicKeyInfo')
  if (outer.end !== spki.length) throw new Error('spki: trailing bytes after SubjectPublicKeyInfo')
  const alg = readTlv(outer.value, 0, 0x30, 'AlgorithmIdentifier')
  const oidKey = readTlv(alg.value, 0, 0x06, 'id-ecPublicKey')
  if (!bytesEqual(oidKey.value, SPKI_EC_PUBLIC_KEY_OID)) throw new Error('spki: not id-ecPublicKey')
  const oidCurve = readTlv(alg.value, oidKey.end, 0x06, 'prime256v1')
  if (!bytesEqual(oidCurve.value, SPKI_PRIME256V1_OID)) throw new Error('spki: not prime256v1 (P-256)')
  if (oidCurve.end !== alg.value.length) throw new Error('spki: unexpected AlgorithmIdentifier parameters')
  const bits = readTlv(outer.value, alg.end, 0x03, 'subjectPublicKey BIT STRING')
  if (bits.end !== outer.value.length) throw new Error('spki: trailing bytes after BIT STRING')
  if (bits.value.length < 2 || bits.value[0] !== 0x00) throw new Error('spki: BIT STRING must have 0 unused bits')
  const point = bits.value.subarray(1)
  const uncompressed = point.length === 65 && point[0] === 0x04
  if (!uncompressed) throw new Error('spki: not an uncompressed P-256 SEC1 point')
  return point
}

/** Validates the mandatory uncompressed P-256 SPKI approval key at pairing. */
export function isValidApprovalPublicKey(publicKeySpkiDer: Uint8Array): boolean {
  try {
    p256.Point.fromBytes(spkiToSec1Point(publicKeySpkiDer)).assertValidity()
    return true
  } catch { return false }
}

/**
 * Verifies an approval signature: ECDSA P-256 with SHA-256 over `message`,
 * DER-encoded, high-S accepted (Android Keystore does not normalize `s`) —
 * `{ prehash: true, lowS: false, format: 'der' }` per Crypto/1 §7. Any
 * malformed key, signature, or message fails closed to `false`.
 */
export function verifyApprovalSignature(
  publicKeySpkiDer: Uint8Array,
  signatureDer: Uint8Array,
  message: Uint8Array,
): boolean {
  if (publicKeySpkiDer.length === 0 || signatureDer.length === 0) return false
  try {
    return p256.verify(signatureDer, message, spkiToSec1Point(publicKeySpkiDer), APPROVAL_VERIFY_OPTS)
  } catch {
    return false
  }
}

/**
 * Generates an EC P-256 keypair formatted with SubjectPublicKeyInfo DER
 * for device approval keys (Crypto/1 §7).
 */
export function generateApprovalKeypair(): {
  privateKey: Uint8Array
  publicKeySpkiDer: Uint8Array
} {
  const privateKey = p256.utils.randomSecretKey()
  const pubPoint = p256.getPublicKey(privateKey, false)
  const spkiPrefix = new Uint8Array([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
    0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ])
  const publicKeySpkiDer = new Uint8Array(spkiPrefix.length + pubPoint.length)
  publicKeySpkiDer.set(spkiPrefix, 0)
  publicKeySpkiDer.set(pubPoint, spkiPrefix.length)
  return { privateKey, publicKeySpkiDer }
}

/**
 * Signs an approval message with P-256 ECDSA in DER format (Crypto/1 §7).
 */
export function signApprovalMessage(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return p256.sign(message, privateKey, { lowS: false, format: 'der' })
}

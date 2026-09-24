import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { decodeBase64Url, encodeBase64Url } from './b64u.ts'

const QR_PREFIX = 'remora://pair?'
const QR_PARAM_KEYS: ReadonlySet<string> = new Set(['v', 'r', 'h', 'k', 't', 's', 'n', 'x'])

/** Contents of a Remora pairing QR (Crypto/1 §5.1). */
export interface PairingData {
  /** Exact relay origin the host connects to. */
  relayOrigin: string
  /** Host endpoint id (`h_…`). */
  hostId: string
  /** HostNoiseKey public key, 32 bytes. */
  hostNoisePub: Uint8Array
  /** One-time relay enrollment ticket, 32 bytes. */
  ticket: Uint8Array
  /** One-time pairing secret, 32 bytes. */
  pairingSecret: Uint8Array
  /** Display name of the host PC, 1–40 characters. */
  hostName: string
  /** QR expiry as unix seconds; callers MUST reject expired QRs. */
  expiry: number
}

function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function assertRelayOrigin(relayOrigin: string): void {
  let url: URL
  try {
    url = new URL(relayOrigin)
  } catch {
    throw new Error('pairing: relay origin must be an absolute URL')
  }
  if (url.origin !== relayOrigin) throw new Error('pairing: relay origin must contain no path or fragment')
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '10.0.2.2')) return
  throw new Error('pairing: relay origin must be https (http allowed only for 127.0.0.1 / 10.0.2.2)')
}

function assertHostId(hostId: string): void {
  if (hostId.length === 0 || hostId.length > 64 || containsControlCharacter(hostId)) {
    throw new Error('pairing: malformed host id')
  }
}

function assertHostName(hostName: string): void {
  if (hostName.length === 0 || hostName.length > 40 || containsControlCharacter(hostName)) {
    throw new Error('pairing: host name must be 1-40 characters without control characters')
  }
}

function assertPairingBytes(name: string, value: Uint8Array): void {
  if (value.length !== 32) throw new Error(`pairing: ${name} must be 32 bytes`)
}

function assertExpiry(expiry: number): void {
  if (!Number.isSafeInteger(expiry) || expiry <= 0) {
    throw new Error('pairing: expiry must be a positive unix timestamp in seconds')
  }
}

function assertPairingData(data: PairingData): void {
  assertRelayOrigin(data.relayOrigin)
  assertHostId(data.hostId)
  assertHostName(data.hostName)
  assertExpiry(data.expiry)
  assertPairingBytes('hostNoisePub', data.hostNoisePub)
  assertPairingBytes('ticket', data.ticket)
  assertPairingBytes('pairingSecret', data.pairingSecret)
}

/**
 * Builds the pairing QR payload (Crypto/1 §5.1):
 *
 * `remora://pair?v=1&r=…&h=…&k=…&t=…&s=…&n=…&x=…` with every value
 * percent-encoded and binary fields as unpadded base64url.
 */
export function buildPairingQr(data: PairingData): string {
  assertPairingData(data)
  const enc = encodeURIComponent
  return (
    `${QR_PREFIX}v=1` +
    `&r=${enc(data.relayOrigin)}` +
    `&h=${enc(data.hostId)}` +
    `&k=${enc(encodeBase64Url(data.hostNoisePub))}` +
    `&t=${enc(encodeBase64Url(data.ticket))}` +
    `&s=${enc(encodeBase64Url(data.pairingSecret))}` +
    `&n=${enc(data.hostName)}` +
    `&x=${data.expiry}`
  )
}

/**
 * Parses and validates a pairing QR payload. Rejects unknown or duplicate
 * parameters, `v≠1`, non-`https` relay origins (except the loopback addresses
 * named in Crypto/1 §5.1), malformed keys, and out-of-range fields. Expiry is
 * a wall-clock policy: callers MUST also reject QRs whose `x` has passed.
 */
export function parsePairingQr(qr: string): PairingData {
  if (!qr.startsWith(QR_PREFIX)) throw new Error('pairing: QR must start with remora://pair?')
  if (qr.includes('#')) throw new Error('pairing: QR must not contain a fragment')
  const params = new Map<string, string>()
  for (const segment of qr.slice(QR_PREFIX.length).split('&')) {
    if (segment.length === 0) throw new Error('pairing: empty query segment')
    const eq = segment.indexOf('=')
    if (eq <= 0) throw new Error('pairing: malformed query segment')
    const key = segment.slice(0, eq)
    if (params.has(key)) throw new Error('pairing: duplicate query parameter')
    params.set(key, segment.slice(eq + 1))
  }
  for (const key of params.keys()) {
    if (!QR_PARAM_KEYS.has(key)) throw new Error('pairing: unknown query parameter')
  }
  const value = (name: string): string => {
    const raw = params.get(name)
    if (raw === undefined) throw new Error(`pairing: missing query parameter ${name}`)
    try {
      return decodeURIComponent(raw)
    } catch {
      throw new Error('pairing: malformed percent-encoding')
    }
  }
  if (value('v') !== '1') throw new Error('pairing: unsupported QR version')
  const relayOrigin = value('r')
  const hostId = value('h')
  const hostNoisePub = decodeBase64Url(value('k'))
  const ticket = decodeBase64Url(value('t'))
  const pairingSecret = decodeBase64Url(value('s'))
  const hostName = value('n')
  const expiryText = value('x')
  assertRelayOrigin(relayOrigin)
  assertHostId(hostId)
  assertHostName(hostName)
  assertPairingBytes('hostNoisePub', hostNoisePub)
  assertPairingBytes('ticket', ticket)
  assertPairingBytes('pairingSecret', pairingSecret)
  if (!/^\d+$/.test(expiryText)) throw new Error('pairing: expiry must be unix seconds')
  const expiry = Number(expiryText)
  assertExpiry(expiry)
  return { relayOrigin, hostId, hostNoisePub, ticket, pairingSecret, hostName, expiry }
}

/**
 * Derives the pairing PSK with HKDF-SHA256 (Crypto/1 §5.2), L = 32:
 *
 * `HKDF(ikm = pairingSecret, salt = "remora/1", info = "pair-psk" ‖ 0x00 ‖ ticketId)`
 */
export function derivePairPsk(pairingSecret: Uint8Array, ticketId: string): Uint8Array {
  if (pairingSecret.length !== 32) throw new Error('pairing: pairing secret must be 32 bytes')
  const info = utf8ToBytes(`pair-psk\x00${ticketId}`)
  return hkdf(sha256, pairingSecret, utf8ToBytes('remora/1'), info, 32)
}

/**
 * Six-digit short authentication string binding both static Noise public keys
 * under the pairing PSK, shaped like Crypto/1 §5.6:
 *
 * `uint32_be(HMAC-SHA256(key = psk, "remora/1 sas" ‖ 0x00 ‖ hostPub ‖ devicePub)[0..4]) mod 1 000 000`
 *
 * Rendered with leading zeros, e.g. `"048219"`.
 */
export function deriveSasCode(hostNoisePub: Uint8Array, deviceNoisePub: Uint8Array, psk: Uint8Array): string {
  if (hostNoisePub.length !== 32 || deviceNoisePub.length !== 32) {
    throw new Error('pairing: noise public keys must be 32 bytes')
  }
  if (psk.length !== 32) throw new Error('pairing: psk must be 32 bytes')
  const message = concatBytes(utf8ToBytes('remora/1 sas'), Uint8Array.of(0x00), hostNoisePub, deviceNoisePub)
  const mac = hmac(sha256, psk, message)
  const value =
    (((mac[0] ?? 0) << 24) | ((mac[1] ?? 0) << 16) | ((mac[2] ?? 0) << 8) | (mac[3] ?? 0)) >>> 0
  return String(value % 1_000_000).padStart(6, '0')
}

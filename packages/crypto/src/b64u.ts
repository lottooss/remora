/**
 * Unpadded base64url codec (RFC 4648 §5) — the `b64u` encoding every key,
 * signature, and token uses on the wire (Crypto/1 §1). Fail closed: padding
 * characters, non-alphabet characters, impossible lengths, and non-canonical
 * trailing bits are all rejected.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const DECODE_TABLE = (() => {
  const table = new Int8Array(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i
  return table
})()

/** Encodes `bytes` as unpadded base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 3 <= bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += ALPHABET.charAt((n >>> 18) & 63)
    out += ALPHABET.charAt((n >>> 12) & 63)
    out += ALPHABET.charAt((n >>> 6) & 63)
    out += ALPHABET.charAt(n & 63)
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16
    out += ALPHABET.charAt((n >>> 18) & 63)
    out += ALPHABET.charAt((n >>> 12) & 63)
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += ALPHABET.charAt((n >>> 18) & 63)
    out += ALPHABET.charAt((n >>> 12) & 63)
    out += ALPHABET.charAt((n >>> 6) & 63)
  }
  return out
}

/** Decodes unpadded base64url; throws on padding or any non-canonical input. */
export function decodeBase64Url(str: string): Uint8Array {
  if (str.includes('=')) throw new Error('b64u: "=" padding is not allowed')
  if (str.length % 4 === 1) throw new Error('b64u: invalid length')
  const out = new Uint8Array(Math.floor((str.length * 6) / 8))
  let bits = 0
  let acc = 0
  let pos = 0
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i)
    const value = code < 128 ? (DECODE_TABLE[code] ?? -1) : -1
    if (value < 0) throw new Error('b64u: character outside the base64url alphabet')
    acc = (acc << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[pos] = (acc >>> bits) & 0xff
      pos += 1
      acc &= (1 << bits) - 1
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new Error('b64u: non-canonical trailing bits')
  }
  return out
}

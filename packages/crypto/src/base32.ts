/**
 * RFC 4648 base32 with the lowercase alphabet and no padding — the endpoint-id
 * encoding of Crypto/1 §1. Fail closed: padding, characters outside the
 * alphabet, lengths that cannot occur from a canonical encoder, and non-zero
 * trailing bits are rejected.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

const DECODE_TABLE = (() => {
  const table = new Int8Array(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i
  return table
})()

/** Encodes `bytes` as unpadded lowercase base32 (RFC 4648). */
export function encodeBase32(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let acc = 0
  for (let i = 0; i < bytes.length; i += 1) {
    acc = (acc << 8) | (bytes[i] ?? 0)
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET.charAt((acc >>> bits) & 31)
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out += ALPHABET.charAt((acc << (5 - bits)) & 31)
  return out
}

/** Decodes unpadded lowercase base32; throws on any non-canonical input. */
export function decodeBase32(str: string): Uint8Array {
  if (str.includes('=')) throw new Error('base32: "=" padding is not allowed')
  const rem = str.length % 8
  if (rem === 1 || rem === 3 || rem === 6) throw new Error('base32: invalid length')
  const out = new Uint8Array(Math.floor((str.length * 5) / 8))
  let bits = 0
  let acc = 0
  let pos = 0
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i)
    const value = code < 128 ? (DECODE_TABLE[code] ?? -1) : -1
    if (value < 0) throw new Error('base32: character outside the base32 alphabet')
    acc = (acc << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[pos] = (acc >>> bits) & 0xff
      pos += 1
      acc &= (1 << bits) - 1
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new Error('base32: non-canonical trailing bits')
  }
  return out
}

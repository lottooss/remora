import { decodeBase32 } from './base32.ts'

/** Rejects non-canonical endpoint identities before binding them cryptographically. */
export function assertEndpointId(id: string, kind: 'host' | 'device'): void {
  const prefix = kind === 'host' ? 'h_' : 'd_'
  if (!id.startsWith(prefix) || id.length !== 28 || decodeBase32(id.slice(2)).length !== 16) {
    throw new Error(`crypto: malformed ${kind} endpoint id`)
  }
}

/** Requires the exact HTTP(S) origin used by QR and relay authentication. */
export function assertRelayOrigin(origin: string): void {
  const url = new URL(origin)
  // `url.origin` strips credentials, paths, queries and fragments and
  // normalizes the default port, so equality rejects all of them at once.
  if (url.origin !== origin) {
    throw new Error('crypto: relay origin must contain no path, credentials, query or fragment')
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '10.0.2.2')) return
  throw new Error('crypto: relay origin must be https')
}

/** Rejects malformed Unicode rather than hashing different replacement bytes across runtimes. */
export function assertUnicode(value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('crypto: malformed Unicode')
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('crypto: malformed Unicode')
  }
}

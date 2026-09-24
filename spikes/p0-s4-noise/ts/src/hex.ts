import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

export { bytesToHex, hexToBytes }

/** Strict lowercase-hex decode: even length, [0-9a-f] only. */
export function decodeHex(text: string): Uint8Array {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) {
    throw new TypeError('expected an even-length lowercase hex string')
  }
  return hexToBytes(text)
}

/**
 * Ambient declarations for the platform globals Crypto/1 code uses. This
 * package compiles with `lib: ["ES2023"]` and `types: []`, so the DOM and
 * WebCrypto typings are intentionally absent; only the members actually used
 * are declared here, matching the Web Crypto and Encoding specifications
 * honored by Node, workers, and browsers.
 */

declare const crypto: {
  /** Fills `array` with cryptographically strong random bytes (Web Crypto). */
  getRandomValues<T extends Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | BigInt64Array | BigUint64Array>(
    array: T,
  ): T
}

declare class TextEncoder {
  encode(input?: string): Uint8Array
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean })
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string
}

declare class URL {
  constructor(input: string)
  readonly origin: string
  readonly protocol: string
  readonly hostname: string
}

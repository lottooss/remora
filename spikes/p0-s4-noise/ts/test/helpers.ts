import { concatBytes } from '@noble/hashes/utils.js'
import {
  HandshakeState,
  decodeHex,
  generateKeypair,
  keypairFromSecret,
  utf8,
  type Keypair,
} from '../src/index.ts'

/** Crypto/1 §6 prologue: "remora/1" ‖ 0x00 ‖ purpose ‖ 0x00 ‖ hostId ‖ 0x00 ‖ deviceId. */
export function remoraPrologue(
  purpose: 'pair' | 'session',
  hostId = 'h_test',
  deviceId = 'd_test',
): Uint8Array {
  return concatBytes(
    utf8('remora/1'),
    Uint8Array.of(0),
    utf8(purpose),
    Uint8Array.of(0),
    utf8(hostId),
    Uint8Array.of(0),
    utf8(deviceId),
  )
}

/** Obviously fake 32-byte PSK for spike tests only. */
export const TEST_PSK = decodeHex('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff')

/** Shared interop constants — mirrored byte-for-byte in the Kotlin InteropInitiator. */
export const INTEROP = {
  msg1: '{"v":1,"purpose":"session","app":{"version":"p0-s4"}}',
  msg2: '{"v":1,"time":0}',
  k2t: (i: number): string => `K2T:${i}`,
  t2k: (i: number): string => `T2K:${i}`,
  tamperFromK: 'tamper-k',
  tamperFromT: 'tamper-t',
} as const

export interface HandshakePair {
  initiator: HandshakeState
  responder: HandshakeState
  initKeypair: Keypair
  respKeypair: Keypair
  prologue: Uint8Array
  psk: Uint8Array
}

export interface PairOptions {
  prologue?: Uint8Array
  psk?: Uint8Array
  initStaticSecret?: Uint8Array
  respStaticSecret?: Uint8Array
}

/** Fresh random (or fixed) static keys plus both handshake states, pre-handshake. */
export function newHandshakePair(options: PairOptions = {}): HandshakePair {
  const prologue = options.prologue ?? remoraPrologue('session')
  const psk = options.psk ?? TEST_PSK
  const initKeypair = options.initStaticSecret
    ? keypairFromSecret(options.initStaticSecret)
    : generateKeypair()
  const respKeypair = options.respStaticSecret
    ? keypairFromSecret(options.respStaticSecret)
    : generateKeypair()
  const initiator = new HandshakeState({
    initiator: true,
    prologue,
    staticKeypair: initKeypair,
    remoteStatic: respKeypair.publicKey,
    psk,
  })
  const responder = new HandshakeState({
    initiator: false,
    prologue,
    staticKeypair: respKeypair,
    psk,
  })
  return { initiator, responder, initKeypair, respKeypair, prologue, psk }
}

/** Run message 1 and message 2 with the given payloads; both states must complete. */
export function completeHandshake(
  pair: HandshakePair,
  payload1: Uint8Array,
  payload2: Uint8Array,
): { msg1: Uint8Array; msg2: Uint8Array; plain1: Uint8Array; plain2: Uint8Array } {
  const msg1 = pair.initiator.writeMessage(payload1)
  const plain1 = pair.responder.readMessage(msg1)
  const msg2 = pair.responder.writeMessage(payload2)
  const plain2 = pair.initiator.readMessage(msg2)
  return { msg1, msg2, plain1, plain2 }
}

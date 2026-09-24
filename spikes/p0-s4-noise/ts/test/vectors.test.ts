/**
 * Runs the official Cacophony vector for Noise_IKpsk2_25519_ChaChaPoly_SHA256
 * (conformance/vectors/crypto/noise-cacophony-ikpsk2.json).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HandshakeState, bytesToHex, keypairFromSecret, utf8 } from '../src/index.ts'

interface VectorMessage {
  payload: string
  ciphertext: string
}

interface VectorInput {
  protocolName: string
  initPrologue: string
  initPsks: string[]
  initStatic: string
  initEphemeral: string
  initRemoteStatic: string
  respPrologue: string
  respPsks: string[]
  respStatic: string
  respEphemeral: string
  messages: VectorMessage[]
}

interface VectorCase {
  name: string
  input: VectorInput
  expect: { handshakeHash: string }
}

interface VectorDoc {
  suite: string
  version: number
  source: string
  cases: VectorCase[]
}

const vectorPath = fileURLToPath(
  new URL('../../../../conformance/vectors/crypto/noise-cacophony-ikpsk2.json', import.meta.url),
)
const doc = JSON.parse(readFileSync(vectorPath, 'utf8')) as VectorDoc
const hex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'))
const EMPTY = new Uint8Array(0)

function runVector(testCase: VectorCase): void {
  const input = testCase.input
  expect(input.protocolName).toBe('Noise_IKpsk2_25519_ChaChaPoly_SHA256')
  expect(input.initPrologue).toBe(input.respPrologue)
  expect(input.initPsks).toEqual(input.respPsks)
  expect(input.initPsks).toHaveLength(1)
  const psk = hex(input.initPsks[0] as string)
  const prologue = hex(input.initPrologue)

  const initKeypair = keypairFromSecret(hex(input.initStatic))
  const respKeypair = keypairFromSecret(hex(input.respStatic))
  // The initiator pins the responder public key; it must be the responder's.
  expect(bytesToHex(respKeypair.publicKey)).toBe(input.initRemoteStatic)

  const initiator = new HandshakeState({
    initiator: true,
    prologue,
    staticKeypair: initKeypair,
    remoteStatic: hex(input.initRemoteStatic),
    psk,
    ephemeralSecret: hex(input.initEphemeral),
  })
  const responder = new HandshakeState({
    initiator: false,
    prologue,
    staticKeypair: respKeypair,
    psk,
    ephemeralSecret: hex(input.respEphemeral),
  })

  expect(input.messages).toHaveLength(6)
  input.messages.forEach((message, index) => {
    const payload = hex(message.payload)
    if (index === 0) {
      const out = initiator.writeMessage(payload)
      expect(bytesToHex(out)).toBe(message.ciphertext)
      expect(bytesToHex(responder.readMessage(out))).toBe(message.payload)
    } else if (index === 1) {
      const out = responder.writeMessage(payload)
      expect(bytesToHex(out)).toBe(message.ciphertext)
      expect(bytesToHex(initiator.readMessage(out))).toBe(message.payload)
    } else {
      // Transport phase: even index = initiator → responder (c1), odd = reverse (c2).
      const send = index % 2 === 0 ? initiator.result.send : responder.result.send
      const recv = index % 2 === 0 ? responder.result.recv : initiator.result.recv
      const ciphertext = send.encryptWithAd(EMPTY, payload)
      expect(bytesToHex(ciphertext)).toBe(message.ciphertext)
      expect(bytesToHex(recv.decryptWithAd(EMPTY, ciphertext))).toBe(message.payload)
    }
  })

  expect(initiator.isComplete).toBe(true)
  expect(responder.isComplete).toBe(true)
  expect(bytesToHex(initiator.result.handshakeHash)).toBe(testCase.expect.handshakeHash)
  expect(bytesToHex(responder.result.handshakeHash)).toBe(testCase.expect.handshakeHash)
  // Responder learned the initiator static key from message 1 (session admission).
  expect(bytesToHex(responder.result.remoteStatic)).toBe(bytesToHex(initKeypair.publicKey))
}

describe('Cacophony conformance vectors', () => {
  it('imports exactly the IKpsk2 ChaChaPoly SHA256 suite', () => {
    expect(doc.suite).toBe('crypto/noise-cacophony-ikpsk2')
    expect(doc.version).toBe(1)
    expect(doc.source).toContain('cacophony.txt')
    expect(doc.source).toContain('Unlicense')
    expect(doc.cases.length).toBeGreaterThanOrEqual(1)
  })

  for (const testCase of doc.cases) {
    it(testCase.name, () => {
      runVector(testCase)
    })
  }
})

describe('vector edge shapes', () => {
  it('uses a protocol name longer than HASHLEN (so InitializeSymmetric hashes it)', () => {
    expect(utf8('Noise_IKpsk2_25519_ChaChaPoly_SHA256').length).toBe(36)
  })
})

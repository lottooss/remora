import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HandshakeState,
  decodeHex,
  bytesToHex,
  keypairFromSecret
} from '../src/index.ts'

const vectorPath = join(__dirname, '../../../../conformance/vectors/crypto/noise-cacophony-ikpsk2.json')
const suite = JSON.parse(readFileSync(vectorPath, 'utf8'))

describe('Noise IKpsk2 Cacophony Vectors (TypeScript)', () => {
  for (const c of suite.cases) {
    it(c.name, () => {
      const { input, expect: expected } = c

      const initStatic = keypairFromSecret(decodeHex(input.initStatic))
      const respStatic = keypairFromSecret(decodeHex(input.respStatic))
      const initRemoteStatic = decodeHex(input.initRemoteStatic)
      const psk = decodeHex(input.initPsks[0])

      const initiator = new HandshakeState({
        initiator: true,
        prologue: decodeHex(input.initPrologue),
        staticKeypair: initStatic,
        remoteStatic: initRemoteStatic,
        psk,
        ephemeralSecret: decodeHex(input.initEphemeral)
      })

      const responder = new HandshakeState({
        initiator: false,
        prologue: decodeHex(input.respPrologue),
        staticKeypair: respStatic,
        psk,
        ephemeralSecret: decodeHex(input.respEphemeral)
      })

      // Message 1: -> e, es, s, ss
      const m1Input = input.messages[0]
      const m1Payload = decodeHex(m1Input.payload)
      const m1Ciphertext = initiator.writeMessage(m1Payload)
      expect(bytesToHex(m1Ciphertext)).toBe(m1Input.ciphertext)

      const m1Decrypted = responder.readMessage(m1Ciphertext)
      expect(bytesToHex(m1Decrypted)).toBe(m1Input.payload)

      // Message 2: <- e, ee, se, psk
      const m2Input = input.messages[1]
      const m2Payload = decodeHex(m2Input.payload)
      const m2Ciphertext = responder.writeMessage(m2Payload)
      expect(bytesToHex(m2Ciphertext)).toBe(m2Input.ciphertext)

      const m2Decrypted = initiator.readMessage(m2Ciphertext)
      expect(bytesToHex(m2Decrypted)).toBe(m2Input.payload)

      // Handshake complete on both sides
      expect(initiator.isComplete).toBe(true)
      expect(responder.isComplete).toBe(true)

      const initResult = initiator.result
      const respResult = responder.result

      // Verify handshake hash
      expect(bytesToHex(initResult.handshakeHash)).toBe(expected.handshakeHash)
      expect(bytesToHex(respResult.handshakeHash)).toBe(expected.handshakeHash)

      // Transport messages (messages 2..N)
      for (let i = 2; i < input.messages.length; i++) {
        const msg = input.messages[i]
        const payload = decodeHex(msg.payload)

        // Alternating: even i = initiator -> responder, odd i = responder -> initiator
        if (i % 2 === 0) {
          const ct = initResult.send.encryptWithAd(new Uint8Array(0), payload)
          expect(bytesToHex(ct)).toBe(msg.ciphertext)
          const pt = respResult.recv.decryptWithAd(new Uint8Array(0), ct)
          expect(bytesToHex(pt)).toBe(msg.payload)
        } else {
          const ct = respResult.send.encryptWithAd(new Uint8Array(0), payload)
          expect(bytesToHex(ct)).toBe(msg.ciphertext)
          const pt = initResult.recv.decryptWithAd(new Uint8Array(0), ct)
          expect(bytesToHex(pt)).toBe(msg.payload)
        }
      }
    })
  }
})

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPushAad,
  buildCanonicalApprovalMessage,
  computeArgsDigest,
  derivePairPsk,
  deriveSasCode,
  deriveEndpointId,
  encodeBase64Url,
  signRelayChallenge,
} from '../src/index.ts'
import { ed25519 } from '@noble/curves/ed25519.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

// Deterministic fixture generator for the crypto conformance vectors
// (conformance/vectors/crypto/**). Fixed keys below are test-only material.
// Run: node packages/crypto/scripts/gen-vectors.ts (writes files; asserts nothing).

const VECTORS_DIR = join(import.meta.dirname, '..', '..', '..', 'conformance', 'vectors', 'crypto')
mkdirSync(VECTORS_DIR, { recursive: true })

const HOST_ID = 'h_erruijsx3ey2rmxcpeh3pgxjkm'
const DEVICE_ID = 'd_erruijsx3ey2rmxcpeh3pgxjkm'
const bytes = (fill: (i: number) => number) => Uint8Array.from({ length: 32 }, (_, i) => fill(i))

function writeJson(name: string, content: unknown): void {
  writeFileSync(join(VECTORS_DIR, name), JSON.stringify(content, null, 2) + '\n')
}

// 1. Endpoint IDs (unchanged by the crypto restoration)
const fixedRelayPub = bytes((i) => 0x42)
const hostIdDerived = deriveEndpointId('h_', fixedRelayPub)
const deviceIdDerived = deriveEndpointId('d_', fixedRelayPub)
const otherRelayPub = bytes(() => 0x43)

writeJson('endpoint-id.json', {
  suite: 'crypto/endpoint-id',
  version: 1,
  source: 'Crypto/1 §2 normative derivation',
  notes: 'Deterministic endpoint ID derivations for host and device',
  cases: [
    {
      name: 'host endpoint id',
      input: { prefix: 'h_', relayPubB64u: encodeBase64Url(fixedRelayPub) },
      expect: { endpointId: hostIdDerived },
    },
    {
      name: 'device endpoint id',
      input: { prefix: 'd_', relayPubB64u: encodeBase64Url(fixedRelayPub) },
      expect: { endpointId: deviceIdDerived },
    },
    {
      name: 'a different key derives a different id',
      input: { prefix: 'h_', relayPubB64u: encodeBase64Url(otherRelayPub) },
      expect: { endpointId: deriveEndpointId('h_', otherRelayPub) },
    },
    {
      name: 'a prefix other than h_ or d_ is rejected',
      input: { prefix: 'x_', relayPubB64u: encodeBase64Url(fixedRelayPub) },
      error: 'invalid_prefix',
    },
    {
      name: 'a relay key that is not 32 bytes is rejected',
      input: { prefix: 'h_', relayPubB64u: encodeBase64Url(new Uint8Array(31).fill(0x42)) },
      error: 'invalid_key_length',
    },
  ],
})

// 2. Relay auth (Crypto/1 §4): Ed25519 over the context-bound message
//    "remora/1 relay-auth\0<origin>\0<kind>\0<endpointId>\0<nonce[32]>".
const edPriv = bytes((i) => (i * 7 + 3) % 256)
const edPub = ed25519.getPublicKey(edPriv)
const relayOrigin = 'https://relay.example.test'
const nonce = bytes((i) => i)
const hostFields = { relayOrigin, kind: 'host' as const, endpointId: HOST_ID, nonce }
const deviceFields = {
  relayOrigin,
  kind: 'device' as const,
  endpointId: DEVICE_ID,
  nonce: bytes((i) => i + 64),
}
const hostSig = signRelayChallenge(edPriv, hostFields)
const deviceSig = signRelayChallenge(edPriv, deviceFields)
const tamperedSig = Uint8Array.from(hostSig)
tamperedSig[0] = (tamperedSig[0] ?? 0) ^ 1

writeJson('relay-auth.json', {
  suite: 'crypto/relay-auth',
  version: 1,
  source: 'Crypto/1 §4 relay authentication',
  notes: 'Ed25519 signatures over the origin/kind/endpoint/nonce context message',
  cases: [
    {
      name: 'valid host relay auth signature',
      input: {
        publicKeyB64u: encodeBase64Url(edPub),
        relayOrigin,
        kind: 'host',
        endpointId: HOST_ID,
        nonceB64u: encodeBase64Url(nonce),
        signatureB64u: encodeBase64Url(hostSig),
      },
      expect: { valid: true },
    },
    {
      name: 'valid device relay auth signature',
      input: {
        publicKeyB64u: encodeBase64Url(edPub),
        relayOrigin,
        kind: 'device',
        endpointId: DEVICE_ID,
        nonceB64u: encodeBase64Url(deviceFields.nonce),
        signatureB64u: encodeBase64Url(deviceSig),
      },
      expect: { valid: true },
    },
    {
      name: 'tampered signature rejected',
      input: {
        publicKeyB64u: encodeBase64Url(edPub),
        relayOrigin,
        kind: 'host',
        endpointId: HOST_ID,
        nonceB64u: encodeBase64Url(nonce),
        signatureB64u: encodeBase64Url(tamperedSig),
      },
      expect: { valid: false },
    },
    {
      name: 'mismatched origin rejected',
      input: {
        publicKeyB64u: encodeBase64Url(edPub),
        relayOrigin: 'https://other.example.test',
        kind: 'host',
        endpointId: HOST_ID,
        nonceB64u: encodeBase64Url(nonce),
        signatureB64u: encodeBase64Url(hostSig),
      },
      expect: { valid: false },
    },
    {
      name: 'mismatched endpoint rejected',
      input: {
        publicKeyB64u: encodeBase64Url(edPub),
        relayOrigin,
        kind: 'device',
        endpointId: DEVICE_ID,
        nonceB64u: encodeBase64Url(nonce),
        signatureB64u: encodeBase64Url(hostSig),
      },
      expect: { valid: false },
    },
    {
      name: 'a non-canonical origin is rejected when signing',
      input: {
        privateKeyB64u: encodeBase64Url(edPriv),
        relayOrigin: 'https://relay.example.test/path',
        kind: 'host',
        endpointId: HOST_ID,
        nonceB64u: encodeBase64Url(nonce),
      },
      error: 'invalid_origin',
    },
  ],
})

// 3. Pairing (Crypto/1 §5): host-bound PSK and transcript-hash SAS.
const pairingSecret = bytes((i) => 0xa0 + i)
const pairPsk = derivePairPsk(pairingSecret, HOST_ID)
const handshakeHash = bytes((i) => i + 1)
const otherHandshakeHash = bytes((i) => 32 - i)

writeJson('pairing.json', {
  suite: 'crypto/pairing',
  version: 1,
  source: 'Crypto/1 §5 pairing protocol',
  notes: 'Host-bound pairing PSK derivation and handshake-hash SAS derivation',
  cases: [
    {
      name: 'pairPsk derives from the pairing secret and host id',
      input: {
        pairingSecretB64u: encodeBase64Url(pairingSecret),
        hostId: HOST_ID,
      },
      expect: { pairPskHex: bytesToHex(pairPsk) },
    },
    {
      name: 'SAS derives six digits from the handshake hash',
      input: { handshakeHashHex: bytesToHex(handshakeHash) },
      expect: { sasCode: deriveSasCode(handshakeHash) },
    },
    {
      name: 'SAS derives a different code from a different transcript',
      input: { handshakeHashHex: bytesToHex(otherHandshakeHash) },
      expect: { sasCode: deriveSasCode(otherHandshakeHash) },
    },
    {
      name: 'a pairing secret that is not 32 bytes is rejected',
      input: {
        pairingSecretB64u: encodeBase64Url(new Uint8Array(31).fill(0xa0)),
        hostId: HOST_ID,
      },
      error: 'invalid_key_length',
    },
    {
      name: 'a malformed host id is rejected',
      input: {
        pairingSecretB64u: encodeBase64Url(pairingSecret),
        hostId: 'h_short',
      },
      error: 'invalid_endpoint_id',
    },
  ],
})

// 4. Approval (Crypto/1 §7): ten-line canonical message and text+NUL+json digest.
const approvalFields = {
  hostId: HOST_ID,
  deviceId: DEVICE_ID,
  approvalId: 'appr_01923456789a',
  sessionId: 'sess_01923456789a',
  callId: 'call_01923456789a',
  toolName: 'bash',
  outcome: 'allowed-once' as const,
  issuedAt: 1_790_000_000_000,
  argsDigest: computeArgsDigest({ text: 'bash: pnpm test', json: '{"cmd":"pnpm test"}' }),
}
const approvalNoCall = { ...approvalFields, callId: undefined, outcome: 'rejected' as const }

writeJson('approval.json', {
  suite: 'crypto/approval',
  version: 1,
  source: 'Crypto/1 §7 approval signatures',
  notes: 'Ten-line canonical approval message and text+NUL+json args digest',
  cases: [
    {
      name: 'canonical approval message with all identities',
      input: approvalFields,
      expect: { canonicalMessage: buildCanonicalApprovalMessage(approvalFields) },
    },
    {
      name: 'missing callId renders a dash line and rejected outcome',
      input: approvalNoCall,
      expect: { canonicalMessage: buildCanonicalApprovalMessage(approvalNoCall) },
    },
    {
      name: 'args digest over text, NUL and raw json',
      input: { text: 'bash: pnpm test', json: '{"cmd":"pnpm test"}' },
      expect: { argsDigestHex: computeArgsDigest({ text: 'bash: pnpm test', json: '{"cmd":"pnpm test"}' }) },
    },
    {
      name: 'a malformed argsDigest is rejected',
      input: { ...approvalFields, argsDigest: 'deadbeef' },
      error: 'malformed_args_digest',
    },
    {
      name: 'an unknown outcome is rejected',
      input: { ...approvalFields, outcome: 'allowed-always' },
      error: 'invalid_outcome',
    },
  ],
})

// 5. Push (Crypto/1 §8): ChaCha20-Poly1305 with the identity-bound AAD.
const pushKey = bytes((i) => 0x55)
const pushContext = { hostId: HOST_ID, deviceId: DEVICE_ID }
const pushAad = buildPushAad(pushContext)
const pushNonce = Uint8Array.from({ length: 12 }, (_, i) => i)
const pushPlaintextJson = JSON.stringify({ v: 1, kind: 'approval', at: 1_790_000_000_000, title: 'Approval needed' })
const pushCiphertext = chacha20poly1305(pushKey, pushNonce, pushAad).encrypt(utf8ToBytes(pushPlaintextJson))
const pushSealed = new Uint8Array(pushNonce.length + pushCiphertext.length)
pushSealed.set(pushNonce, 0)
pushSealed.set(pushCiphertext, pushNonce.length)
const pushTampered = Uint8Array.from(pushSealed)
pushTampered[20] = (pushTampered[20] ?? 0) ^ 1

writeJson('push.json', {
  suite: 'crypto/push',
  version: 1,
  source: 'Crypto/1 §8 push encryption',
  notes: 'ChaCha20-Poly1305 with AAD "remora/1 push\\0hostId\\0deviceId"; 12-byte nonce prefix',
  cases: [
    {
      name: 'opens a sealed payload under the matching host/device context',
      input: {
        pushKeyB64u: encodeBase64Url(pushKey),
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        sealedB64u: encodeBase64Url(pushSealed),
      },
      expect: { plaintextJson: pushPlaintextJson },
    },
    {
      name: 'tampered ciphertext fails closed',
      input: {
        pushKeyB64u: encodeBase64Url(pushKey),
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        sealedB64u: encodeBase64Url(pushTampered),
      },
      expect: { valid: false },
    },
    {
      name: 'mismatched device context fails closed',
      input: {
        pushKeyB64u: encodeBase64Url(pushKey),
        hostId: HOST_ID,
        deviceId: 'd_erruijsx3ey2rmxcpeh3pgxjki',
        sealedB64u: encodeBase64Url(pushSealed),
      },
      expect: { valid: false },
    },
    {
      name: 'a sealed payload shorter than nonce and tag is rejected',
      input: {
        pushKeyB64u: encodeBase64Url(pushKey),
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        sealedB64u: encodeBase64Url(new Uint8Array(27)),
      },
      error: 'payload_too_short',
    },
    {
      name: 'a sealed payload beyond the 2048-byte bound is rejected',
      input: {
        pushKeyB64u: encodeBase64Url(pushKey),
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        sealedB64u: encodeBase64Url(new Uint8Array(3_000)),
      },
      error: 'payload_too_large',
    },
  ],
})

console.log('Successfully generated crypto conformance vectors.')
console.log('pairPskHex =', bytesToHex(pairPsk))
console.log('sasCode    =', deriveSasCode(handshakeHash))
console.log('argsDigest =', approvalFields.argsDigest)

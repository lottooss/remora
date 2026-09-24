import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  deriveEndpointId,
  encodeBase64Url,
  signRelayChallenge,
  buildCanonicalApprovalMessage,
} from '../src/index.ts'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const VECTORS_DIR = join(import.meta.dirname, '..', '..', '..', 'conformance', 'vectors', 'crypto')
mkdirSync(VECTORS_DIR, { recursive: true })

// 1. Endpoint IDs
const fixedRelayPub = new Uint8Array(32).fill(0x42)
const hostId = deriveEndpointId('h_', fixedRelayPub)
const deviceId = deriveEndpointId('d_', fixedRelayPub)

writeFileSync(
  join(VECTORS_DIR, 'endpoint-id.json'),
  JSON.stringify(
    {
      suite: 'crypto/endpoint-id',
      version: 1,
      source: 'Crypto/1 §2 normative derivation',
      notes: 'Deterministic endpoint ID derivations for host and device',
      cases: [
        {
          name: 'host endpoint id',
          input: {
            prefix: 'h_',
            relayPubB64u: encodeBase64Url(fixedRelayPub),
          },
          expect: {
            endpointId: hostId,
          },
        },
        {
          name: 'device endpoint id',
          input: {
            prefix: 'd_',
            relayPubB64u: encodeBase64Url(fixedRelayPub),
          },
          expect: {
            endpointId: deviceId,
          },
        },
      ],
    },
    null,
    2,
  ) + '\n',
)

// 2. Relay Auth
const edPriv = new Uint8Array(32).fill(0x11)
const edPub = ed25519.getPublicKey(edPriv)
const challengeToken = 'https://relay.remora.local\x00host\x00h_test123\x00nonce_fixed_32_bytes_test_vector'
const sig = signRelayChallenge(edPriv, challengeToken)

writeFileSync(
  join(VECTORS_DIR, 'relay-auth.json'),
  JSON.stringify(
    {
      suite: 'crypto/relay-auth',
      version: 1,
      source: 'Crypto/1 §4 relay authentication',
      notes: 'Ed25519 challenge signing and verification',
      cases: [
        {
          name: 'valid host relay auth challenge signature',
          input: {
            publicKeyB64u: encodeBase64Url(edPub),
            challengeToken,
            signatureB64u: encodeBase64Url(sig),
          },
          expect: {
            valid: true,
          },
        },
        {
          name: 'invalid signature rejected',
          input: {
            publicKeyB64u: encodeBase64Url(edPub),
            challengeToken,
            signatureB64u: encodeBase64Url(new Uint8Array(64).fill(0x99)),
          },
          expect: {
            valid: false,
          },
        },
      ],
    },
    null,
    2,
  ) + '\n',
)

// 3. Pairing
const pairingSecret = new Uint8Array(32).fill(0x33)
const ticketId = 'tkt_01923456789a'
const pairPsk = derivePairPsk(pairingSecret, ticketId)

writeFileSync(
  join(VECTORS_DIR, 'pairing.json'),
  JSON.stringify(
    {
      suite: 'crypto/pairing',
      version: 1,
      source: 'Crypto/1 §5 pairing protocol',
      notes: 'QR code serialization, PSK derivation, and SAS generation',
      cases: [
        {
          name: 'pairPsk derivation from pairingSecret and ticketId',
          input: {
            pairingSecretB64u: encodeBase64Url(pairingSecret),
            ticketId,
          },
          expect: {
            pairPskHex: bytesToHex(pairPsk),
          },
        },
      ],
    },
    null,
    2,
  ) + '\n',
)

// 4. Approval
const approvalFields = {
  approvalId: 'appr_01923456789a',
  outcome: 'allowed-once' as const,
  issuedAt: 1790000000000,
  argsDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
}
const approvalMsg = buildCanonicalApprovalMessage(approvalFields)

writeFileSync(
  join(VECTORS_DIR, 'approval.json'),
  JSON.stringify(
    {
      suite: 'crypto/approval',
      version: 1,
      source: 'Crypto/1 §7 approval signatures',
      notes: 'Canonical approval message formatting and P-256 DER signature verification',
      cases: [
        {
          name: 'canonical approval message formatting',
          input: approvalFields,
          expect: {
            canonicalMessage: approvalMsg,
          },
        },
      ],
    },
    null,
    2,
  ) + '\n',
)

// 5. Push
const pushKey = new Uint8Array(32).fill(0x55)
const pushPayload = { v: 1, kind: 'approval', at: 1790000000000 }

writeFileSync(
  join(VECTORS_DIR, 'push.json'),
  JSON.stringify(
    {
      suite: 'crypto/push',
      version: 1,
      source: 'Crypto/1 §8 push encryption',
      notes: 'ChaCha20-Poly1305 push notification AEAD payload sealing',
      cases: [
        {
          name: 'push roundtrip verification',
          input: {
            pushKeyB64u: encodeBase64Url(pushKey),
            payload: pushPayload,
          },
          expect: {
            validRoundtrip: true,
          },
        },
      ],
    },
    null,
    2,
  ) + '\n',
)

console.log('Successfully generated crypto conformance vectors.')

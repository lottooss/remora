import {
  deriveEndpointId,
  generateKeypair,
  getRelayPublicKey,
  keypairFromPrivate,
  randomBytes,
  type Keypair,
} from '@remora/crypto'

export interface HostIdentity {
  /** 32-byte Ed25519 seed and public key used for relay authentication. */
  relayKeypair: Keypair
  /** 32-byte X25519 static keypair used for Noise IKpsk2 session admission. */
  noiseKeypair: Keypair
  /** Host endpoint id ('h_' + 26 base32 characters). */
  hostId: string
}

/**
 * Creates a fresh host identity with cryptographically random keys, or from provided seeds.
 */
export function createHostIdentity(
  relaySeed?: Uint8Array,
  noiseSecret?: Uint8Array,
): HostIdentity {
  const seed = relaySeed ?? randomBytes(32)
  if (seed.length !== 32) {
    throw new Error('Host relay seed must be 32 bytes')
  }
  const relayPub = getRelayPublicKey(seed)
  const relayKeypair: Keypair = {
    privateKey: seed,
    publicKey: relayPub,
  }

  const noiseKeypair = noiseSecret
    ? keypairFromPrivate(noiseSecret)
    : generateKeypair()

  const hostId = deriveEndpointId('h_', relayPub)

  return {
    relayKeypair,
    noiseKeypair,
    hostId,
  }
}

import { describe, expect, it } from 'vitest'
import { DOMAIN_PREFIX, ENDPOINT_ID_PREFIX, NOISE_PROTOCOL_NAME } from '../src/index.ts'

describe('crypto constants match Crypto/1', () => {
  it('names the Noise protocol exactly', () => {
    expect(NOISE_PROTOCOL_NAME).toBe('Noise_IKpsk2_25519_ChaChaPoly_SHA256')
  })

  it('uses the v1 domain prefix and endpoint id prefixes', () => {
    expect(DOMAIN_PREFIX).toBe('remora/1')
    expect(ENDPOINT_ID_PREFIX).toEqual({ host: 'h_', device: 'd_' })
  })
})

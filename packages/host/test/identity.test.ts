import { describe, expect, it } from 'vitest'
import { createHostIdentity } from '../src/identity/index.ts'

describe('HostIdentity', () => {
  it('creates fresh host identity with valid keys and endpoint ID', () => {
    const id1 = createHostIdentity()
    expect(id1.relayKeypair.privateKey).toHaveLength(32)
    expect(id1.relayKeypair.publicKey).toHaveLength(32)
    expect(id1.noiseKeypair.privateKey).toHaveLength(32)
    expect(id1.noiseKeypair.publicKey).toHaveLength(32)
    expect(id1.hostId).toMatch(/^h_[a-z2-7]{26}$/)

    const id2 = createHostIdentity()
    expect(id2.hostId).not.toEqual(id1.hostId)
  })

  it('deterministically derives hostId from given relay seed', () => {
    const seed = new Uint8Array(32).fill(0x77)
    const idA = createHostIdentity(seed)
    const idB = createHostIdentity(seed)
    expect(idA.hostId).toEqual(idB.hostId)
    expect(idA.relayKeypair.publicKey).toEqual(idB.relayKeypair.publicKey)
  })

  it('rejects seeds with invalid length', () => {
    expect(() => createHostIdentity(new Uint8Array(31))).toThrow('32 bytes')
  })
})

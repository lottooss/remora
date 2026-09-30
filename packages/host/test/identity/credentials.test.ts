/**
 * P7-H2 acceptance tests: the persistent host identity in dsh credentials
 * (docs/tasks/P7-H2.md, crypto-v1.md §3 record `remora/host-identity`, §9).
 * `loadOrCreateHostIdentity` must read the record, create it exactly once with
 * an atomic create-if-absent write when absent, adopt the winner of a create
 * race, and fail closed on a stored record it cannot parse — regeneration on a
 * corrupt record would silently rotate the host key and break every pairing.
 * Secrets never appear in logs or error messages.
 */
import { decodeBase64Url, encodeBase64Url, randomBytes } from '@remora/crypto'
import { describe, expect, it } from 'vitest'
import {
  HOST_IDENTITY_RECORD_KEY,
  HostIdentityRecordError,
  loadOrCreateHostIdentity,
} from '../../src/identity/credentials.ts'
import { createHostIdentity } from '../../src/identity/index.ts'
import type { FakeCredentialRecord, FakeGrantRecord } from './fake-credentials.ts'
import { createInMemoryCredentialsStore } from './fake-credentials.ts'

/** Extracts the `grant` payload of the stored host identity record. */
function storedPayload(record: FakeCredentialRecord): unknown {
  expect(record.kind).toBe('grant')
  return (record as FakeGrantRecord).payload
}

/** Reads the stored host identity record from the store. */
async function readStoredRecord(
  store: ReturnType<typeof createInMemoryCredentialsStore>,
): Promise<FakeCredentialRecord | undefined> {
  return store.readRecord(HOST_IDENTITY_RECORD_KEY)
}

/** The base32 host id shape from @remora/crypto (`h_` + 26 lowercase base32 chars). */
const HOST_ID_PATTERN = /^h_[a-z2-7]{26}$/

describe('loadOrCreateHostIdentity', () => {
  it('creates a new identity and stores it when the record is absent', async () => {
    const store = createInMemoryCredentialsStore()

    const identity = await loadOrCreateHostIdentity(store)

    expect(identity.hostId).toMatch(HOST_ID_PATTERN)
    expect(identity.relayKeypair.privateKey).toHaveLength(32)
    expect(identity.noiseKeypair.privateKey).toHaveLength(32)

    const stored = await readStoredRecord(store)
    expect(stored, 'the identity record must be written to the credentials store').toBeDefined()
    const payload = storedPayload(stored as FakeCredentialRecord)
    expect(payload).toMatchObject({ relaySeed: expect.any(String), noiseSecret: expect.any(String) })
    const { relaySeed, noiseSecret } = payload as { relaySeed: string; noiseSecret: string }
    expect(decodeBase64Url(relaySeed)).toEqual(identity.relayKeypair.privateKey)
    expect(decodeBase64Url(noiseSecret)).toEqual(identity.noiseKeypair.privateKey)
  })

  it('loads the stored identity instead of generating a new one', async () => {
    const seed = randomBytes(32)
    const noiseSecret = randomBytes(32)
    const expected = createHostIdentity(seed, noiseSecret)
    const store = createInMemoryCredentialsStore({
      [HOST_IDENTITY_RECORD_KEY]: {
        kind: 'grant',
        payload: { relaySeed: encodeBase64Url(seed), noiseSecret: encodeBase64Url(noiseSecret) },
      },
    })

    const identity = await loadOrCreateHostIdentity(store)

    expect(identity.hostId).toBe(expected.hostId)
    expect(identity.relayKeypair.publicKey).toEqual(expected.relayKeypair.publicKey)
    expect(identity.noiseKeypair.publicKey).toEqual(expected.noiseKeypair.publicKey)
  })

  it('adopts the identity stored by a concurrent start instead of overwriting it', async () => {
    const store = createInMemoryCredentialsStore()

    // Two starts racing on the same store — the atomic create-if-absent write
    // must let exactly one identity win and make both callers use it.
    const [first, second] = await Promise.all([
      loadOrCreateHostIdentity(store),
      loadOrCreateHostIdentity(store),
    ])

    expect(first.hostId).toBe(second.hostId)
    const stored = await readStoredRecord(store)
    expect(stored).toBeDefined()
    const { relaySeed } = storedPayload(stored as FakeCredentialRecord) as { relaySeed: string }
    expect(decodeBase64Url(relaySeed)).toEqual(first.relayKeypair.privateKey)
  })

  it('fails closed on a record with an unusable payload and leaves it untouched', async () => {
    const corrupt: FakeCredentialRecord = {
      kind: 'grant',
      payload: { relaySeed: encodeBase64Url(randomBytes(16)), noiseSecret: encodeBase64Url(randomBytes(16)) },
    }
    const store = createInMemoryCredentialsStore({ [HOST_IDENTITY_RECORD_KEY]: corrupt })

    await expect(loadOrCreateHostIdentity(store)).rejects.toBeInstanceOf(HostIdentityRecordError)

    // Fail closed: a corrupt record is never silently replaced — that would
    // rotate the host key and break every pairing (crypto-v1.md §3).
    expect(await readStoredRecord(store)).toBe(corrupt)
  })

  it('fails closed on a record that is not a host identity grant', async () => {
    const foreign: FakeCredentialRecord = { kind: 'api-key', key: 'sk-not-a-host-identity' }
    const store = createInMemoryCredentialsStore({ [HOST_IDENTITY_RECORD_KEY]: foreign })

    await expect(loadOrCreateHostIdentity(store)).rejects.toBeInstanceOf(HostIdentityRecordError)
    expect(await readStoredRecord(store)).toBe(foreign)
  })

  it('never puts seed material into rejection messages', async () => {
    const leakedSeed = 'topsecret-seed-marker'
    const store = createInMemoryCredentialsStore({
      [HOST_IDENTITY_RECORD_KEY]: { kind: 'grant', payload: { relaySeed: leakedSeed, noiseSecret: 'x' } },
    })

    const outcome = await loadOrCreateHostIdentity(store).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
    )

    expect(outcome).not.toContain(leakedSeed)
  })
})

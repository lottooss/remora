/**
 * In-memory fake of the dsh credentials record seam (`ctx.credentials`), the
 * boundary the persistent host identity is stored across (docs/tasks/P7-H2.md).
 * The shape follows the upstream seam (@deepseek-ai/dsh-credentials, verified in
 * spikes/p0-s1-dsh-adapter Q4 and .upstream/deepseek-harness/packages/credentials/
 * credentials/README.md): records are addressed by `<owner>/<id>`, `modifyRecord`
 * is the only write path and hands the mutation the record as it stands at the
 * moment the write is exclusive (returning `undefined` leaves the entry
 * untouched), and `deleteRecord` is a no-op when absent.
 *
 * Test support only: the real seam runs in tests/real-dsh against real dsh.
 * The types here are structural twins declared locally — the fake must stay
 * importable without the production identity module it will later back.
 */

/** A credential record the harness itself understands (structural twin of the upstream union). */
export interface FakeApiKeyRecord {
  readonly kind: 'api-key'
  readonly key?: string
  readonly env?: Readonly<Record<string, string>>
}

/** An owner-defined record (structural twin of the upstream `GrantRecord`). */
export interface FakeGrantRecord {
  readonly kind: 'grant'
  readonly payload: unknown
}

export type FakeCredentialRecord = FakeApiKeyRecord | FakeGrantRecord

/** Facts a configuration surface sees; never the value (upstream `CredentialRecordInfo`). */
export interface FakeCredentialRecordInfo {
  configured: boolean
  kind?: string
  writable: boolean
}

/** The record half of the dsh credentials seam, structurally. */
export interface FakeCredentialsRecordStore {
  readRecord(key: string): Promise<FakeCredentialRecord | undefined>
  modifyRecord(
    key: string,
    mutate: (current: FakeCredentialRecord | undefined) => Promise<FakeCredentialRecord | undefined>,
  ): Promise<FakeCredentialRecord | undefined>
  describeRecord(key: string): Promise<FakeCredentialRecordInfo>
  deleteRecord(key: string): Promise<void>
}

/**
 * Builds an in-memory credentials store, optionally pre-seeded with records.
 * The store models the seam's serialized write contract: every `modifyRecord`
 * observes the committed record, and a mutation that declines (returns
 * `undefined`) commits nothing.
 */
export function createInMemoryCredentialsStore(
  initial?: Readonly<Record<string, FakeCredentialRecord>>,
): FakeCredentialsRecordStore {
  const records = new Map<string, FakeCredentialRecord>(Object.entries(initial ?? {}))
  return {
    async readRecord(key) {
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next === undefined) return records.get(key)
      records.set(key, next)
      return next
    },
    async describeRecord(key) {
      const record = records.get(key)
      return record === undefined
        ? { configured: false, writable: true }
        : { configured: true, kind: record.kind, writable: true }
    },
    async deleteRecord(key) {
      records.delete(key)
    },
  }
}

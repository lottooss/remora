/**
 * In-memory fake of BOTH halves of the dsh credentials seam (`ctx.credentials`)
 * the host uses at startup since P7-H3: the record half (identity and the
 * remembered relay enrollment — reused from test/identity/fake-credentials.ts)
 * and the reference half, `resolve(ref)`, through which the relay enrollment
 * secret named by `config.enrollSecretKey` is read.
 *
 * The reference half follows the upstream contract (.upstream/deepseek-harness/
 * packages/credentials/credentials/src/index.ts, `CredentialProvider.resolve`):
 * it returns `{ value, source }` or `undefined` while unconfigured, and an
 * empty value counts as absent everywhere. Every resolved name is recorded so
 * tests can assert which reference the host asked for.
 */
import {
  createInMemoryCredentialsStore,
  type FakeCredentialRecord,
  type FakeCredentialsRecordStore,
} from '../identity/fake-credentials.ts'

/** One resolved reference (upstream `ResolvedCredential`). */
export interface FakeResolvedCredential {
  value: string
  source: string
}

/** The record half plus the reference half of the dsh credentials seam. */
export interface FakeHostCredentials extends FakeCredentialsRecordStore {
  resolve(ref: string): Promise<FakeResolvedCredential | undefined>
  /** Every reference name passed to `resolve`, in call order. */
  readonly resolvedRefs: readonly string[]
}

/**
 * Builds the fake. `references` maps reference names (environment-variable
 * style, e.g. `REMORA_RELAY_ENROLL_SECRET`) to values; `records` pre-seeds
 * the record store.
 */
export function createHostCredentials(options: {
  references?: Readonly<Record<string, string>>
  records?: Readonly<Record<string, FakeCredentialRecord>>
} = {}): FakeHostCredentials {
  const store = createInMemoryCredentialsStore(options.records)
  const references = new Map(Object.entries(options.references ?? {}))
  const resolvedRefs: string[] = []
  return {
    readRecord: (key) => store.readRecord(key),
    modifyRecord: (key, mutate) => store.modifyRecord(key, mutate),
    describeRecord: (key) => store.describeRecord(key),
    deleteRecord: (key) => store.deleteRecord(key),
    resolvedRefs,
    async resolve(ref) {
      resolvedRefs.push(ref)
      const value = references.get(ref)
      return value === undefined || value === '' ? undefined : { value, source: 'env' }
    },
  }
}

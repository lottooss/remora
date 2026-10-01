/**
 * Persistent host identity in dsh credentials (docs/tasks/P7-H2.md).
 *
 * The host's relay seed (Ed25519) and Noise static key (X25519) live in the
 * dsh credentials record `remora/host-identity` (crypto-v1.md §3: host
 * lifetime — rotation means re-pairing every device) and are loaded from
 * there on every start, so a restart keeps its identity and every pairing.
 * Secrets cross this module in memory only: nothing here logs, and rejection
 * messages name fields, never values (crypto-v1.md §9, AGENTS.md §1.8).
 *
 * The dsh side of the boundary is the record seam of `ctx.credentials`
 * (@deepseek-ai/dsh-credentials), verified by the P0-S1 spike: records are
 * addressed `<owner>/<id>`, `modifyRecord` is the only write path and hands
 * the mutation the record as it stands at the moment the write is exclusive
 * (returning `undefined` leaves the entry untouched) — which is what makes
 * the create-if-absent write below atomic.
 */
import { decodeBase64Url, encodeBase64Url, randomBytes } from '@remora/crypto'
import { createHostIdentity, type HostIdentity } from './index.ts'

/** dsh credentials record holding the host identity (crypto-v1.md §3). */
export const HOST_IDENTITY_RECORD_KEY = 'remora/host-identity'

/** A key-shaped credential record (structural twin of the upstream union member). */
export interface HostApiKeyRecord {
  readonly kind: 'api-key'
  readonly key?: string
  readonly env?: Readonly<Record<string, string>>
}

/** An owner-defined credential record (structural twin of the upstream `GrantRecord`). */
export interface HostGrantRecord {
  readonly kind: 'grant'
  readonly payload: unknown
}

export type HostCredentialRecord = HostApiKeyRecord | HostGrantRecord

/** Presence facts about a record; never the value (upstream `CredentialRecordInfo`). */
export interface HostCredentialRecordInfo {
  configured: boolean
  kind?: string
  writable: boolean
}

/**
 * Structural view of the dsh credentials record seam (`ctx.credentials`).
 * Declared locally because the seam is provided by dsh at runtime and its
 * package is not on this bundle's dependency list (spikes/p0-s1-dsh-adapter
 * Q4, docs/upstream/dsh-integration.md §7); a narrow interface also keeps
 * every other credential capability out of this module's reach.
 */
export interface HostCredentialsStore {
  readRecord(key: string): Promise<HostCredentialRecord | undefined>
  modifyRecord(
    key: string,
    mutate: (current: HostCredentialRecord | undefined) => Promise<HostCredentialRecord | undefined>,
  ): Promise<HostCredentialRecord | undefined>
  describeRecord(key: string): Promise<HostCredentialRecordInfo>
  deleteRecord(key: string): Promise<void>
}

/**
 * A stored host identity record that cannot be used. Fail closed: callers
 * must never regenerate around it — a new identity would silently break
 * every pairing.
 */
export class HostIdentityRecordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostIdentityRecordError'
  }
}

/** The owner-defined grant payload: both 32-byte keys, base64url-encoded. */
interface HostIdentityPayload {
  relaySeed: string
  noiseSecret: string
}

/** Builds the grant record storing a freshly generated identity (JSON-safe). */
function hostIdentityRecord(relaySeed: Uint8Array, noiseSecret: Uint8Array): HostGrantRecord {
  const payload: HostIdentityPayload = {
    relaySeed: encodeBase64Url(relaySeed),
    noiseSecret: encodeBase64Url(noiseSecret),
  }
  return { kind: 'grant', payload }
}

/**
 * Decodes one 32-byte base64url key field of the stored payload. The value
 * itself never appears in a rejection message.
 */
function decodeSeedField(value: unknown, field: string): Uint8Array {
  if (typeof value !== 'string') {
    throw new HostIdentityRecordError(
      `dsh credentials record ${HOST_IDENTITY_RECORD_KEY} field ${field} must be a base64url string`,
    )
  }
  let decoded: Uint8Array
  try {
    decoded = decodeBase64Url(value)
  } catch {
    throw new HostIdentityRecordError(
      `dsh credentials record ${HOST_IDENTITY_RECORD_KEY} field ${field} is not canonical base64url`,
    )
  }
  if (decoded.length !== 32) {
    throw new HostIdentityRecordError(
      `dsh credentials record ${HOST_IDENTITY_RECORD_KEY} field ${field} must decode to 32 bytes`,
    )
  }
  return decoded
}

/**
 * Rebuilds the identity from a stored record. Anything but a grant carrying
 * the two 32-byte key fields throws {@link HostIdentityRecordError} — a
 * corrupt record is never silently replaced (crypto-v1.md §3).
 */
function identityFromRecord(record: HostCredentialRecord): HostIdentity {
  if (record.kind !== 'grant') {
    throw new HostIdentityRecordError(
      `dsh credentials record ${HOST_IDENTITY_RECORD_KEY} must be a grant record (found kind: ${record.kind})`,
    )
  }
  const payload: unknown = record.payload
  if (typeof payload !== 'object' || payload === null) {
    throw new HostIdentityRecordError(
      `dsh credentials record ${HOST_IDENTITY_RECORD_KEY} payload must be an object`,
    )
  }
  if (!('relaySeed' in payload) || !('noiseSecret' in payload)) {
    throw new HostIdentityRecordError(
      `dsh credentials record ${HOST_IDENTITY_RECORD_KEY} payload must carry relaySeed and noiseSecret`,
    )
  }
  const relaySeed = decodeSeedField(payload.relaySeed, 'relaySeed')
  const noiseSecret = decodeSeedField(payload.noiseSecret, 'noiseSecret')
  return createHostIdentity(relaySeed, noiseSecret)
}

/**
 * Loads the host identity from dsh credentials, creating it exactly once:
 * the stored record is parsed and returned; when absent, fresh keys are
 * generated and written with an atomic create-if-absent `modifyRecord` — if
 * another start wins the write, its record is adopted so two starts of the
 * same host can never hold different identities. A stored record that cannot
 * be parsed fails closed with {@link HostIdentityRecordError} instead of
 * being replaced.
 */
export async function loadOrCreateHostIdentity(credentials: HostCredentialsStore): Promise<HostIdentity> {
  const stored = await credentials.readRecord(HOST_IDENTITY_RECORD_KEY)
  if (stored !== undefined) return identityFromRecord(stored)

  const record = hostIdentityRecord(randomBytes(32), randomBytes(32))
  await credentials.modifyRecord(HOST_IDENTITY_RECORD_KEY, async (current) => {
    if (current !== undefined) return undefined // lost the create race; keep the winner
    return record
  })

  const settled = await credentials.readRecord(HOST_IDENTITY_RECORD_KEY)
  if (settled === undefined) {
    throw new HostIdentityRecordError(
      `dsh credentials record ${HOST_IDENTITY_RECORD_KEY} is absent after the create-if-absent write`,
    )
  }
  return identityFromRecord(settled)
}

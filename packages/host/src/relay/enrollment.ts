/**
 * Host enrollment with the relay (relay-v1.md §4.1, docs/tasks/P7-H3.md).
 *
 * The relay authenticates only endpoints it knows (relay-v1.md §3: an unknown
 * host is refused with close 4403), so the host registers its relay public key
 * with `POST /v1/enroll/host` before it dials. Enrollment is idempotent on the
 * relay; the host still remembers a success in the dsh credentials record
 * `remora/relay-enrollment` — bound to the host id and the relay origin — so
 * later starts skip the request (the relay rate-limits enrollment per IP).
 * The record holds no secret: it sits beside `remora/host-identity`, which
 * keeps the key material write-once (crypto-v1.md §3).
 *
 * The enrollment secret is read through the reference half of the dsh
 * credentials seam, `ctx.credentials.resolve(ref)` (upstream
 * packages/credentials/credentials/src/index.ts): the local provider resolves
 * the launch environment, then its store, then the project `.env`, then
 * `$DSH_HOME/.env`. It is resolved again for every attempt, as that contract
 * asks, and never logged: errors name the key, never the value
 * (AGENTS.md §1.8).
 */
import { encodeBase64Url } from '@remora/crypto'
import { RemoraConfigError } from '../config.ts'
import type { HostCredentialsStore } from '../identity/credentials.ts'
import type { HostIdentity } from '../identity/index.ts'

/** dsh credentials record remembering the relay this host identity enrolled with. */
export const RELAY_ENROLLMENT_RECORD_KEY = 'remora/relay-enrollment'

/** Upper bound of one enrollment request, so a stalled relay cannot hang startup. */
export const DEFAULT_ENROLL_TIMEOUT_MS = 15_000
/** First wait before retrying a retryable enrollment failure. */
export const DEFAULT_ENROLL_MIN_RETRY_DELAY_MS = 1_000
/** Longest wait between two enrollment attempts (the delay doubles up to it). */
export const DEFAULT_ENROLL_MAX_RETRY_DELAY_MS = 60_000

/**
 * Upstream `CredentialRef` grammar — a POSIX shell identifier — that
 * `credentialRef()` enforces (packages/credentials/credentials/src/index.ts).
 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Relay error codes are short snake_case words (relay-v1.md §9); anything else is not echoed. */
const RELAY_ERROR_CODE_PATTERN = /^[a-z_]{1,32}$/

/** One resolved credential reference (structural twin of upstream `ResolvedCredential`). */
export interface ResolvedCredentialValue {
  value: string
  source: string
}

/**
 * Structural view of the reference half of the dsh credentials seam
 * (`CredentialProvider.resolve`). Declared locally for the same reason as
 * {@link HostCredentialsStore}: the seam's package is provided by dsh at
 * runtime and is not on this bundle's dependency list.
 */
export interface CredentialReferenceResolver {
  resolve(ref: string): Promise<ResolvedCredentialValue | undefined>
}

/** Both halves of the dsh credentials seam the host uses at startup. */
export type RelayEnrollmentCredentials = HostCredentialsStore & CredentialReferenceResolver

/** Stable codes of {@link RelayEnrollmentError}. */
export type RelayEnrollmentErrorCode =
  | 'network'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable'
  | 'rejected'
  | 'bad_response'

const RETRYABLE_CODES: ReadonlySet<RelayEnrollmentErrorCode> = new Set(['network', 'rate_limited', 'unavailable'])

/**
 * A failed host enrollment. `retryable` failures (relay unreachable, 429,
 * 5xx) are worth another attempt after a backoff; the others are final: a
 * `401` means the secret is wrong, and any other answer means the relay URL
 * or the relay itself must be fixed first. Messages never carry the secret.
 */
export class RelayEnrollmentError extends Error {
  override readonly name = 'RelayEnrollmentError'
  readonly code: RelayEnrollmentErrorCode
  /** HTTP status of the relay's answer; `undefined` when none arrived. */
  readonly status: number | undefined
  readonly retryable: boolean

  constructor(code: RelayEnrollmentErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.status = options.status
    this.retryable = RETRYABLE_CODES.has(code)
  }
}

/** Where the owner puts the secret; shared by every message that asks for it. */
function secretLocationHint(key: string): string {
  return (
    `put ${key}=<the relay's REMORA_ENROLL_SECRET> in $DSH_HOME/.env (by default ~/.dsh/.env; on Windows ` +
    `%USERPROFILE%\\.dsh\\.env) or set ${key} in the environment dsh is launched from ` +
    '(docs/runbooks/operations.md §3)'
  )
}

/**
 * Resolves the relay enrollment secret named by `config.enrollSecretKey`.
 * @throws {RemoraConfigError} when the key is not a credential reference name,
 *   or when nothing is configured under it (an empty value counts as unset).
 */
export async function resolveEnrollSecret(credentials: CredentialReferenceResolver, key: string): Promise<string> {
  if (!CREDENTIAL_REF_PATTERN.test(key)) {
    throw new RemoraConfigError(
      `remora: config.enrollSecretKey must be an environment-variable style dsh credentials key such as REMORA_RELAY_ENROLL_SECRET (got ${JSON.stringify(key)})`,
    )
  }
  const resolved = await credentials.resolve(key)
  if (resolved === undefined || resolved.value === '') {
    throw new RemoraConfigError(
      `remora: the relay enrollment secret ${key} (config.enrollSecretKey) is not set; ${secretLocationHint(key)}`,
    )
  }
  return resolved.value
}

/** A short, value-free reason for a failed request (the error code of the socket layer, or the error name). */
function networkReason(error: unknown): string {
  if (error instanceof Error) {
    const cause: unknown = error.cause
    if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string') {
      return cause.code
    }
    return error.name
  }
  return 'unknown'
}

/** The relay's `error` code from a JSON error body, when it is a well-formed code. */
function relayErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const code = parsed.error
      if (typeof code === 'string' && RELAY_ERROR_CODE_PATTERN.test(code)) return code
    }
  } catch {
    // not JSON: the body is not echoed at all
  }
  return undefined
}

/**
 * Registers the host's relay public key with the relay (relay-v1.md §4.1).
 * Idempotent on the relay. The reply must name this host's own id; anything
 * else fails closed.
 * @param relayHttpUrl - the relay origin, e.g. `https://remora.example.workers.dev`.
 * @param enrollSecret - the bearer secret (`REMORA_ENROLL_SECRET` of the relay); never logged.
 * @param options.signal - aborts the request; the abort reason is rethrown as is.
 * @param options.timeoutMs - per-request timeout; default {@link DEFAULT_ENROLL_TIMEOUT_MS}.
 * @throws {RelayEnrollmentError} for every relay or network failure.
 */
export async function enrollHost(
  relayHttpUrl: string,
  enrollSecret: string,
  identity: HostIdentity,
  hostName: string,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
): Promise<{ v: number; id: string }> {
  const url = new URL('/v1/enroll/host', relayHttpUrl)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_ENROLL_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])

  let status: number
  let body: string
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${enrollSecret}`,
      },
      body: JSON.stringify({
        v: 1,
        relayPub: encodeBase64Url(identity.relayKeypair.publicKey),
        name: hostName,
        platform: process.platform,
      }),
      signal,
    })
    status = response.status
    body = await response.text()
  } catch (error: unknown) {
    // The caller's own abort is a cancellation, not a relay failure.
    options.signal?.throwIfAborted()
    throw new RelayEnrollmentError(
      'network',
      `relay ${url.origin} is unreachable (${networkReason(error)})`,
      { cause: error },
    )
  }

  if (status >= 200 && status < 300) {
    let reply: unknown
    try {
      reply = JSON.parse(body)
    } catch {
      reply = undefined
    }
    if (typeof reply !== 'object' || reply === null || !('v' in reply) || reply.v !== 1 || !('id' in reply)) {
      throw new RelayEnrollmentError('bad_response', `relay ${url.origin} sent a malformed enrollment reply`, { status })
    }
    if (reply.id !== identity.hostId) {
      throw new RelayEnrollmentError(
        'bad_response',
        `relay ${url.origin} enrolled a different endpoint id than this host's`,
        { status },
      )
    }
    return { v: 1, id: identity.hostId }
  }

  const code = relayErrorCode(body)
  const answer = code === undefined ? `${status}` : `${status} ${code}`
  if (status === 401) {
    throw new RelayEnrollmentError('unauthorized', `relay ${url.origin} refused the enrollment secret (${answer})`, { status })
  }
  if (status === 429) {
    throw new RelayEnrollmentError('rate_limited', `relay ${url.origin} rate-limited the enrollment (${answer})`, { status })
  }
  if (status >= 500) {
    throw new RelayEnrollmentError('unavailable', `relay ${url.origin} could not enroll the host (${answer})`, { status })
  }
  throw new RelayEnrollmentError('rejected', `relay ${url.origin} rejected the host enrollment (${answer})`, { status })
}

/** Payload of {@link RELAY_ENROLLMENT_RECORD_KEY}: which host id enrolled with which relay origin. */
interface RelayEnrollmentPayload {
  hostId: string
  enrolledRelayOrigin: string
}

/** Whether the remembered enrollment is for exactly this host id and relay origin; anything unreadable is "no". */
async function isEnrolledWith(credentials: HostCredentialsStore, hostId: string, relayOrigin: string): Promise<boolean> {
  const record = await credentials.readRecord(RELAY_ENROLLMENT_RECORD_KEY)
  if (record === undefined || record.kind !== 'grant') return false
  const payload: unknown = record.payload
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'hostId' in payload &&
    payload.hostId === hostId &&
    'enrolledRelayOrigin' in payload &&
    payload.enrolledRelayOrigin === relayOrigin
  )
}

/** Default wait between attempts: resolves after `ms`, rejects with the abort reason as soon as `signal` aborts. */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface EnsureHostEnrolledOptions {
  credentials: RelayEnrollmentCredentials
  /** `config.enrollSecretKey`: the credentials key holding the secret. */
  enrollSecretKey: string
  /** The relay origin (`ResolvedConfig.relayOrigin`). */
  relayOrigin: string
  identity: HostIdentity
  hostName: string
  /** Stops the attempts and the waits between them; the abort reason is rethrown. */
  signal?: AbortSignal | undefined
  /** First retry delay; default {@link DEFAULT_ENROLL_MIN_RETRY_DELAY_MS}. */
  minRetryDelayMs?: number | undefined
  /** Cap of the doubling retry delay; default {@link DEFAULT_ENROLL_MAX_RETRY_DELAY_MS}. */
  maxRetryDelayMs?: number | undefined
  /** Wait between attempts; injected for deterministic tests. */
  sleep?: ((ms: number, signal: AbortSignal | undefined) => Promise<void>) | undefined
  /** Called before each wait with the retryable failure and the delay. */
  onRetry?: ((error: RelayEnrollmentError, delayMs: number) => void) | undefined
  /** Called when the enrollment succeeded but could not be remembered (the next start enrolls again). */
  onRememberFailed?: ((error: unknown) => void) | undefined
}

/**
 * Makes sure the relay knows this host before it dials: skips the request
 * when the credentials record remembers an enrollment of this host id with
 * this relay origin; otherwise enrolls — retrying network, 429, and 5xx
 * failures with a doubling, capped delay until the signal aborts — and then
 * remembers the success.
 * @returns `'already-enrolled'` when skipped, `'enrolled'` after a fresh enrollment.
 * @throws {RemoraConfigError} when the secret is missing or the key is malformed.
 * @throws {RelayEnrollmentError} for a final (non-retryable) relay answer.
 */
export async function ensureHostEnrolled(options: EnsureHostEnrolledOptions): Promise<'enrolled' | 'already-enrolled'> {
  const { credentials, identity, relayOrigin, signal } = options
  if (await isEnrolledWith(credentials, identity.hostId, relayOrigin)) return 'already-enrolled'

  const sleep = options.sleep ?? sleepUnlessAborted
  const maxDelayMs = options.maxRetryDelayMs ?? DEFAULT_ENROLL_MAX_RETRY_DELAY_MS
  let delayMs = Math.min(options.minRetryDelayMs ?? DEFAULT_ENROLL_MIN_RETRY_DELAY_MS, maxDelayMs)
  for (;;) {
    signal?.throwIfAborted()
    // Resolved per attempt (the seam's per-operation contract): never cached across retries.
    const secret = await resolveEnrollSecret(credentials, options.enrollSecretKey)
    try {
      await enrollHost(relayOrigin, secret, identity, options.hostName, { signal })
      break
    } catch (error: unknown) {
      if (!(error instanceof RelayEnrollmentError) || !error.retryable) throw error
      options.onRetry?.(error, delayMs)
      await sleep(delayMs, signal)
      delayMs = Math.min(delayMs * 2, maxDelayMs)
    }
  }

  const payload: RelayEnrollmentPayload = { hostId: identity.hostId, enrolledRelayOrigin: relayOrigin }
  try {
    await credentials.modifyRecord(RELAY_ENROLLMENT_RECORD_KEY, async () => ({ kind: 'grant', payload }))
  } catch (error: unknown) {
    // Remembering is an optimization: the host is enrolled either way.
    options.onRememberFailed?.(error)
  }
  return 'enrolled'
}

/**
 * Forgets the remembered enrollment, so the next start enrolls again. Used
 * when the relay ends the link for good (4401/4403/4409), e.g. after the
 * relay lost its endpoint table — re-enrolling is idempotent and never
 * re-admits a host the relay revoked.
 */
export async function forgetRelayEnrollment(credentials: Pick<HostCredentialsStore, 'deleteRecord'>): Promise<void> {
  await credentials.deleteRecord(RELAY_ENROLLMENT_RECORD_KEY)
}

/**
 * One actionable, secret-free log line for an enrollment that ended without
 * starting the relay link.
 */
export function describeEnrollmentFailure(
  error: unknown,
  config: { relayOrigin: string; enrollSecretKey: string },
): string {
  const notStarted = 'the relay link is not started'
  if (error instanceof RelayEnrollmentError && error.code === 'unauthorized') {
    return (
      `remora: relay enrollment refused (${error.status ?? 401}): the relay at ${config.relayOrigin} does not accept ` +
      `the secret in ${config.enrollSecretKey}; ${secretLocationHint(config.enrollSecretKey)}, then restart dsh — ` +
      notStarted
    )
  }
  if (error instanceof RemoraConfigError) return `${error.message} — ${notStarted}`
  if (error instanceof RelayEnrollmentError) {
    return `remora: relay enrollment failed (${error.code}): ${error.message}; check config.relayUrl — ${notStarted}`
  }
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'
  return `remora: relay enrollment failed (${reason}) — ${notStarted}`
}

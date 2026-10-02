/**
 * P7-H3 — host enrollment with the relay (docs/tasks/P7-H3.md, relay-v1.md
 * §4.1). The unit under test is the real enrollment code in
 * packages/host/src/relay; only the other side of the boundary is faked: the
 * relay (a real HTTP server, test/relay/fake-relay.ts) and the dsh
 * credentials seam (test/relay/fake-credentials.ts). Waits between retries are
 * injected so the backoff schedule is asserted without real delays.
 */
import { encodeBase64Url } from '@remora/crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoraConfigError } from '../../src/config.ts'
import { createHostIdentity } from '../../src/identity/index.ts'
import {
  RELAY_ENROLLMENT_RECORD_KEY,
  RelayEnrollmentError,
  enrollHost,
  ensureHostEnrolled,
  forgetRelayEnrollment,
  resolveEnrollSecret,
} from '../../src/relay/index.ts'
import { reserveClosedPort } from '../support/dsh-fakes.ts'
import { createHostCredentials, type FakeHostCredentials } from './fake-credentials.ts'
import { startFakeRelay, type FakeRelay } from './fake-relay.ts'

const SECRET_KEY = 'REMORA_RELAY_ENROLL_SECRET'
/** Obviously fake test secret (AGENTS.md §10). */
const SECRET = 'test-enroll-secret-not-real-0123456789'

/** Fixed, obviously fake test keys so the host id is deterministic. */
const identity = createHostIdentity(new Uint8Array(32).fill(7), new Uint8Array(32).fill(9))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function relay(options: Parameters<typeof startFakeRelay>[0] = { enrollSecret: SECRET }): Promise<FakeRelay> {
  const fake = await startFakeRelay(options)
  cleanups.push(() => fake.close())
  return fake
}

function credentialsWithSecret(value: string = SECRET): FakeHostCredentials {
  return createHostCredentials({ references: { [SECRET_KEY]: value } })
}

/** A sleep that records the requested delays and returns at once. */
function recordingSleep(onSleep?: (delays: number[]) => Promise<void> | void): {
  delays: number[]
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>
} {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms)
      await onSleep?.(delays)
    },
  }
}

describe('ensureHostEnrolled', () => {
  it('enrolls once with the bearer secret and remembers the relay origin', async () => {
    const fake = await relay()
    const credentials = credentialsWithSecret()

    const outcome = await ensureHostEnrolled({
      credentials,
      enrollSecretKey: SECRET_KEY,
      relayOrigin: fake.origin,
      identity,
      hostName: 'TEST-PC',
    })

    expect(outcome).toBe('enrolled')
    expect(fake.enrollRequests).toHaveLength(1)
    expect(fake.enrollRequests[0]?.authorization).toBe(`Bearer ${SECRET}`)
    expect(fake.enrollRequests[0]?.body).toEqual({
      v: 1,
      relayPub: encodeBase64Url(identity.relayKeypair.publicKey),
      name: 'TEST-PC',
      platform: process.platform,
    })
    expect(fake.enrolledHostIds.has(identity.hostId)).toBe(true)
    expect(credentials.resolvedRefs).toContain(SECRET_KEY)
    expect(await credentials.readRecord(RELAY_ENROLLMENT_RECORD_KEY)).toEqual({
      kind: 'grant',
      payload: { hostId: identity.hostId, enrolledRelayOrigin: fake.origin },
    })
  })

  it('skips enrollment when already enrolled for that relay origin', async () => {
    const fake = await relay()
    const credentials = credentialsWithSecret()
    const options = { credentials, enrollSecretKey: SECRET_KEY, relayOrigin: fake.origin, identity, hostName: 'TEST-PC' }

    expect(await ensureHostEnrolled(options)).toBe('enrolled')
    expect(await ensureHostEnrolled(options)).toBe('already-enrolled')
    expect(fake.enrollRequests).toHaveLength(1)
  })

  it('enrolls again when the remembered enrollment is for another relay origin or another host id', async () => {
    const fake = await relay()
    const credentials = createHostCredentials({
      references: { [SECRET_KEY]: SECRET },
      records: {
        [RELAY_ENROLLMENT_RECORD_KEY]: {
          kind: 'grant',
          payload: { hostId: identity.hostId, enrolledRelayOrigin: 'https://old-relay.example.workers.dev' },
        },
      },
    })
    const options = { credentials, enrollSecretKey: SECRET_KEY, relayOrigin: fake.origin, identity, hostName: 'TEST-PC' }

    expect(await ensureHostEnrolled(options)).toBe('enrolled')
    expect(fake.enrollRequests).toHaveLength(1)

    await credentials.modifyRecord(RELAY_ENROLLMENT_RECORD_KEY, async () => ({
      kind: 'grant',
      payload: { hostId: 'h_aaaaaaaaaaaaaaaaaaaaaaaaaa', enrolledRelayOrigin: fake.origin },
    }))
    expect(await ensureHostEnrolled(options)).toBe('enrolled')
    expect(fake.enrollRequests).toHaveLength(2)
    expect(await credentials.readRecord(RELAY_ENROLLMENT_RECORD_KEY)).toEqual({
      kind: 'grant',
      payload: { hostId: identity.hostId, enrolledRelayOrigin: fake.origin },
    })
  })

  it('on 401 rejects with an unauthorized RelayEnrollmentError, does not retry, and remembers nothing', async () => {
    const fake = await relay({ enrollSecret: 'the-relay-has-another-secret' })
    const credentials = credentialsWithSecret()
    const waits = recordingSleep()

    const failure = await ensureHostEnrolled({
      credentials,
      enrollSecretKey: SECRET_KEY,
      relayOrigin: fake.origin,
      identity,
      hostName: 'TEST-PC',
      sleep: waits.sleep,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(RelayEnrollmentError)
    expect(failure).toMatchObject({ code: 'unauthorized', status: 401, retryable: false })
    expect(String((failure as Error).message)).not.toContain(SECRET)
    expect(fake.enrollRequests).toHaveLength(1)
    expect(waits.delays).toEqual([])
    expect(await credentials.readRecord(RELAY_ENROLLMENT_RECORD_KEY)).toBeUndefined()
  })

  it('with the secret missing throws a RemoraConfigError naming the key and the .env file, and sends nothing', async () => {
    const fake = await relay()

    // Unset, and set to an empty value (which the seam treats as unset).
    for (const credentials of [createHostCredentials(), credentialsWithSecret('')]) {
      const failure = await ensureHostEnrolled({
        credentials,
        enrollSecretKey: SECRET_KEY,
        relayOrigin: fake.origin,
        identity,
        hostName: 'TEST-PC',
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(RemoraConfigError)
      expect(String((failure as Error).message)).toContain(SECRET_KEY)
      expect(String((failure as Error).message)).toContain('.env')
    }
    expect(fake.enrollRequests).toHaveLength(0)
  })

  it('retries network errors with exponential backoff until the relay answers', async () => {
    const port = await reserveClosedPort()
    let started: FakeRelay | undefined
    // Nothing listens on the port at first; the relay comes up during the second wait.
    const waits = recordingSleep(async (delays) => {
      if (delays.length === 2) started = await relay({ enrollSecret: SECRET, port })
    })

    const outcome = await ensureHostEnrolled({
      credentials: credentialsWithSecret(),
      enrollSecretKey: SECRET_KEY,
      relayOrigin: `http://127.0.0.1:${port}`,
      identity,
      hostName: 'TEST-PC',
      sleep: waits.sleep,
      minRetryDelayMs: 1_000,
      maxRetryDelayMs: 60_000,
    })

    expect(outcome).toBe('enrolled')
    expect(waits.delays).toEqual([1_000, 2_000])
    expect(started?.enrollRequests).toHaveLength(1)
  })

  it('retries 429 and 5xx answers, capping the backoff at maxRetryDelayMs, and reports each retry', async () => {
    const fake = await relay({
      enrollSecret: SECRET,
      enrollResponseFor: (attempt) =>
        attempt <= 5 ? { status: attempt % 2 === 0 ? 429 : 503, body: { error: 'unavailable' } } : undefined,
    })
    const waits = recordingSleep()
    const retries: Array<[string, number]> = []

    const outcome = await ensureHostEnrolled({
      credentials: credentialsWithSecret(),
      enrollSecretKey: SECRET_KEY,
      relayOrigin: fake.origin,
      identity,
      hostName: 'TEST-PC',
      sleep: waits.sleep,
      minRetryDelayMs: 1_000,
      maxRetryDelayMs: 4_000,
      onRetry: (error, delayMs) => retries.push([error.code, delayMs]),
    })

    expect(outcome).toBe('enrolled')
    expect(fake.enrollRequests).toHaveLength(6)
    expect(waits.delays).toEqual([1_000, 2_000, 4_000, 4_000, 4_000])
    expect(retries).toEqual([
      ['unavailable', 1_000],
      ['rate_limited', 2_000],
      ['unavailable', 4_000],
      ['rate_limited', 4_000],
      ['unavailable', 4_000],
    ])
  })

  it('stops retrying as soon as the signal aborts', async () => {
    const port = await reserveClosedPort()
    const controller = new AbortController()
    const waits = recordingSleep(() => {
      controller.abort()
    })

    await expect(
      ensureHostEnrolled({
        credentials: credentialsWithSecret(),
        enrollSecretKey: SECRET_KEY,
        relayOrigin: `http://127.0.0.1:${port}`,
        identity,
        hostName: 'TEST-PC',
        signal: controller.signal,
        sleep: waits.sleep,
      }),
    ).rejects.toThrow()
    expect(waits.delays).toHaveLength(1)
  })

  it('fails closed when the relay answers with an id that is not this host', async () => {
    const fake = await relay({
      enrollSecret: SECRET,
      enrollResponseFor: () => ({ status: 200, body: { v: 1, id: 'h_aaaaaaaaaaaaaaaaaaaaaaaaaa' } }),
    })
    const credentials = credentialsWithSecret()
    const waits = recordingSleep()

    await expect(
      ensureHostEnrolled({
        credentials,
        enrollSecretKey: SECRET_KEY,
        relayOrigin: fake.origin,
        identity,
        hostName: 'TEST-PC',
        sleep: waits.sleep,
      }),
    ).rejects.toMatchObject({ name: 'RelayEnrollmentError', code: 'bad_response', retryable: false })
    expect(waits.delays).toEqual([])
    expect(await credentials.readRecord(RELAY_ENROLLMENT_RECORD_KEY)).toBeUndefined()
  })

  it('forgetRelayEnrollment drops the remembered enrollment so the next start enrolls again', async () => {
    const fake = await relay()
    const credentials = credentialsWithSecret()
    const options = { credentials, enrollSecretKey: SECRET_KEY, relayOrigin: fake.origin, identity, hostName: 'TEST-PC' }

    expect(await ensureHostEnrolled(options)).toBe('enrolled')
    await forgetRelayEnrollment(credentials)
    expect(await credentials.readRecord(RELAY_ENROLLMENT_RECORD_KEY)).toBeUndefined()
    expect(await ensureHostEnrolled(options)).toBe('enrolled')
    expect(fake.enrollRequests).toHaveLength(2)
  })
})

describe('resolveEnrollSecret', () => {
  it('returns the value resolved for the configured key', async () => {
    expect(await resolveEnrollSecret(credentialsWithSecret(), SECRET_KEY)).toBe(SECRET)
  })

  it('rejects a key that is not an environment-variable style credential name', async () => {
    await expect(resolveEnrollSecret(credentialsWithSecret(), 'remora/enroll-secret')).rejects.toBeInstanceOf(
      RemoraConfigError,
    )
  })
})

describe('enrollHost', () => {
  it('classifies an unreachable relay as a retryable network error', async () => {
    const port = await reserveClosedPort()
    await expect(enrollHost(`http://127.0.0.1:${port}`, SECRET, identity, 'TEST-PC')).rejects.toMatchObject({
      name: 'RelayEnrollmentError',
      code: 'network',
      retryable: true,
    })
  })

  it('classifies other 4xx answers as a non-retryable rejection', async () => {
    const fake = await relay({
      enrollSecret: SECRET,
      enrollResponseFor: () => ({ status: 400, body: { error: 'bad_request' } }),
    })
    await expect(enrollHost(fake.origin, SECRET, identity, 'TEST-PC')).rejects.toMatchObject({
      code: 'rejected',
      status: 400,
      retryable: false,
    })
  })
})

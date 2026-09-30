import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  RetryingGateway,
  type InvokeRemoteRequest,
  type TypertGateway,
} from '../../src/adapter/gateway.ts'

// The recorded real-world failure (P7-H9): on a freshly booted dsh the first
// gateway calls reject because `sessionController` is still starting.
const REPORT_PATH = path.resolve(__dirname, '../fixtures/dsh-0.1.5-rc.3/report.json')

interface RecordedReport {
  errors?: Array<{ label?: unknown; error?: { name?: unknown; message?: unknown; code?: unknown } }>
}

const recordedReport = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')) as RecordedReport
const recordedUnavailable = (recordedReport.errors ?? []).find(
  (entry) => entry.error?.code === 'gateway/service-unavailable',
)

/** Rebuilds the exact error recorded from real dsh 0.1.5-rc.3 (startup race). */
function recordedUnavailableError(): Error {
  if (recordedUnavailable === undefined || typeof recordedUnavailable.error?.message !== 'string') {
    throw new Error('fixture report.json no longer records the gateway/service-unavailable failure')
  }
  const err: Error & { code: string } = Object.assign(new Error(recordedUnavailable.error.message), {
    name: typeof recordedUnavailable.error.name === 'string' ? recordedUnavailable.error.name : 'TypertGatewayError',
    code: 'gateway/service-unavailable',
  })
  return err
}

function dshError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'TypertGatewayError', code })
}

const listRequest: InvokeRemoteRequest = {
  namespace: 'session',
  method: 'list',
  args: {},
}

class ScriptedGateway implements TypertGateway {
  readonly invoke = vi.fn(async (_request: InvokeRemoteRequest): Promise<unknown> => {
    throw new Error('unexpected gateway invoke call')
  })
  readonly stream = vi.fn(
    async (_request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>> => {
      throw new Error('unexpected gateway stream call')
    },
  )
}

interface FakeTime {
  readonly clock: () => number
  readonly sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>
  readonly delays: number[]
  advance(ms: number): void
  elapsed(): number
  pendingSleepCount(): number
  flush(): Promise<void>
}

/**
 * Deterministic replacement for wall-clock time and waiting: the retry loop
 * parks on `sleep`, and the test decides exactly when (and by how much) time
 * moves. No real timers are involved anywhere.
 */
function createFakeTime(): FakeTime {
  let now = 0
  const pending: Array<{ resolve: () => void }> = []
  const delays: number[] = []
  return {
    clock: () => now,
    sleep: (ms) => {
      delays.push(ms)
      return new Promise<void>((resolve) => {
        pending.push({ resolve })
      })
    },
    delays,
    advance: (ms) => {
      now += ms
    },
    elapsed: () => now,
    pendingSleepCount: () => pending.length,
    flush: async () => {
      const due = pending.splice(0)
      for (const entry of due) entry.resolve()
      await drainMicrotasks()
    },
  }
}

/** Runs every queued microtask (await continuations) before the test continues. */
async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * One retry interval: lets the in-flight attempt fail and schedule its sleep,
 * advances the fake clock by 250 ms, then lets the next attempt happen.
 */
async function retryStep(time: FakeTime): Promise<void> {
  await drainMicrotasks()
  time.advance(250)
  await time.flush()
}

describe('RetryingGateway.invoke', () => {
  it('retries gateway/service-unavailable every 250 ms until the call succeeds', async () => {
    const recorded = recordedUnavailableError()
    const scripted = new ScriptedGateway()
    scripted.invoke
      .mockRejectedValueOnce(recorded)
      .mockRejectedValueOnce(recorded)
      .mockResolvedValueOnce({ items: [{ id: 'session-1' }] })
    const time = createFakeTime()
    const retrying = new RetryingGateway(scripted, { clock: time.clock, sleep: time.sleep })

    const request: InvokeRemoteRequest = { namespace: 'session', method: 'list', args: {} }
    const promise = retrying.invoke(request)

    await retryStep(time)
    expect(scripted.invoke).toHaveBeenCalledTimes(2)
    await retryStep(time)

    await expect(promise).resolves.toEqual({ items: [{ id: 'session-1' }] })
    expect(scripted.invoke).toHaveBeenCalledTimes(3)
    // Exactly one 250 ms wait between consecutive attempts, none after success.
    expect(time.delays).toEqual([250, 250])
    // The request object reaches dsh untouched (signal included).
    expect(scripted.invoke.mock.calls[0]?.[0]).toBe(request)
  })

  it('gives up at the deadline and rejects with the original error', async () => {
    const recorded = recordedUnavailableError()
    const scripted = new ScriptedGateway()
    scripted.invoke.mockRejectedValue(recorded)
    const time = createFakeTime()
    const retrying = new RetryingGateway(scripted, {
      retryDeadlineMs: 1_000,
      clock: time.clock,
      sleep: time.sleep,
    })

    const promise = retrying.invoke(listRequest)
    // Attach the rejection assertion before stepping fake time: the promise
    // rejects mid-step, and Node would report the rejection as unhandled while
    // the test is still advancing the clock.
    const assertion = expect(promise).rejects.toBe(recorded)
    // Attempts at t=0, 250, 500, 750 are retried; the attempt at t=1000 is past
    // the deadline, so the original error is rethrown and nothing more is tried.
    for (let step = 0; step < 4; step += 1) {
      await retryStep(time)
    }
    await assertion
    expect(scripted.invoke).toHaveBeenCalledTimes(5)
    expect(time.delays).toEqual([250, 250, 250, 250])
    expect(time.pendingSleepCount()).toBe(0)
    expect(time.elapsed()).toBe(1_000)
  })

  it('stops retrying when the caller aborts while a retry is pending', async () => {
    const recorded = recordedUnavailableError()
    const scripted = new ScriptedGateway()
    scripted.invoke.mockRejectedValue(recorded)
    const time = createFakeTime()
    const retrying = new RetryingGateway(scripted, { clock: time.clock, sleep: time.sleep })
    const controller = new AbortController()

    const promise = retrying.invoke({ ...listRequest, signal: controller.signal })
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await drainMicrotasks()
    expect(scripted.invoke).toHaveBeenCalledTimes(1)

    // The caller gives up while the wrapper is waiting for the next retry.
    controller.abort()
    await time.flush()

    await assertion
    expect(scripted.invoke).toHaveBeenCalledTimes(1)
    expect(time.pendingSleepCount()).toBe(0)
  })

  it('rejects immediately without calling dsh when the signal is already aborted', async () => {
    const scripted = new ScriptedGateway()
    const time = createFakeTime()
    const retrying = new RetryingGateway(scripted, { clock: time.clock, sleep: time.sleep })
    const controller = new AbortController()
    controller.abort()

    await expect(
      retrying.invoke({ ...listRequest, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(scripted.invoke).not.toHaveBeenCalled()
  })

  it('does not retry errors with a different code or without a code', async () => {
    const notFound = dshError('session/not-found', 'typert gateway: session/list: not found')
    const similarCode = dshError(
      'gateway/not-found',
      'typert gateway: session/list: endpoint unknown',
    )
    const plain = new TypeError('something else went wrong')
    const time = createFakeTime()
    for (const error of [notFound, similarCode, plain]) {
      const inner = new ScriptedGateway()
      inner.invoke.mockRejectedValueOnce(error)
      const gateway = new RetryingGateway(inner, { clock: time.clock, sleep: time.sleep })
      await expect(gateway.invoke(listRequest)).rejects.toBe(error)
      expect(inner.invoke).toHaveBeenCalledTimes(1)
    }
    expect(time.delays).toEqual([])
  })

  it('uses the documented defaults: 30 s deadline and 250 ms interval', async () => {
    const recorded = recordedUnavailableError()
    const scripted = new ScriptedGateway()
    scripted.invoke.mockRejectedValue(recorded)
    const time = createFakeTime()
    const retrying = new RetryingGateway(scripted, { clock: time.clock, sleep: time.sleep })

    const promise = retrying.invoke(listRequest)
    const assertion = expect(promise).rejects.toBe(recorded)
    // 120 retries at t=0..29750 keep failing inside the deadline; the attempt at
    // t=30000 is the first one past the deadline and rejects for good.
    for (let step = 0; step < 120; step += 1) {
      await retryStep(time)
    }
    await assertion
    expect(scripted.invoke).toHaveBeenCalledTimes(121)
    expect(time.delays).toEqual(Array.from({ length: 120 }, () => 250))
    expect(time.elapsed()).toBe(30_000)
  })

  it('rejects non-finite or negative option values at construction', () => {
    const scripted = new ScriptedGateway()
    expect(() => new RetryingGateway(scripted, { retryDeadlineMs: -1 })).toThrow(TypeError)
    expect(() => new RetryingGateway(scripted, { retryDeadlineMs: Number.NaN })).toThrow(TypeError)
    expect(() => new RetryingGateway(scripted, { retryIntervalMs: -250 })).toThrow(TypeError)
  })
})

describe('RetryingGateway.stream', () => {
  it('retries gateway/service-unavailable every 250 ms until the stream opens', async () => {
    const recorded = recordedUnavailableError()
    const scripted = new ScriptedGateway()
    const opened: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'event', event: { kind: 'started' } }
      },
    }
    scripted.stream.mockRejectedValueOnce(recorded).mockRejectedValueOnce(recorded).mockResolvedValueOnce(opened)
    const time = createFakeTime()
    const retrying = new RetryingGateway(scripted, { clock: time.clock, sleep: time.sleep })

    const request: InvokeRemoteRequest = { namespace: 'session', method: 'control', args: {} }
    const promise = retrying.stream(request)

    await retryStep(time)
    expect(scripted.stream).toHaveBeenCalledTimes(2)
    await retryStep(time)

    await expect(promise).resolves.toBe(opened)
    expect(scripted.stream).toHaveBeenCalledTimes(3)
    expect(time.delays).toEqual([250, 250])
    expect(scripted.stream.mock.calls[0]?.[0]).toBe(request)
  })

  it('gives up at the deadline and rejects with the original error', async () => {
    const recorded = recordedUnavailableError()
    const scripted = new ScriptedGateway()
    scripted.stream.mockRejectedValue(recorded)
    const time = createFakeTime()
    const retrying = new RetryingGateway(scripted, {
      retryDeadlineMs: 1_000,
      clock: time.clock,
      sleep: time.sleep,
    })

    const promise = retrying.stream(listRequest)
    const assertion = expect(promise).rejects.toBe(recorded)
    for (let step = 0; step < 4; step += 1) {
      await retryStep(time)
    }
    await assertion
    expect(scripted.stream).toHaveBeenCalledTimes(5)
    expect(time.delays).toEqual([250, 250, 250, 250])
    expect(time.pendingSleepCount()).toBe(0)
  })

  it('stops retrying when the caller aborts while a retry is pending', async () => {
    const recorded = recordedUnavailableError()
    const scripted = new ScriptedGateway()
    scripted.stream.mockRejectedValue(recorded)
    const time = createFakeTime()
    const retrying = new RetryingGateway(scripted, { clock: time.clock, sleep: time.sleep })
    const controller = new AbortController()

    const promise = retrying.stream({ ...listRequest, signal: controller.signal })
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await drainMicrotasks()
    expect(scripted.stream).toHaveBeenCalledTimes(1)

    controller.abort()
    await time.flush()

    await assertion
    expect(scripted.stream).toHaveBeenCalledTimes(1)
    expect(time.pendingSleepCount()).toBe(0)
  })

  it('does not retry errors with a different code or without a code', async () => {
    const notFound = dshError('gateway/endpoint-unknown', 'typert gateway: unknown endpoint')
    const plain = new TypeError('something else went wrong')
    const time = createFakeTime()
    for (const error of [notFound, plain]) {
      const inner = new ScriptedGateway()
      inner.stream.mockRejectedValueOnce(error)
      const gateway = new RetryingGateway(inner, { clock: time.clock, sleep: time.sleep })
      await expect(gateway.stream(listRequest)).rejects.toBe(error)
      expect(inner.stream).toHaveBeenCalledTimes(1)
    }
    expect(time.delays).toEqual([])
  })
})

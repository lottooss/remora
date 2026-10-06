import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createRcpError, RCP_ERROR_CODES, type ControlState } from '@remora/protocol'
import { RcpMethodError, type RcpStreamSink } from '../rcp/index.ts'
import { gatewaySessionControl, type TypertGateway } from './gateway.ts'

/** Real live-agent state, separate from dsh's queue/jobs/projection stream. */
export interface SessionActivitySource {
  snapshot(): ReadonlyMap<string, boolean>
  running(sessionId: string): boolean | undefined
  subscribe(listener: (sessionId: string, running: boolean | undefined) => void): () => void
}

/** Uses the same live Agent status lookup as the pinned Session Controller's list. */
export function createSessionActivitySource(ctx: Context): SessionActivitySource {
  const running = (sessionId: string): boolean | undefined => {
    const id = sessionId as SessionId
    if (!ctx.sessions.get(id)) return undefined
    return ctx.agents.get(id)?.status === 'running'
  }
  return {
    snapshot: () => new Map<string, boolean>(ctx.sessions.list().map((session) => [session.id, ctx.agents.get(session.id)?.status === 'running'])),
    running,
    subscribe(listener) {
      // ctx.on attaches each listener to the plugin fiber; stream cancellation
      // also removes its listeners immediately rather than awaiting unload.
      const disposers = [
        ctx.on('agent/status', ({ agent, status }) => { listener(agent.id, status === 'running') }),
        ctx.on('session/created', (session) => { listener(session.id, running(session.id)) }),
        ctx.on('session/disposed', (session) => { listener(session.id, undefined) }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    },
  }
}

// A baseline cannot fit RCP's 48 KiB limit anywhere near this many rows. Keep
// the in-memory replacement/coalescing maps bounded even before serialization.
const MAX_CONTROL_SESSIONS = 1024

/** Opens without waiting for stream completion; emits complete replacement states. */
export async function openSessionControl(
  gateway: TypertGateway,
  sink: RcpStreamSink,
  activity: SessionActivitySource | undefined,
): Promise<Record<string, unknown>> {
  if (!activity) throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.internal_error, 'session activity source unavailable'))
  const stream = await gatewaySessionControl(gateway, sink.signal)
  sink.signal.throwIfAborted()
  const states = new Map<string, ControlState>()
  // One pending replacement per session prevents an event flood from building
  // an unbounded promise chain while an encrypted transport is backpressured.
  const pending = new Map<string, boolean>()
  let ready = false
  let drainTask: Promise<void> | undefined
  let finished = false
  const fail = async (): Promise<void> => {
    if (finished || sink.signal.aborted) return
    finished = true
    await sink.end(false, createRcpError(RCP_ERROR_CODES.internal_error, 'session control stream failed'))
  }
  const flush = (): Promise<void> => {
    if (!ready || finished) return Promise.resolve()
    if (drainTask) return drainTask
    drainTask = (async () => {
      try {
        for (const [sessionId, removed] of pending) {
          pending.delete(sessionId)
          if (sink.signal.aborted || finished) break
          const state = states.get(sessionId)
          const sent = removed
            ? await sink.sendItem({ type: 'removed', sessionId })
            : state === undefined || await sink.sendItem({ type: 'update', session: state })
          if (!sent) { await fail(); break }
        }
      } catch {
        await fail()
      }
    })().finally(() => {
      drainTask = undefined
      // A listener can enqueue after the last iteration but before this finalizer.
      if (pending.size > 0 && ready && !finished && !sink.signal.aborted) {
        void flush().catch(() => { /* The channel may close during the next drain. */ })
      }
    })
    return drainTask
  }
  const schedule = (sessionId: string, removed = false): void => {
    pending.set(sessionId, removed)
    if (states.size > MAX_CONTROL_SESSIONS || pending.size > MAX_CONTROL_SESSIONS) {
      void fail().catch(() => { /* The channel may already have closed. */ })
      return
    }
    void flush().catch(() => { /* The channel may close while ending the stream. */ })
  }
  const unsubscribe = activity.subscribe((sessionId, running) => {
    if (finished || sink.signal.aborted) return
    if (running === undefined) {
      states.delete(sessionId)
      schedule(sessionId, true)
    } else {
      const previous = states.get(sessionId)
      states.set(sessionId, { sessionId, running, queue: previous?.queue ?? [], jobs: previous?.jobs ?? [] })
      schedule(sessionId)
    }
  })
  sink.signal.addEventListener('abort', unsubscribe, { once: true })

  void (async () => {
    try {
      for await (const raw of stream) {
        if (sink.signal.aborted || finished) break
        const frame = record(raw)
        if (frame['type'] === 'baseline') {
          const baseline = record(frame['value'])
          const queues = record(baseline['queues'])
          const jobs = record(baseline['jobs'])
          states.clear()
          pending.clear()
          for (const [sessionId, running] of activity.snapshot()) {
            states.set(sessionId, {
              sessionId, running,
              queue: mapQueue(queues[sessionId] ?? []),
              jobs: mapJobs(jobs[sessionId] ?? []),
            })
          }
          if (states.size > MAX_CONTROL_SESSIONS) throw new Error('control baseline exceeds limit')
          if (!await sink.sendItem({ type: 'baseline', sessions: [...states.values()] })) { await fail(); break }
          ready = true
          await flush()
        } else if (frame['type'] === 'queue' || frame['type'] === 'jobs') {
          if (!ready) throw new Error('control baseline missing')
          const sessionId = string(frame['sessionId'])
          const running = activity.running(sessionId)
          if (running === undefined) continue // A late replacement cannot resurrect a disposed session.
          const previous = states.get(sessionId)
          states.set(sessionId, {
            sessionId, running,
            queue: frame['type'] === 'queue' ? mapQueue(frame['items']) : previous?.queue ?? [],
            jobs: frame['type'] === 'jobs' ? mapJobs(frame['jobs']) : previous?.jobs ?? [],
          })
          schedule(sessionId)
          await flush()
        }
        // Projection values do not carry live running state. The typed dsh
        // activity listeners above provide it; queue/jobs frames replace only
        // their own component and preserve the other component.
      }
      if (!finished && !sink.signal.aborted) {
        await flush()
        finished = true
        await sink.end(true)
      }
    } catch {
      await fail()
    } finally {
      unsubscribe()
      sink.signal.removeEventListener('abort', unsubscribe)
      states.clear()
      pending.clear()
    }
  })().catch(() => { /* The channel may close while the terminal frame is sent. */ })
  return {}
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid control record')
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid control identifier')
  return value
}

function mapQueue(value: unknown): ControlState['queue'] {
  if (!Array.isArray(value)) throw new Error('invalid control queue')
  return value.map((raw: unknown): ControlState['queue'][number] => {
    const item = record(raw)
    const message = record(item['message'])
    const content = message['content']
    if (!Array.isArray(content)) throw new Error('invalid queued message')
    const text = content.flatMap((part: unknown) => {
      const block = record(part)
      return block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : []
    }).join('\n')
    return { itemId: string(item['id']), text, delivery: item['placement'] === 'steering' ? 'steer' : 'queue' }
  })
}

function mapJobs(value: unknown): ControlState['jobs'] {
  if (!Array.isArray(value)) throw new Error('invalid control jobs')
  return value.map((raw: unknown): ControlState['jobs'][number] => {
    const job = record(raw)
    if (typeof job['label'] !== 'string') throw new Error('invalid job label')
    return { id: string(job['id']), title: job['label'], state: string(job['status']) }
  })
}

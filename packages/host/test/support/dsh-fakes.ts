/**
 * Fakes of the dsh side of the plugin boundary for the `apply()` harness
 * (docs/tasks/P7-H1.md). Only the services dsh itself provides may be faked
 * here: `ctx.typertGateway`, `ctx.credentials`, `ctx.storage` (docs/upstream/
 * dsh-integration.md §4, §7). The unit under test — the host plugin mounted
 * through `apply()` on a real `@deepseek-ai/cordis` Context — is never faked.
 *
 * Services are provided inside their own plugin fibers, the way real dsh
 * provides its services, so the plugin under test resolves them through the
 * Cordis `inject` contract exactly as in the real process. Every fake fails
 * loudly when called: plugin boot must not use these services, and an
 * unexpected call must fail the test instead of passing silently.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertGateway } from '../../src/adapter/gateway.ts'

/** Builds a gateway fake that refuses every call. */
export function createFakeTypertGateway(): TypertGateway {
  const refuse = (method: string) => () => {
    throw new Error(`apply harness: fake typertGateway.${method} must not be called during plugin boot`)
  }
  return {
    invoke: refuse('invoke'),
    stream: refuse('stream'),
  }
}

/**
 * Credentials fake with the record API dsh exposes on `ctx.credentials`
 * (P0-S1 Q4): readRecord / modifyRecord / deleteRecord / describeRecord.
 */
export function createFakeCredentials(): {
  readRecord: () => never
  modifyRecord: () => never
  deleteRecord: () => never
  describeRecord: () => never
} {
  const refuse = (method: string) => () => {
    throw new Error(`apply harness: fake credentials.${method} must not be called during plugin boot`)
  }
  return {
    readRecord: refuse('readRecord'),
    modifyRecord: refuse('modifyRecord'),
    deleteRecord: refuse('deleteRecord'),
    describeRecord: refuse('describeRecord'),
  }
}

/**
 * Storage fake with the domain facility dsh exposes via `ctx.storage.domain`
 * (P0-S1 Q4). Persistence wiring lands with P7-H2/P7-H3.
 */
export function createFakeStorage(): { domain: { open: () => never } } {
  return {
    domain: {
      open: () => {
        throw new Error('apply harness: fake storage.domain.open must not be called during plugin boot')
      },
    },
  }
}

/** The fake dsh services a test asks for; absent keys stay unprovided. */
export interface FakeDshServices {
  typertGateway?: TypertGateway
  credentials?: ReturnType<typeof createFakeCredentials>
  storage?: ReturnType<typeof createFakeStorage>
}

/**
 * Provides the requested fake services on the given context, each inside its
 * own plugin fiber like a real dsh service. Returns once every service fiber
 * is active, so a plugin mounted afterwards sees them (or, for the names left
 * out, stays pending).
 */
export async function provideFakeDshServices(ctx: Context, services: FakeDshServices): Promise<void> {
  const entries = Object.entries(services).filter((entry): entry is [string, object] => entry[1] !== undefined)
  await Promise.all(
    entries.map(([name, value]) => ctx.plugin({ apply: (serviceCtx: Context) => void serviceCtx.provide(name, value) })),
  )
}

/**
 * A port that was free a moment ago and is expected to refuse connections:
 * the relay URL must be unreachable so the harness never opens a real relay
 * socket, and the WebSocket fails fast instead of hanging.
 */
export async function reserveClosedPort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('apply harness: could not reserve a closed local port'))
      })
    })
  })
}

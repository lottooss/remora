/**
 * RCP method registration for files.* methods (RCP/1 §9).
 * - files.read
 * - files.list
 * - files.stat
 * - files.changes (stream)
 *
 * `files.readBytes` was an off-spec host extra: P7-C1 removed it from the
 * method set, P7-H7 deleted the host handler (the adapter's readBytes remains
 * for the FilesAdapter API only).
 */
import {
  FilesReadParamsSchema,
  RCP_ERROR_CODES,
  createRcpError,
} from '@remora/protocol'
import type { FilesAdapter } from '../../adapter/files.ts'
import { RcpMethodError, type RcpServer } from '../index.ts'

function parsePathParams(p: unknown, methodName: string): { sessionId: string; path: string } {
  if (typeof p !== 'object' || p === null) {
    throw new RcpMethodError(
      createRcpError(RCP_ERROR_CODES.invalid_params, `invalid ${methodName} params: expected object`),
    )
  }
  const obj = p as Record<string, unknown>
  if (typeof obj['sessionId'] !== 'string' || !obj['sessionId']) {
    throw new RcpMethodError(
      createRcpError(RCP_ERROR_CODES.invalid_params, `invalid ${methodName} params: missing sessionId`),
    )
  }
  if (typeof obj['path'] !== 'string' || !obj['path']) {
    throw new RcpMethodError(
      createRcpError(RCP_ERROR_CODES.invalid_params, `invalid ${methodName} params: missing path`),
    )
  }
  return { sessionId: obj['sessionId'], path: obj['path'] }
}

function parseChangesParams(p: unknown): { sessionId: string } {
  if (typeof p !== 'object' || p === null) {
    throw new RcpMethodError(
      createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid files.changes params: expected object'),
    )
  }
  const obj = p as Record<string, unknown>
  if (typeof obj['sessionId'] !== 'string' || !obj['sessionId']) {
    throw new RcpMethodError(
      createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid files.changes params: missing sessionId'),
    )
  }
  return { sessionId: obj['sessionId'] }
}

export function registerFilesMethods(rcpServer: RcpServer, adapter: FilesAdapter): void {
  rcpServer.registerMethod('files.read', async (p) => {
    const parsed = FilesReadParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid files.read params'),
      )
    }
    return await adapter.read({
      sessionId: parsed.data.sessionId,
      path: parsed.data.path,
      ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    })
  })

  rcpServer.registerMethod('files.list', async (p) => {
    const parsed = parsePathParams(p, 'files.list')
    return await adapter.list(parsed)
  })

  rcpServer.registerMethod('files.stat', async (p) => {
    const parsed = parsePathParams(p, 'files.stat')
    return await adapter.stat(parsed)
  })

  rcpServer.registerMethod('files.changes', async (p, ctx) => {
    const parsed = parseChangesParams(p)
    if (!ctx.stream) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.internal_error, 'stream sink unavailable'),
      )
    }
    return await adapter.changes(parsed, ctx.stream)
  })
}

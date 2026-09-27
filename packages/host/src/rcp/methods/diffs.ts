/**
 * RCP method registration for diffs.* methods (RCP/1 §9).
 * - diffs.status
 * - diffs.get
 * - diffs.file (alias for diffs.get per RCP/1 §9)
 * - diffs.hunk
 */
import {
  DiffsGetParamsSchema,
  DiffsHunkParamsSchema,
  DiffsStatusParamsSchema,
  RCP_ERROR_CODES,
  createRcpError,
} from '@remora/protocol'
import type { FilesAdapter } from '../../adapter/files.ts'
import { RcpMethodError, type RcpServer } from '../index.ts'

export function registerDiffsMethods(rcpServer: RcpServer, adapter: FilesAdapter): void {
  rcpServer.registerMethod('diffs.status', async (p) => {
    const parsed = DiffsStatusParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid diffs.status params'),
      )
    }
    return await adapter.diffsStatus(parsed.data)
  })

  rcpServer.registerMethod('diffs.get', async (p) => {
    const parsed = DiffsGetParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid diffs.get params'),
      )
    }
    return await adapter.diffsFile(parsed.data)
  })

  // diffs.file is the name in the RCP/1 §9 table, accepting the same params and returning the same result as diffs.get
  rcpServer.registerMethod('diffs.file', async (p) => {
    const parsed = DiffsGetParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid diffs.file params'),
      )
    }
    return await adapter.diffsFile(parsed.data)
  })

  rcpServer.registerMethod('diffs.hunk', async (p) => {
    const parsed = DiffsHunkParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid diffs.hunk params'),
      )
    }
    return await adapter.diffsHunk(parsed.data)
  })
}

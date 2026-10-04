/**
 * RCP method registration for diffs.* methods (RCP/1 §9).
 * - diffs.status
 * - diffs.file
 *
 * `diffs.get` and `diffs.hunk` were off-spec host extras: P7-C1 removed them
 * from the method set, P7-H7 deleted the host handlers (the adapter keeps the
 * underlying operations for the FilesAdapter API only).
 */
import {
  DiffsFileParamsSchema,
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

  rcpServer.registerMethod('diffs.file', async (p) => {
    const parsed = DiffsFileParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid diffs.file params'),
      )
    }
    return await adapter.diffsFile(parsed.data)
  })
}

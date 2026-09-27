import {
  RCP_ERROR_CODES,
  WorkspacesCreateParamsSchema,
  WorkspacesListParamsSchema,
  createRcpError,
} from '@remora/protocol'
import type { WorkspaceAdapter } from '../../adapter/workspaces.ts'
import { RcpMethodError, type RcpServer } from '../index.ts'

export function registerWorkspaceMethods(rcpServer: RcpServer, adapter: WorkspaceAdapter): void {
  rcpServer.registerMethod('workspaces.list', async (p) => {
    const parsed = WorkspacesListParamsSchema.safeParse(p ?? {})
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid workspaces.list params'))
    }
    return await adapter.list()
  })

  rcpServer.registerMethod('workspaces.follow', async (_p, ctx) => {
    if (!ctx.stream) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.internal_error, 'stream sink unavailable'))
    }
    return await adapter.follow(ctx.stream)
  })

  rcpServer.registerMethod('workspaces.create', async (p) => {
    const parsed = WorkspacesCreateParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid workspaces.create params'))
    }
    return await adapter.create(parsed.data)
  })
}

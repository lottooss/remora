import {
  RCP_ERROR_CODES,
  SessionsCancelParamsSchema,
  SessionsCreateParamsSchema,
  SessionsEventTextParamsSchema,
  SessionsFollowParamsSchema,
  SessionsGetParamsSchema,
  SessionsListParamsSchema,
  SessionsPageParamsSchema,
  SessionsPromptParamsSchema,
  SessionsQueueUpdateParamsSchema,
  SessionsRenameParamsSchema,
  SessionsSelectModelParamsSchema,
  SessionsToolOutputParamsSchema,
  createRcpError,
} from '@remora/protocol'
import type { SessionAdapter } from '../../adapter/sessions.ts'
import { RcpMethodError, type RcpServer } from '../index.ts'

function parseSessionsSearchParams(p: unknown): { query: string } {
  if (typeof p !== 'object' || p === null) {
    throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.search params'))
  }
  const query = (p as { query?: unknown }).query
  if (typeof query !== 'string' || query.length < 1 || query.length > 200) {
    throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'query must be between 1 and 200 characters'))
  }
  return { query }
}

export function registerSessionMethods(
  rcpServer: RcpServer,
  adapter: SessionAdapter,
  onSessionAccess?: ((sessionId: string, deviceId: string) => void) | undefined,
): void {
  rcpServer.registerMethod('sessions.create', async (p, ctx) => {
    const parsed = SessionsCreateParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.create params'))
    }
    const result = await adapter.create(parsed.data)
    if (result && typeof (result as { sessionId?: string }).sessionId === 'string') {
      onSessionAccess?.((result as { sessionId: string }).sessionId, ctx.deviceId)
    }
    return result
  })

  rcpServer.registerMethod('sessions.list', async (p) => {
    const parsed = SessionsListParamsSchema.safeParse(p ?? {})
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.list params'))
    }
    return await adapter.list(parsed.data)
  })

  rcpServer.registerMethod('sessions.get', async (p) => {
    const parsed = SessionsGetParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.get params'))
    }
    const page = await adapter.page({
      sessionId: parsed.data.sessionId,
      beforeSeq: Number.MAX_SAFE_INTEGER,
      limit: 50,
    })
    const listRes = await adapter.list({ limit: 100 })
    const found = listRes.items.find((s) => s.id === parsed.data.sessionId)
    if (!found) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.not_found, `session '${parsed.data.sessionId}' not found`),
      )
    }
    return {
      session: found,
      events: page.events,
      hasOlder: page.hasOlder,
    }
  })

  rcpServer.registerMethod('sessions.search', async (p) => {
    const params = parseSessionsSearchParams(p)
    return await adapter.search(params)
  })

  rcpServer.registerMethod('sessions.follow', async (p, ctx) => {
    const parsed = SessionsFollowParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.follow params'))
    }
    if (!ctx.stream) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.internal_error, 'stream sink unavailable'))
    }
    return await adapter.follow(parsed.data, ctx.stream)
  })

  rcpServer.registerMethod('sessions.page', async (p) => {
    const parsed = SessionsPageParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.page params'))
    }
    return await adapter.page(parsed.data)
  })

  rcpServer.registerMethod('sessions.eventText', async (p) => {
    const parsed = SessionsEventTextParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.eventText params'))
    }
    return await adapter.eventText(parsed.data)
  })

  rcpServer.registerMethod('sessions.toolOutput', async (p) => {
    const parsed = SessionsToolOutputParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.toolOutput params'))
    }
    return await adapter.toolOutput(parsed.data)
  })

  rcpServer.registerMethod('sessions.prompt', async (p) => {
    const parsed = SessionsPromptParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.prompt params'))
    }
    return await adapter.prompt(parsed.data)
  })

  rcpServer.registerMethod('sessions.cancel', async (p) => {
    const parsed = SessionsCancelParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.cancel params'))
    }
    return await adapter.cancel(parsed.data)
  })

  rcpServer.registerMethod('sessions.queue.update', async (p) => {
    const parsed = SessionsQueueUpdateParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.queue.update params'))
    }
    return await adapter.queueUpdate(parsed.data)
  })

  rcpServer.registerMethod('sessions.rename', async (p) => {
    const parsed = SessionsRenameParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.rename params'))
    }
    return await adapter.rename(parsed.data)
  })

  rcpServer.registerMethod('sessions.selectModel', async (p) => {
    const parsed = SessionsSelectModelParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid sessions.selectModel params'))
    }
    return await adapter.selectModel(parsed.data)
  })

  rcpServer.registerMethod('sessions.control', async (_p, ctx) => {
    if (!ctx.stream) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.internal_error, 'stream sink unavailable'))
    }
    return await adapter.control(ctx.stream)
  })

  rcpServer.registerMethod('models.catalog', async () => {
    return await adapter.modelCatalog()
  })
}

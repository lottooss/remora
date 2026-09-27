import {
  NotifyPrefsGetParamsSchema,
  NotifyPrefsSchema,
  RCP_ERROR_CODES,
  createRcpError,
} from '@remora/protocol'
import type { NotifyPrefsStore } from '../../notify/prefs.ts'
import { RcpMethodError, type RcpServer } from '../index.ts'

const NotifyPrefsSetPartialSchema = NotifyPrefsSchema.partial()

export function registerNotifyMethods(rcpServer: RcpServer, prefsStore: NotifyPrefsStore): void {
  rcpServer.registerMethod('notify.prefs.get', async (p, ctx) => {
    const parsed = NotifyPrefsGetParamsSchema.safeParse(p ?? {})
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid notify.prefs.get params'))
    }
    return prefsStore.getPrefs(ctx.deviceId)
  })

  rcpServer.registerMethod('notify.prefs.set', async (p, ctx) => {
    const parsed = NotifyPrefsSetPartialSchema.safeParse(p ?? {})
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid notify.prefs.set params'))
    }
    const { approval, question, turnDone, turnError } = parsed.data
    return prefsStore.setPrefs(ctx.deviceId, {
      ...(approval !== undefined ? { approval } : {}),
      ...(question !== undefined ? { question } : {}),
      ...(turnDone !== undefined ? { turnDone } : {}),
      ...(turnError !== undefined ? { turnError } : {}),
    })
  })
}

import { describe, expect, it } from 'vitest'
import {
  AUTH_TIMEOUT_MS,
  DATA_FRAME_HEADER_BYTES,
  HOST_OFFLINE_ALERT_MS,
  MAX_DATA_FRAME_BYTES,
  MAX_DATA_FRAME_PAYLOAD_BYTES,
  MAX_ENDPOINTS,
  MAX_RCP_MESSAGE_BYTES,
  TICKET_TTL_MS,
} from '../src/limits.js'

describe('Protocol Limits', () => {
  it('enforces normative byte limits', () => {
    expect(MAX_RCP_MESSAGE_BYTES).toBe(49_152) // 48 KiB
    expect(MAX_DATA_FRAME_BYTES).toBe(65_536) // 64 KiB
    expect(DATA_FRAME_HEADER_BYTES).toBe(28)
    expect(MAX_DATA_FRAME_PAYLOAD_BYTES).toBe(65_536 - 28)
  })

  it('enforces normative timeout and count limits', () => {
    expect(MAX_ENDPOINTS).toBe(32)
    expect(TICKET_TTL_MS).toBe(600_000)
    expect(AUTH_TIMEOUT_MS).toBe(10_000)
    expect(HOST_OFFLINE_ALERT_MS).toBe(120_000)
  })
})

import { describe, expect, it } from 'vitest'
import {
  DATA_FRAME_HEADER_BYTES,
  MAX_DATA_FRAME_BYTES,
  MAX_RCP_MESSAGE_BYTES,
  RCP_VERSION,
  RLY_SUBPROTOCOL,
  RLY_VERSION,
} from '../src/index.ts'

describe('protocol constants match the v1 specs', () => {
  it('uses version 1 for both protocols', () => {
    expect(RCP_VERSION).toBe(1)
    expect(RLY_VERSION).toBe(1)
    expect(RLY_SUBPROTOCOL).toBe('remora.rly.v1')
  })

  it('keeps an RCP message plus Noise tag and frame header inside one data frame', () => {
    const noiseTagBytes = 16
    const scRecordTypeBytes = 1
    expect(MAX_RCP_MESSAGE_BYTES).toBe(48 * 1024)
    expect(DATA_FRAME_HEADER_BYTES + scRecordTypeBytes + MAX_RCP_MESSAGE_BYTES + noiseTagBytes)
      .toBeLessThanOrEqual(MAX_DATA_FRAME_BYTES)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/main.ts'

describe('remora CLI skeleton', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('prints usage for --help and exits 0', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(main(['--help'])).toBe(0)
    expect(log.mock.calls[0]?.[0]).toMatch(/remora service install/)
  })

  it('names the implementing task for planned commands', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(main(['service', 'install'])).toBe(2)
    expect(error.mock.calls[0]?.[0]).toMatch(/P5-O1/)
  })

  it('rejects unknown commands with a usage error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(main(['frobnicate'])).toBe(64)
  })
})

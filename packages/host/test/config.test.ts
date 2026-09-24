import { describe, expect, it } from 'vitest'
import { type Config, RemoraConfigError, resolveConfig } from '../src/config.ts'

const base: Config = {
  relayUrl: 'https://remora-relay.example.workers.dev',
  enrollSecretKey: 'REMORA_RELAY_ENROLL_SECRET',
  remoteRoots: [],
  approvalBiometric: 'high',
  approvalAuth: 'biometric',
  approvalTimeoutMs: 3_600_000,
  allowRemoteSessionStart: true,
  keepAwake: 'while-busy',
  streamCoalesceMs: 150,
  notify: { approval: true, question: true, turnDone: true, turnError: true, hostOffline: true },
}

describe('resolveConfig', () => {
  it('accepts an https relay and derives its origin', () => {
    const resolved = resolveConfig({ ...base, relayUrl: 'https://remora-relay.example.workers.dev/' })
    expect(resolved.relayOrigin).toBe('https://remora-relay.example.workers.dev')
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('accepts plain http only for a loopback development relay', () => {
    expect(resolveConfig({ ...base, relayUrl: 'http://127.0.0.1:8787' }).relayOrigin).toBe('http://127.0.0.1:8787')
    expect(() => resolveConfig({ ...base, relayUrl: 'http://relay.example.com' })).toThrow(RemoraConfigError)
  })

  it('fails loudly when the relay URL is missing or malformed', () => {
    expect(() => resolveConfig({ ...base, relayUrl: '' })).toThrow(/relayUrl is required/)
    expect(() => resolveConfig({ ...base, relayUrl: 'not a url' })).toThrow(/not a valid URL/)
  })

  it('rejects relative remote roots', () => {
    expect(() => resolveConfig({ ...base, remoteRoots: ['projects'] })).toThrow(/absolute path/)
  })
})

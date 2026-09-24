import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('relay worker skeleton (runs in workerd)', () => {
  it('answers health checks without caching', async () => {
    const res = await SELF.fetch('https://relay.test/v1/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, v: 1 })
  })

  it('routes enrollment to AccountHub, which is not implemented yet', async () => {
    const res = await SELF.fetch('https://relay.test/v1/enroll/host', { method: 'POST' })
    expect(res.status).toBe(501)
    expect(await res.json()).toMatchObject({ task: 'P1-R1', path: '/v1/enroll/host' })
  })

  it('returns 404 for every other path', async () => {
    const res = await SELF.fetch('https://relay.test/admin')
    expect(res.status).toBe(404)
  })
})

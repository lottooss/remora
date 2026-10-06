import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import * as host from '@remora/host'

// Test seam fakes have no runtime Cordis imports, so the context and the
// plugin both use the peer instance installed with this tarball.
const support = new URL(process.argv[1])
const { provideFakeDshServices, createFakeTypertGateway, createFakeStorage, reserveClosedPort } =
  await import(new URL('support/dsh-fakes.ts', support))
const { createHostCredentials } = await import(new URL('relay/fake-credentials.ts', support))
const { createValidHostConfig } = await import(new URL('support/host-config.ts', support))
const requireFromHost = createRequire(import.meta.resolve('@remora/host'))
const { default: koffi } = await import(pathToFileURL(requireFromHost.resolve('koffi')).href)
const setState = koffi.load('kernel32.dll').func('uint32 __stdcall SetThreadExecutionState(uint32 flags)')
const readState = () => {
  const previous = setState(0x80000000)
  assert.notEqual(previous, 0)
  setState(previous)
  return previous
}
const initial = readState()
assert.equal(initial & 1, 0)
const ctx = new Context()
await provideFakeDshServices(ctx, {
  typertGateway: createFakeTypertGateway(), storage: createFakeStorage(),
})
await ctx.plugin({ apply: (serviceCtx) => serviceCtx.provide('credentials', createHostCredentials({
  references: { REMORA_RELAY_ENROLL_SECRET: 'test-keepawake-enroll-secret-not-real' },
})) })
const fiber = await ctx.plugin(host, createValidHostConfig({
  relayUrl: `http://127.0.0.1:${await reserveClosedPort()}`, keepAwake: 'while-busy',
}))
try {
  assert.equal(fiber.state, 2, 'Installed host must mount on real Cordis')
  ctx.emit('agent/status', { agent: { id: 'test-keepawake-root-agent' }, status: 'running' })
  const deadline = Date.now() + 5000
  while ((readState() & 1) === 0 && Date.now() < deadline) await setTimeout(20)
  assert.equal(readState() & 1, 1, 'Installed host never set SYSTEM_REQUIRED')
  const beforeDispose = performance.now()
  await fiber.dispose()
  assert.ok(performance.now() - beforeDispose < 2000)
  assert.equal(readState() & 1, 0, 'Installed host left SYSTEM_REQUIRED after disposal')
  process.stdout.write('packed host native acquisition and disposal complete\n')
} finally {
  await fiber.dispose()
  setState(initial)
}

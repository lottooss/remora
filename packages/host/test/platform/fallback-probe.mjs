import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { setTimeout } from 'node:timers/promises'
import { Win32KeepAwakeDriver } from '../../src/platform/keep-awake-win32.ts'

// Fail the dependency boundary, not the driver or the native helper being tested.
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'koffi') throw new Error('Test: the optional native loader is unavailable')
    return nextResolve(specifier, context)
  },
})
const warnings = []
const driver = new Win32KeepAwakeDriver({ warn: (message) => warnings.push(message) })
async function waitFor(predicate) {
  const deadline = Date.now() + 8000
  while (!predicate() && Date.now() < deadline) await setTimeout(20)
  assert.ok(predicate(), 'Keep-awake did not reach the expected state')
}
try {
  driver.acquire()
  assert.equal(driver.isAcquired, false)
  if (process.platform === 'win32') {
    await waitFor(() => driver.isAcquired)
    driver.acquire()
    driver.acquire()
    assert.equal(warnings.length, 1)
    driver.release()
    // Reacquire before the former child has emitted close. The new request
    // must survive that stale close and wait for a fresh helper confirmation.
    driver.acquire()
    await waitFor(() => !driver.isAcquired)
    await waitFor(() => driver.isAcquired)
    assert.equal(warnings.length, 1, 'Unavailable native loader should warn only once')
  } else {
    await waitFor(() => warnings.length === 2)
    assert.equal(driver.isAcquired, false, 'Unavailable Windows APIs must never report success')
  }
} finally {
  driver.release()
  await waitFor(() => !driver.isAcquired)
  hook.deregister()
}
process.stdout.write('fallback lifecycle complete\n')

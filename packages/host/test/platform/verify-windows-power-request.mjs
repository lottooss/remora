import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { Win32KeepAwakeDriver } from '../../src/platform/keep-awake-win32.ts'

assert.equal(process.platform, 'win32', 'This acceptance check requires Windows')
const executable = basename(process.execPath).toLowerCase()
assert.match(executable, /^remora-keepawake-.+\.exe$/, 'Use a uniquely named node executable so another node process cannot satisfy the check')

function systemRequest(label) {
  const output = execFileSync('powercfg.exe', ['/requests'], { encoding: 'utf8', windowsHide: true })
  process.stdout.write(`${label}\n${output}\n`)
  const system = /^SYSTEM:\s*\r?\n([\s\S]*?)(?=^[A-Z]+:|$(?![\s\S]))/m.exec(output)?.[1]
  assert.ok(system, 'powercfg did not provide a SYSTEM section; administrator access is required')
  return system.toLowerCase().includes(executable)
}

const driver = new Win32KeepAwakeDriver()
try {
  assert.equal(systemRequest('Before acquisition'), false)
  driver.acquire()
  const deadline = Date.now() + 5000
  while (!driver.isAcquired && Date.now() < deadline) await setTimeout(20)
  assert.equal(driver.isAcquired, true, 'The Windows driver did not acquire a request')
  assert.equal(systemRequest('While held'), true, 'The host node process is missing from SYSTEM')
  driver.release()
  assert.equal(driver.isAcquired, false)
  assert.equal(systemRequest('After release'), false, 'The host node process remains under SYSTEM')
} finally {
  driver.release()
}

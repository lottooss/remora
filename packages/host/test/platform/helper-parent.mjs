import { spawnWindowsKeepAwakeHelper } from '../../src/platform/keep-awake-win32-helper.ts'

const helper = spawnWindowsKeepAwakeHelper()
helper.stdout.once('data', () => {
  process.stdout.write(`${helper.pid}\n`)
})
helper.stderr.resume()
helper.stdin.on('error', () => {})
helper.on('error', () => { process.exitCode = 1 })
// Test parent deliberately keeps stdin open until the test terminates this
// process. The helper must observe EOF without a graceful JS cleanup handler.

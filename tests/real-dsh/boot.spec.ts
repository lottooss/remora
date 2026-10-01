/**
 * P7-G1 — the real-dsh boot gate.
 *
 * Boots the real, pinned dsh (`upstream.lock.json#npmVersion`) inside a
 * temporary DSH_HOME with the real @remora/host installed via `dsh plugin
 * add`, against the real relay started with `wrangler dev`, and asserts the
 * plugin starts, reaches the relay, and keeps its identity across a restart.
 *
 * Ground truth only: no mocks of dsh, the host, or the relay; nothing is
 * imported from packages/host/src — the real CLI drives everything.
 *
 * Expected status on main (before P7-H1..H3 land): FAIL, because dsh crashes
 * on boot with `cannot get property "typertGateway" without inject`
 * (host `apply()` declares `inject: []` and reads `(ctx as any).typertGateway`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ALIVE_AFTER_MS, RealDshHarness, newEnrollSecret, type OutputLog } from './harness.ts'

const harness = new RealDshHarness({ enrollSecret: newEnrollSecret() })

/** Log lines that must never appear while the host plugin is running. */
const REMORA_ERROR_LINE = /remora:.*(error|failed)/i
const HOST_STARTED_LINE = /remora: host started \(id: ([^,]+),/

beforeAll(async () => {
  harness.resetArtifacts()
  harness.buildHost()
  harness.installDsh()
  harness.initProfile()
  harness.addHostPlugin()
  await harness.startRelay()
  harness.writeProfilePatch()
}, 900_000)

afterAll(async () => {
  await harness.teardown()
}, 180_000)

/** The boot log must exist once a dsh child was started; typed for assertions. */
function bootLog(): OutputLog {
  const log = harness.lastBootOutput
  if (!log) throw new Error('no dsh boot output was collected; bootDsh() did not run?')
  return log
}

/** Failure message that carries the real dsh output — CI must show the crash text. */
function dshFailure(context: string, exitCode: number | null): string {
  const log = harness.lastBootOutput
  return `${context} (exit code ${exitCode}).\n--- dsh stdout/stderr tail ---\n${log ? log.tail(80) : '<none>'}`
}

describe('real dsh boots @remora/host against the real relay', () => {
  let firstHostId = ''

  test(
    'dsh stays alive and the remora host starts and reaches the relay',
    async () => {
      harness.bootDsh()
      const boot = await harness.waitForBoot()

      if (boot.exited) {
        throw new Error(dshFailure(`dsh exited before staying alive for ${ALIVE_AFTER_MS} ms`, boot.exitCode))
      }

      const output = bootLog().text
      // Record the host id before the relay assertions, so the restart test checks
      // identity persistence (P7-H2) independently of relay enrollment (P7-H3).
      const started = HOST_STARTED_LINE.exec(output)
      expect(started, `no "remora: host started (id: ...)" line in output:\n${output}`).not.toBeNull()
      firstHostId = started?.[1] ?? ''
      expect(firstHostId).not.toBe('')

      expect(output).toContain('remora: relay ready')

      const errorLines = bootLog().lines.filter((line) => REMORA_ERROR_LINE.test(line))
      expect(errorLines).toEqual([])
    },
    180_000,
  )

  test(
    'dsh keeps the same host id across a restart',
    async () => {
      await harness.stopDsh()
      harness.bootDsh()
      const boot = await harness.waitForBoot()

      if (boot.exited) {
        throw new Error(dshFailure('dsh exited after restart before staying alive for 45 s', boot.exitCode))
      }

      const started = HOST_STARTED_LINE.exec(bootLog().text)
      expect(started, `no "remora: host started (id: ...)" line in output:\n${bootLog().text}`).not.toBeNull()
      const secondHostId = started?.[1] ?? ''
      expect(secondHostId).toBe(firstHostId)
    },
    180_000,
  )
})

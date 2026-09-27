import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import {
  ChannelManager,
  DefaultPolicyGuard,
  FilesAdapter,
  GitAdapter,
  HostRelayConnection,
  InMemoryDeviceRegistry,
  RcpServer,
  createHostIdentity,
  enrollHost,
  registerDiffsMethods,
  registerFilesMethods,
  type TypertGateway,
} from '@remora/host'
import { generateKeypair, randomBytes } from '@remora/crypto'
import { E2eEnvironment, FakeDevice } from '@remora/testkit'

describe('End-to-End Files and Diffs with Hardened Git Runner (P4-H2)', () => {
  let env: E2eEnvironment | null = null
  let hostRelay: HostRelayConnection | null = null
  let device: FakeDevice | null = null
  let tempRoot: string
  let canaryFsmonitor: string
  let canaryExternal: string

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'remora-e2e-files-'))
    canaryFsmonitor = path.join(tempRoot, 'canary-fsmonitor.txt')
    canaryExternal = path.join(tempRoot, 'canary-diff-external.txt')
  })

  afterEach(async () => {
    if (device) {
      await device.disconnect()
      device = null
    }
    if (hostRelay) {
      await hostRelay.stop()
      hostRelay = null
    }
    if (env) {
      await env.teardown()
      env = null
    }
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('e2e: device reads files and diffs through secure channel while neutralizing hostile git config', async () => {
    // 1. Initialize git repo with hostile config in tempRoot
    execFileSync('git', ['init'], { cwd: tempRoot })
    execFileSync('git', ['config', 'user.name', 'E2ETester'], { cwd: tempRoot })
    execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: tempRoot })

    // Initial commit (baseline)
    const docFile = path.join(tempRoot, 'document.txt')
    await fs.promises.writeFile(docFile, 'First line\nSecond line\nThird line\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: tempRoot })
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tempRoot })

    // Inject hostile git config AFTER initial commit so test setup doesn't trigger it
    const escapedFsmonitor = canaryFsmonitor.replace(/\\/g, '/')
    const escapedExternal = canaryExternal.replace(/\\/g, '/')
    execFileSync(
      'git',
      [
        'config',
        'core.fsmonitor',
        `node -e "require('node:fs').writeFileSync('${escapedFsmonitor}', '')"`,
      ],
      { cwd: tempRoot },
    )
    execFileSync(
      'git',
      [
        'config',
        'diff.external',
        `node -e "require('node:fs').writeFileSync('${escapedExternal}', '')"`,
      ],
      { cwd: tempRoot },
    )

    // Make an edit (modified) and add an untracked file
    await fs.promises.writeFile(
      docFile,
      'First line\nSecond line MODIFIED\nThird line\nFourth line\n',
      'utf8',
    )
    const newFile = path.join(tempRoot, 'untracked.txt')
    await fs.promises.writeFile(newFile, 'I am new\n', 'utf8')

    // Ensure canary files do not exist prior to Remora invocation
    if (fs.existsSync(canaryFsmonitor)) fs.unlinkSync(canaryFsmonitor)
    if (fs.existsSync(canaryExternal)) fs.unlinkSync(canaryExternal)

    // 2. Start relay and E2E environment
    env = new E2eEnvironment({ useRealDsh: false })
    await env.start()

    const hostIdentity = createHostIdentity()
    await enrollHost(env.relayHttpUrl, env.enrollSecret, hostIdentity, 'E2E-Files-Host')

    const registry = new InMemoryDeviceRegistry()
    const rcpServer = new RcpServer({
      hostId: hostIdentity.hostId,
      hostName: 'E2E-Files-Host',
    })

    const policyGuard = new DefaultPolicyGuard({
      remoteRoots: [tempRoot],
      allowRemoteSessionStart: true,
    })

    const gitAdapter = new GitAdapter()
    const filesAdapter = new FilesAdapter({
      policyGuard,
      gitAdapter,
      sessionLookup: async (sessionId: string) => {
        if (sessionId === 'session-e2e-files') {
          return {
            workspaceRoot: tempRoot,
            events: [],
          }
        }
        return null
      },
    })

    registerFilesMethods(rcpServer, filesAdapter)
    registerDiffsMethods(rcpServer, filesAdapter)

    hostRelay = new HostRelayConnection({
      relayUrl: env.relayWsUrl,
      identity: hostIdentity,
    })

    const channelManager = new ChannelManager({
      identity: hostIdentity,
      registry,
      rcpServer,
      sendFrame: (bytes) => hostRelay!.sendFrameBytes(bytes),
    })

    hostRelay.attachChannelManager(channelManager)
    hostRelay.start()

    await new Promise<void>((resolve) => {
      if (hostRelay!.isConnected) return resolve()
      hostRelay!.link.once('ready', () => resolve())
    })

    // 3. Create and pair fake device
    const deviceNoise = generateKeypair()
    const devicePsk = randomBytes(32)
    device = new FakeDevice({
      noiseKeypair: deviceNoise,
      devicePsk,
      name: 'FilesPhone',
    })

    const ticketRes = await hostRelay.link.request<{ ticket: string }>({ t: 'enroll.ticket' })
    await device.enrollAtRelay(env.relayHttpUrl, ticketRes.ticket)

    registry.addDevice({
      deviceId: device.deviceId,
      name: 'FilesPhone',
      noisePublicKey: deviceNoise.publicKey,
      devicePsk,
      pushKey: new Uint8Array(32),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false,
    })

    await device.connectToRelay(env.relayWsUrl)
    const channel = await device.openSecureChannel({
      hostId: hostIdentity.hostId,
      hostNoisePublicKey: hostIdentity.noiseKeypair.publicKey,
      channelId: 1,
    })

    // 4. Test files.stat over secure channel
    const statRes = await channel.call<{ path: string; version: string; bytes?: number }>('files.stat', {
      sessionId: 'session-e2e-files',
      path: docFile,
    })
    expect(statRes.bytes).toBeGreaterThan(0)
    expect(statRes.version).toBeDefined()

    // 5. Test files.read over secure channel
    const readRes = await channel.call<{
      text: string
      offset: number
      lines: number
      totalLines: number
      eof: boolean
    }>('files.read', {
      sessionId: 'session-e2e-files',
      path: docFile,
      offset: 1,
      limit: 10,
    })
    expect(readRes.offset).toBe(1)
    expect(readRes.lines).toBe(5)
    expect(readRes.eof).toBe(true)
    expect(readRes.text).toContain('Second line MODIFIED')

    // 6. Test files.list over secure channel
    const listRes = await channel.call<{
      entries: { name: string; kind: string }[]
    }>('files.list', {
      sessionId: 'session-e2e-files',
      path: tempRoot,
    })
    const names = listRes.entries.map((e) => e.name)
    expect(names).toContain('document.txt')
    expect(names).toContain('untracked.txt')

    // 7. Test diffs.status over secure channel
    const statusRes = await channel.call<{
      source: string
      branch: string | null
      files: { path: string; status: string }[]
    }>('diffs.status', {
      sessionId: 'session-e2e-files',
    })
    expect(statusRes.source).toBe('git')
    expect(statusRes.files.some((f) => f.path.includes('document.txt') && f.status === 'M')).toBe(
      true,
    )
    expect(statusRes.files.some((f) => f.path.includes('untracked.txt') && f.status === '?')).toBe(
      true,
    )

    // 8. Test diffs.file over secure channel
    const diffRes = await channel.call<{
      binary: boolean
      hunks: { header: string; lines: string[] }[]
    }>('diffs.file', {
      sessionId: 'session-e2e-files',
      path: docFile,
    })
    expect(diffRes.binary).toBe(false)
    expect(diffRes.hunks.length).toBeGreaterThan(0)
    const hunkText = diffRes.hunks.map((h) => h.lines.join('\n')).join('\n')
    expect(hunkText).toContain('+Second line MODIFIED')

    // 9. SECURITY INVARIANT VERIFICATION:
    // Hostile repository configuration MUST NOT have executed!
    expect(fs.existsSync(canaryFsmonitor)).toBe(false)
    expect(fs.existsSync(canaryExternal)).toBe(false)

    // 10. Path Traversal rejection over secure channel
    await expect(
      channel.call('files.read', {
        sessionId: 'session-e2e-files',
        path: path.join(tempRoot, '../../outside/forbidden.txt'),
      }),
    ).rejects.toThrow()
  })
})

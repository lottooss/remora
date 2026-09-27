import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import {
  ChannelManager,
  DefaultPolicyGuard,
  FsAdapter,
  HostRelayConnection,
  InMemoryDeviceRegistry,
  RcpServer,
  SessionAdapter,
  WorkspaceAdapter,
  createHostIdentity,
  enrollHost,
  registerFsMethods,
  registerSessionMethods,
  registerWorkspaceMethods,
  type TypertGateway,
} from '@remora/host'
import { generateKeypair, randomBytes } from '@remora/crypto'
import { E2eEnvironment, FakeDevice } from '@remora/testkit'

describe('End-to-End Workspaces Flow (P4-H1)', () => {
  let env: E2eEnvironment | null = null
  let hostRelay: HostRelayConnection | null = null
  let device: FakeDevice | null = null
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'remora-e2e-ws-'))
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

  it('e2e: device browses root, creates folder, starts session there, and prompts it', async () => {
    env = new E2eEnvironment({ useRealDsh: false })
    await env.start()

    const hostIdentity = createHostIdentity()
    await enrollHost(env.relayHttpUrl, env.enrollSecret, hostIdentity, 'E2E-Workspace-Host')

    const registry = new InMemoryDeviceRegistry()
    const rcpServer = new RcpServer({
      hostId: hostIdentity.hostId,
      hostName: 'E2E-Workspace-Host',
    })

    const policyGuard = new DefaultPolicyGuard({
      remoteRoots: [tempRoot],
      allowRemoteSessionStart: true,
    })

    let promptedSessionId: string | null = null
    let promptedText: string | null = null
    let createdWorkspacePath: string | null = null
    let nextSessionId = 1
    let nextWsId = 1

    const fakeGateway: TypertGateway = {
      invoke: async (req) => {
        if (req.namespace === 'workspace' && req.method === 'create') {
          createdWorkspacePath = req.args['path'] as string
          return {
            workspace: {
              workspaceId: `ws_${nextWsId++}`,
              title: path.basename(createdWorkspacePath),
              path: createdWorkspacePath,
            },
            created: true,
          }
        }
        if (req.namespace === 'directoryPicker' && req.method === 'createDirectory') {
          const parent = req.args['path'] as string
          const name = req.args['name'] as string
          const full = path.join(parent, name)
          await fs.promises.mkdir(full, { recursive: false })
          return full
        }
        if (req.namespace === 'directoryPicker' && req.method === 'list') {
          const target = (req.args['path'] as string) || tempRoot
          const dirents = await fs.promises.readdir(target, { withFileTypes: true })
          return {
            path: target,
            home: os.homedir(),
            crumbs: [{ name: path.basename(target), path: target }],
            entries: dirents.map((d) => ({
              name: d.name,
              path: path.join(target, d.name),
              hidden: d.name.startsWith('.'),
            })),
            truncated: false,
          }
        }
        if (req.namespace === 'session' && req.method === 'create') {
          return { sessionId: `session-e2e-${nextSessionId++}` }
        }
        if (req.namespace === 'session' && req.method === 'prompt') {
          promptedSessionId = (req.args['address'] as any)?.sessionId ?? (req.args['sessionId'] as string)
          promptedText = (req.args['content'] as any)?.[0]?.text
          return { accepted: true }
        }
        return {}
      },
      stream: async function* () {},
    }

    const workspaceAdapter = new WorkspaceAdapter({
      gateway: fakeGateway,
      policyGuard,
    })
    const fsAdapter = new FsAdapter({
      gateway: fakeGateway,
      policyGuard,
    })
    const sessionAdapter = new SessionAdapter({
      gateway: fakeGateway,
      policyGuard,
      workspaceAdapter,
    })

    registerWorkspaceMethods(rcpServer, workspaceAdapter)
    registerFsMethods(rcpServer, fsAdapter)
    registerSessionMethods(rcpServer, sessionAdapter)

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

    // Create and pair fake device
    const deviceNoise = generateKeypair()
    const devicePsk = randomBytes(32)
    device = new FakeDevice({
      noiseKeypair: deviceNoise,
      devicePsk,
      name: 'TestPhone',
    })

    const ticketRes = await hostRelay.link.request<{ ticket: string }>({ t: 'enroll.ticket' })
    await device.enrollAtRelay(env.relayHttpUrl, ticketRes.ticket)

    registry.addDevice({
      deviceId: device.deviceId,
      name: 'TestPhone',
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

    // Step 1: Browse roots (path absent)
    const rootsRes = await channel.call<{
      path: string | null
      parent: string | null
      entries: { name: string; kind: string }[]
      truncated: boolean
    }>('fs.browse', {})

    expect(rootsRes.path).toBeNull()
    expect(rootsRes.entries.length).toBe(1)
    const canonicalRoot = policyGuard.canonicalizePath(tempRoot)
    expect(rootsRes.entries[0]!.name).toBe(canonicalRoot)

    // Step 2: Create a folder inside the root
    const mkdirRes = await channel.call<{ path: string }>('fs.mkdir', {
      parent: canonicalRoot,
      name: 'project-remora-e2e',
      requestId: '11111111-2222-4333-8444-555555555555',
    })

    const createdDirPath = mkdirRes.path
    expect(fs.existsSync(createdDirPath)).toBe(true)

    // Step 3: Start a session in the new folder
    const createSessionRes = await channel.call<{
      sessionId: string
      workspaceId: string
    }>('sessions.create', {
      workspace: { path: createdDirPath },
      requestId: '66666666-7777-4888-8999-000000000000',
    })

    expect(createSessionRes.sessionId).toBe('session-e2e-1')
    expect(createSessionRes.workspaceId).toBeDefined()
    expect(createdWorkspacePath).toBe(createdDirPath)

    // Step 4: Prompt the new session
    const promptRes = await channel.call<{ accepted: boolean; duplicate: boolean }>(
      'sessions.prompt',
      {
        sessionId: createSessionRes.sessionId,
        requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        text: 'Hello from remote Remora device!',
        delivery: 'queue',
      },
    )

    expect(promptRes.accepted).toBe(true)
    expect(promptedSessionId).toBe('session-e2e-1')
    expect(promptedText).toBe('Hello from remote Remora device!')

    // Step 5: Verify workspace list has the workspace with remoteAllowed: true
    const wsListRes = await channel.call<{ workspaces: any[] }>('workspaces.list', {})
    expect(wsListRes.workspaces.length).toBe(1)
    expect(wsListRes.workspaces[0].remoteAllowed).toBe(true)
    expect(wsListRes.workspaces[0].path).toBe(createdDirPath)

    // Step 6: Browse the root again to verify directory listing contains the new folder
    const browseRootRes = await channel.call<{
      path: string | null
      entries: { name: string; kind: string }[]
    }>('fs.browse', { path: canonicalRoot })

    expect(browseRootRes.path).toBe(canonicalRoot)
    expect(browseRootRes.entries.some((e) => e.name === 'project-remora-e2e')).toBe(true)
  })
})

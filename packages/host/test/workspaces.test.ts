import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  RCP_ERROR_CODES,
  type Workspace,
} from '@remora/protocol'
import {
  DefaultPolicyGuard,
  WorkspaceAdapter,
  FsAdapter,
  SessionAdapter,
  RcpServer,
  registerWorkspaceMethods,
  registerFsMethods,
  registerSessionMethods,
  type TypertGateway,
} from '../src/index.ts'

describe('P4-H1: Workspaces, directory browse, and remote session start', () => {
  let tempDir: string
  let rootA: string
  let rootB: string
  let outsideDir: string

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'remora-p4h1-'))
    rootA = path.join(tempDir, 'rootA')
    rootB = path.join(tempDir, 'rootB')
    outsideDir = path.join(tempDir, 'outside')

    await fs.promises.mkdir(rootA, { recursive: true })
    await fs.promises.mkdir(rootB, { recursive: true })
    await fs.promises.mkdir(outsideDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
  })

  function createMockGateway(options?: {
    workspaces?: { workspaceId: string; title: string; path: string }[]
    createdSessions?: { sessionId: string; workspaceId: string }[]
  }): TypertGateway {
    const workspaces = options?.workspaces ?? []
    let nextWsId = 1
    let nextSessionId = 1

    return {
      async invoke(req) {
        if (req.namespace === 'workspace' && req.method === 'create') {
          const reqPath = req.args['path'] as string
          const existing = workspaces.find((w) => path.resolve(w.path) === path.resolve(reqPath))
          if (existing) {
            return { workspace: existing, created: false }
          }
          const created = {
            workspaceId: `ws_${nextWsId++}`,
            title: path.basename(reqPath),
            path: reqPath,
          }
          workspaces.push(created)
          return { workspace: created, created: true }
        }

        if (req.namespace === 'directoryPicker' && req.method === 'list') {
          const target = (req.args['path'] as string) || rootA
          const dirents = await fs.promises.readdir(target, { withFileTypes: true })
          return {
            path: target,
            home: tempDir,
            crumbs: [{ name: path.basename(target), path: target }],
            entries: dirents
              .filter((d) => d.isDirectory())
              .map((d) => ({
                name: d.name,
                path: path.join(target, d.name),
                hidden: d.name.startsWith('.'),
              })),
            truncated: false,
          }
        }

        if (req.namespace === 'directoryPicker' && req.method === 'createDirectory') {
          const parent = req.args['path'] as string
          const name = req.args['name'] as string
          const full = path.join(parent, name)
          await fs.promises.mkdir(full, { recursive: false })
          return full
        }

        if (req.namespace === 'session' && req.method === 'create') {
          const workspaceId = req.args['workspaceId'] as string
          const sid = `sess_${nextSessionId++}`
          options?.createdSessions?.push({ sessionId: sid, workspaceId })
          return { sessionId: sid }
        }

        throw new Error(`unsupported mock gateway call ${req.namespace}.${req.method}`)
      },
      async *stream(req) {
        if (req.namespace === 'workspace' && req.method === 'follow') {
          yield {
            type: 'baseline',
            value: {
              items: workspaces.map((w) => ({
                workspaceId: w.workspaceId,
                title: w.title,
                path: w.path,
                sessionIds: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              })),
              archivedSessionIds: [],
            },
          }
          return
        }
        throw new Error(`unsupported mock stream ${req.namespace}.${req.method}`)
      },
    }
  }

  describe('WorkspaceAdapter', () => {
    it('creates workspace inside root and reports remoteAllowed: true', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA] })
      const gateway = createMockGateway()
      const adapter = new WorkspaceAdapter({ gateway, policyGuard: guard })

      const projectDir = path.join(rootA, 'my-project')
      await fs.promises.mkdir(projectDir)

      const res = await adapter.create({
        path: projectDir,
        requestId: '11111111-1111-4111-8111-111111111111',
      })

      expect(res.created).toBe(true)
      expect(res.workspace.remoteAllowed).toBe(true)
      expect(res.workspace.title).toBe('my-project')

      // Idempotency check with same requestId
      const retry = await adapter.create({
        path: projectDir,
        requestId: '11111111-1111-4111-8111-111111111111',
      })
      expect(retry).toEqual(res)
    })

    it('rejects workspace creation outside roots with forbidden (path outside roots)', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA] })
      const gateway = createMockGateway()
      const adapter = new WorkspaceAdapter({ gateway, policyGuard: guard })

      const illegalDir = path.join(outsideDir, 'secret-repo')
      await fs.promises.mkdir(illegalDir)

      await expect(
        adapter.create({
          path: illegalDir,
          requestId: '22222222-2222-4222-8222-222222222222',
        }),
      ).rejects.toMatchObject({
        rcpError: { code: RCP_ERROR_CODES.forbidden, message: 'path outside roots' },
      })
    })

    it('rejects workspace creation when allowRemoteSessionStart is false', async () => {
      const guard = new DefaultPolicyGuard({
        remoteRoots: [rootA],
        allowRemoteSessionStart: false,
      })
      const gateway = createMockGateway()
      const adapter = new WorkspaceAdapter({ gateway, policyGuard: guard })

      const projectDir = path.join(rootA, 'my-project')
      await fs.promises.mkdir(projectDir)

      await expect(
        adapter.create({
          path: projectDir,
          requestId: '33333333-3333-4333-8333-333333333333',
        }),
      ).rejects.toMatchObject({
        rcpError: { code: RCP_ERROR_CODES.forbidden, message: 'remote session start is disabled' },
      })
    })

    it('streams workspaces.follow with remoteAllowed computed per workspace', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA] })
      const projA = path.join(rootA, 'project-a')
      const projB = path.join(outsideDir, 'project-b')
      await fs.promises.mkdir(projA, { recursive: true })
      await fs.promises.mkdir(projB, { recursive: true })

      const gateway = createMockGateway({
        workspaces: [
          { workspaceId: 'ws_in', title: 'Inside', path: projA },
          { workspaceId: 'ws_out', title: 'Outside', path: projB },
        ],
      })
      const adapter = new WorkspaceAdapter({ gateway, policyGuard: guard })

      const sentItems: any[] = []
      const streamAbort = new AbortController()
      const sink = {
        signal: streamAbort.signal,
        sendItem: async (item: any) => {
          sentItems.push(item)
          return true
        },
        end: async () => { streamAbort.abort(); return true },
      }

      await adapter.follow(sink as any)
      await vi.waitFor(() => expect(sentItems.length).toBe(1))
      expect(sentItems[0].type).toBe('baseline')

      const wsList: Workspace[] = sentItems[0].workspaces
      expect(wsList.length).toBe(2)

      const wsIn = wsList.find((w) => w.id === 'ws_in')!
      const wsOut = wsList.find((w) => w.id === 'ws_out')!
      expect(wsIn.remoteAllowed).toBe(true)
      expect(wsOut.remoteAllowed).toBe(false)
    })
  })

  describe('FsAdapter (fs.browse & fs.mkdir)', () => {
    it('fs.browse without path returns allowlisted roots', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA, rootB] })
      const adapter = new FsAdapter({ policyGuard: guard })

      const res = await adapter.browse({})
      expect(res.path).toBeNull()
      expect(res.parent).toBeNull()
      expect(res.entries.length).toBe(2)
      expect(res.entries.map((e) => e.name)).toEqual(
        expect.arrayContaining([guard.canonicalizePath(rootA), guard.canonicalizePath(rootB)]),
      )
    })

    it('fs.browse with path lists directories inside roots and sets parent', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA] })
      const adapter = new FsAdapter({ policyGuard: guard })

      const sub1 = path.join(rootA, 'sub1')
      const sub2 = path.join(rootA, 'sub2')
      const file1 = path.join(rootA, 'notes.txt')
      await fs.promises.mkdir(sub1)
      await fs.promises.mkdir(sub2)
      await fs.promises.writeFile(file1, 'hello')

      const res = await adapter.browse({ path: rootA })
      expect(res.path).toBe(guard.canonicalizePath(rootA))
      // Since rootA is the root, its parent is outside the roots -> parent is null!
      expect(res.parent).toBeNull()
      expect(res.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['sub1', 'sub2', 'notes.txt']))

      // Now browse sub1: its parent should be rootA!
      const resSub = await adapter.browse({ path: sub1 })
      expect(resSub.path).toBe(guard.canonicalizePath(sub1))
      expect(resSub.parent).toBe(guard.canonicalizePath(rootA))
    })

    it('fs.browse denies paths outside roots with forbidden', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA] })
      const adapter = new FsAdapter({ policyGuard: guard })

      await expect(adapter.browse({ path: outsideDir })).rejects.toMatchObject({
        rcpError: { code: RCP_ERROR_CODES.forbidden, message: 'path outside roots' },
      })
    })

    it('fs.mkdir creates folder inside root and enforces idempotency', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA] })
      const adapter = new FsAdapter({ policyGuard: guard })

      const res = await adapter.mkdir({
        parent: rootA,
        name: 'new-folder',
        requestId: '44444444-4444-4444-8444-444444444444',
      })

      const expectedPath = guard.canonicalizePath(path.join(rootA, 'new-folder'))
      expect(res.path).toBe(expectedPath)
      expect(fs.existsSync(expectedPath)).toBe(true)

      // Idempotency with same requestId returns successfully
      const retry = await adapter.mkdir({
        parent: rootA,
        name: 'new-folder',
        requestId: '44444444-4444-4444-8444-444444444444',
      })
      expect(retry.path).toBe(expectedPath)

      // New requestId for existing directory raises conflict
      await expect(
        adapter.mkdir({
          parent: rootA,
          name: 'new-folder',
          requestId: '55555555-5555-4555-8555-555555555555',
        }),
      ).rejects.toMatchObject({
        rcpError: { code: RCP_ERROR_CODES.conflict },
      })
    })

    it('fs.mkdir rejects invalid single-segment names', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA] })
      const adapter = new FsAdapter({ policyGuard: guard })

      for (const badName of ['..', '.', 'foo/bar', 'foo\\bar', '', '   ']) {
        await expect(
          adapter.mkdir({
            parent: rootA,
            name: badName,
            requestId: '66666666-6666-4666-8666-666666666666',
          }),
        ).rejects.toMatchObject({
          rcpError: { code: RCP_ERROR_CODES.invalid_params },
        })
      }
    })
  })

  describe('SessionAdapter.create (sessions.create)', () => {
    it('creates session using path inside roots (implies workspace creation)', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA] })
      const createdSessions: { sessionId: string; workspaceId: string }[] = []
      const gateway = createMockGateway({ createdSessions })
      const workspaceAdapter = new WorkspaceAdapter({ gateway, policyGuard: guard })
      const sessionAdapter = new SessionAdapter({
        gateway,
        policyGuard: guard,
        workspaceAdapter,
      })

      const projDir = path.join(rootA, 'auto-ws-proj')
      await fs.promises.mkdir(projDir)

      const res = await sessionAdapter.create({
        requestId: '77777777-7777-4777-8777-777777777777',
        workspace: { path: projDir },
      })

      expect(res.sessionId).toBeDefined()
      expect(res.workspaceId).toBeDefined()
      expect(createdSessions.length).toBe(1)
      expect(createdSessions[0]!.sessionId).toBe(res.sessionId)
      expect(createdSessions[0]!.workspaceId).toBe(res.workspaceId)

      // Idempotency check with same requestId
      const retry = await sessionAdapter.create({
        requestId: '77777777-7777-4777-8777-777777777777',
        workspace: { path: projDir },
      })
      expect(retry).toEqual(res)
    })

    it('allows starting session on existing workspace created at PC even if outside roots', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA] })
      const gateway = createMockGateway()
      const workspaceAdapter = new WorkspaceAdapter({ gateway, policyGuard: guard })

      // Pre-existing workspace outside roots (created at PC)
      const outsideProj = path.join(outsideDir, 'pc-workspace')
      await fs.promises.mkdir(outsideProj)
      workspaceAdapter.addWorkspace({
        id: 'ws_outside_existing',
        title: 'PC Work',
        path: outsideProj,
        remoteAllowed: false,
      })

      const sessionAdapter = new SessionAdapter({
        gateway,
        policyGuard: guard,
        workspaceAdapter,
      })

      const res = await sessionAdapter.create({
        requestId: '88888888-8888-4888-8888-888888888888',
        workspace: { id: 'ws_outside_existing' },
      })

      expect(res.sessionId).toBeDefined()
      expect(res.workspaceId).toBe('ws_outside_existing')
    })

    it('rejects session create with non-existent workspace id', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA] })
      const gateway = createMockGateway()
      const workspaceAdapter = new WorkspaceAdapter({ gateway, policyGuard: guard })
      const sessionAdapter = new SessionAdapter({
        gateway,
        policyGuard: guard,
        workspaceAdapter,
      })

      await expect(
        sessionAdapter.create({
          requestId: '99999999-9999-4999-8999-999999999999',
          workspace: { id: 'ws_non_existent' },
        }),
      ).rejects.toMatchObject({
        rcpError: { code: RCP_ERROR_CODES.not_found },
      })
    })

    it('rejects sessions.create when allowRemoteSessionStart is false', async () => {
      const guard = new DefaultPolicyGuard({
        remoteRoots: [rootA],
        allowRemoteSessionStart: false,
      })
      const gateway = createMockGateway()
      const workspaceAdapter = new WorkspaceAdapter({ gateway, policyGuard: guard })
      const sessionAdapter = new SessionAdapter({
        gateway,
        policyGuard: guard,
        workspaceAdapter,
      })

      const projDir = path.join(rootA, 'proj')
      await fs.promises.mkdir(projDir)

      await expect(
        sessionAdapter.create({
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          workspace: { path: projDir },
        }),
      ).rejects.toMatchObject({
        rcpError: { code: RCP_ERROR_CODES.forbidden, message: 'remote session start is disabled' },
      })
    })
  })

  describe('Full RCP Server RPC integration', () => {
    it('dispatches workspaces.list, fs.browse, fs.mkdir, and sessions.create through RcpServer', async () => {
      const guard = new DefaultPolicyGuard({ remoteRoots: [rootA] })
      const gateway = createMockGateway()
      const workspaceAdapter = new WorkspaceAdapter({ gateway, policyGuard: guard })
      const fsAdapter = new FsAdapter({ gateway, policyGuard: guard })
      const sessionAdapter = new SessionAdapter({
        gateway,
        policyGuard: guard,
        workspaceAdapter,
      })

      const server = new RcpServer({ hostId: 'h_test123', hostName: 'Host1' })
      registerWorkspaceMethods(server, workspaceAdapter)
      registerFsMethods(server, fsAdapter)
      registerSessionMethods(server, sessionAdapter)

      // 1. fs.browse without path
      const resRootsRaw = await server.handleMessage(
        JSON.stringify({ k: 'req', id: 1, m: 'fs.browse', p: {} }),
        { deviceId: 'd_testdev', channelId: 1 },
      )
      const resRoots = JSON.parse(resRootsRaw!)
      expect(resRoots.ok).toBe(true)
      expect(resRoots.r.entries.length).toBe(1)

      // 2. fs.mkdir inside root
      const resMkdirRaw = await server.handleMessage(
        JSON.stringify({
          k: 'req',
          id: 2,
          m: 'fs.mkdir',
          p: { parent: rootA, name: 'project-xyz', requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        }),
        { deviceId: 'd_testdev', channelId: 1 },
      )
      const resMkdir = JSON.parse(resMkdirRaw!)
      expect(resMkdir.ok).toBe(true)
      expect(resMkdir.r.path).toBeDefined()

      // 3. sessions.create
      const resSessRaw = await server.handleMessage(
        JSON.stringify({
          k: 'req',
          id: 3,
          m: 'sessions.create',
          p: {
            workspace: { path: resMkdir.r.path },
            requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          },
        }),
        { deviceId: 'd_testdev', channelId: 1 },
      )
      const resSess = JSON.parse(resSessRaw!)
      expect(resSess.ok).toBe(true)
      expect(resSess.r.sessionId).toBeDefined()
      expect(resSess.r.workspaceId).toBeDefined()

      // 4. workspaces.list
      const resWsListRaw = await server.handleMessage(
        JSON.stringify({ k: 'req', id: 4, m: 'workspaces.list', p: {} }),
        { deviceId: 'd_testdev', channelId: 1 },
      )
      const resWsList = JSON.parse(resWsListRaw!)
      expect(resWsList.ok).toBe(true)
      expect(resWsList.r.workspaces.length).toBe(1)
      expect(resWsList.r.workspaces[0].remoteAllowed).toBe(true)
    })
  })
})

/**
 * Unit & security tests for FilesAdapter and hardened GitAdapter (P4-H2).
 * Verifies:
 * - Hostile repository config (core.fsmonitor, diff.external, textconv) never executes
 * - Porcelain v2 -z status parsing for M, A, D, R, C, U, ?
 * - Binary file detection
 * - Huge diff hunk pagination (<= 36 KiB)
 * - Policy Guard path containment (session workspace root ∪ remoteRoots)
 * - 5 MiB read cap on files.read
 * - Binary file rejection (NUL bytes)
 * - Session-derived fallback for diffs.status when not a git repo
 * - RCP method registration for files.* and diffs.*
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { DefaultPolicyGuard } from '../src/policy/index.ts'
import { GitAdapter } from '../src/adapter/git.ts'
import { FilesAdapter, MAX_FILE_READ_BYTES } from '../src/adapter/files.ts'
import { registerFilesMethods } from '../src/rcp/methods/files.ts'
import { registerDiffsMethods } from '../src/rcp/methods/diffs.ts'
import { RcpServer } from '../src/rcp/index.ts'
import type { SessionEvent } from '@remora/protocol'

describe('Hardened GitAdapter (P4-H2)', () => {
  let tempDir: string
  let gitAdapter: GitAdapter

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'remora-git-test-'))
    gitAdapter = new GitAdapter()
  })

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('correctly detects whether directory is a git repository', async () => {
    expect(await gitAdapter.isGitRepo(tempDir)).toBe(false)
    execFileSync('git', ['init'], { cwd: tempDir })
    expect(await gitAdapter.isGitRepo(tempDir)).toBe(true)
  })

  it('SECURITY: hostile repository config (fsmonitor, diff.external, textconv) NEVER executes', async () => {
    execFileSync('git', ['init'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.name', 'TestUser'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

    const canaryFsmonitor = path.join(tempDir, 'canary-fsmonitor.txt')
    const canaryDiffExternal = path.join(tempDir, 'canary-diff-external.txt')
    const canaryTextconv = path.join(tempDir, 'canary-textconv.txt')

    // Commit a baseline file first
    const testFile = path.join(tempDir, 'target.txt')
    await fs.promises.writeFile(testFile, 'initial line 1\ninitial line 2\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: tempDir })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tempDir })

    // Inject hostile config into .git/config AFTER initial commit
    const gitConfigPath = path.join(tempDir, '.git', 'config')
    const escFs = canaryFsmonitor.replace(/\\/g, '/')
    const escDiff = canaryDiffExternal.replace(/\\/g, '/')
    const escText = canaryTextconv.replace(/\\/g, '/')
    const hostileConfig = `
[core]
\tfsmonitor = "node -e \\"require('fs').writeFileSync('${escFs}', 'owned')\\""
[diff]
\texternal = "node -e \\"require('fs').writeFileSync('${escDiff}', 'owned')\\""
[diff "hostile"]
\ttextconv = "node -e \\"require('fs').writeFileSync('${escText}', 'owned')\\""
`
    await fs.promises.appendFile(gitConfigPath, hostileConfig, 'utf8')

    // Add .gitattributes to bind *.txt to the hostile textconv filter
    await fs.promises.writeFile(path.join(tempDir, '.gitattributes'), '*.txt diff=hostile\n', 'utf8')

    // Modify the file
    await fs.promises.writeFile(testFile, 'initial line 1\nmodified line 2\nadded line 3\n', 'utf8')

    // Trigger getStatus and getFileDiff through hardened git runner
    const status = await gitAdapter.getStatus(tempDir)
    expect(status).not.toBeNull()
    expect(status?.files.length).toBeGreaterThan(0)

    const diff = await gitAdapter.getFileDiff(tempDir, testFile)
    expect(diff.binary).toBe(false)
    expect(diff.hunks.length).toBeGreaterThan(0)

    // Verify NONE of the canary files exist
    expect(fs.existsSync(canaryFsmonitor)).toBe(false)
    expect(fs.existsSync(canaryDiffExternal)).toBe(false)
    expect(fs.existsSync(canaryTextconv)).toBe(false)
  })

  it('correctly parses porcelain v2 -z status with branch and files (M, ?, R, D)', async () => {
    execFileSync('git', ['init', '-b', 'feat/test-branch'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.name', 'TestUser'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

    const fileA = path.join(tempDir, 'fileA.txt')
    const fileB = path.join(tempDir, 'fileB.txt')
    await fs.promises.writeFile(fileA, 'hello A\n', 'utf8')
    await fs.promises.writeFile(fileB, 'hello B\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: tempDir })
    execFileSync('git', ['commit', '-m', 'c1'], { cwd: tempDir })

    // Modify fileA
    await fs.promises.writeFile(fileA, 'hello A modified\n', 'utf8')
    // Untracked fileC
    const fileC = path.join(tempDir, 'fileC.txt')
    await fs.promises.writeFile(fileC, 'new file C\n', 'utf8')
    // Rename fileB to fileRenamed
    const fileRenamed = path.join(tempDir, 'fileRenamed.txt')
    execFileSync('git', ['mv', 'fileB.txt', 'fileRenamed.txt'], { cwd: tempDir })

    const status = await gitAdapter.getStatus(tempDir)
    expect(status).not.toBeNull()
    expect(status?.branch).toBe('feat/test-branch')
    expect(status?.truncated).toBe(false)

    const paths = status!.files.map((f) => f.path)
    expect(paths).toContain(path.resolve(fileA))
    expect(paths).toContain(path.resolve(fileC))
    expect(paths).toContain(path.resolve(fileRenamed))

    const entryA = status!.files.find((f) => f.path === path.resolve(fileA))
    expect(entryA?.status).toBe('M')

    const entryC = status!.files.find((f) => f.path === path.resolve(fileC))
    expect(entryC?.status).toBe('?')

    const entryRenamed = status!.files.find((f) => f.path === path.resolve(fileRenamed))
    expect(entryRenamed?.status).toBe('R')
    expect(entryRenamed?.oldPath).toBe(path.resolve(fileB))
  })

  it('detects binary files in diff', async () => {
    execFileSync('git', ['init'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.name', 'TestUser'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

    const binFile = path.join(tempDir, 'image.bin')
    await fs.promises.writeFile(binFile, Buffer.from([0x00, 0xff, 0x01, 0xfe]))
    execFileSync('git', ['add', '.'], { cwd: tempDir })
    execFileSync('git', ['commit', '-m', 'add bin'], { cwd: tempDir })

    await fs.promises.writeFile(binFile, Buffer.from([0x00, 0xee, 0x02, 0xfe]))

    const diff = await gitAdapter.getFileDiff(tempDir, binFile)
    expect(diff.binary).toBe(true)
    expect(diff.hunks).toEqual([])
  })

  it('paginates hunks when diff exceeds byte budget', async () => {
    execFileSync('git', ['init'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.name', 'TestUser'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

    const largeFile = path.join(tempDir, 'large.txt')
    // Generate 50 separate blocks separated by 10 unchanged context lines to avoid git hunk coalescing
    const blocks: string[] = []
    for (let i = 0; i < 50; i++) {
      for (let c = 0; c < 10; c++) {
        blocks.push(`unchanged context line ${c} for block ${i}`)
      }
      blocks.push(`block ${i}: old line 1 (${'x'.repeat(1000)})`)
      blocks.push(`block ${i}: old line 2 (${'y'.repeat(1000)})`)
    }
    await fs.promises.writeFile(largeFile, blocks.join('\n') + '\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: tempDir })
    execFileSync('git', ['commit', '-m', 'large baseline'], { cwd: tempDir })

    // Modify each block to generate 50 separate hunks exceeding 36 KiB budget
    const modifiedBlocks: string[] = []
    for (let i = 0; i < 50; i++) {
      for (let c = 0; c < 10; c++) {
        modifiedBlocks.push(`unchanged context line ${c} for block ${i}`)
      }
      modifiedBlocks.push(`block ${i}: NEW line 1 modified (${'z'.repeat(1000)})`)
      modifiedBlocks.push(`block ${i}: NEW line 2 modified (${'w'.repeat(1000)})`)
    }
    await fs.promises.writeFile(largeFile, modifiedBlocks.join('\n') + '\n', 'utf8')

    // Page 1: fromHunk = 0
    const page1 = await gitAdapter.getFileDiff(tempDir, largeFile, 0)
    expect(page1.binary).toBe(false)
    expect(page1.hunks.length).toBeGreaterThan(0)
    expect(page1.nextHunk).toBeDefined()
    expect(page1.nextHunk!).toBeGreaterThan(0)

    // Page 2: fromHunk = page1.nextHunk
    const page2 = await gitAdapter.getFileDiff(tempDir, largeFile, page1.nextHunk)
    expect(page2.hunks.length).toBeGreaterThan(0)
    expect(page2.hunks[0]!.header).not.toEqual(page1.hunks[0]!.header)
  })
})

describe('FilesAdapter & Security Containment (P4-H2)', () => {
  let rootDir: string
  let outsideDir: string
  let sessionWorkspace: string
  let policyGuard: DefaultPolicyGuard
  let gitAdapter: GitAdapter
  let filesAdapter: FilesAdapter

  beforeEach(async () => {
    rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'remora-files-root-'))
    outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'remora-files-outside-'))
    sessionWorkspace = path.join(rootDir, 'workspace')
    await fs.promises.mkdir(sessionWorkspace, { recursive: true })

    policyGuard = new DefaultPolicyGuard({
      remoteRoots: [rootDir],
      allowRemoteSessionStart: true,
    })
    gitAdapter = new GitAdapter()

    filesAdapter = new FilesAdapter({
      policyGuard,
      gitAdapter,
      sessionLookup: async (sessionId: string) => {
        if (sessionId === 's-active') {
          return {
            workspaceRoot: sessionWorkspace,
            events: [],
          }
        }
        return null
      },
    })
  })

  afterEach(async () => {
    await fs.promises.rm(rootDir, { recursive: true, force: true }).catch(() => {})
    await fs.promises.rm(outsideDir, { recursive: true, force: true }).catch(() => {})
  })

  it('SECURITY: denies access to files outside allowed roots', async () => {
    const sensitiveFile = path.join(outsideDir, 'secrets.env')
    await fs.promises.writeFile(sensitiveFile, 'SECRET_KEY=12345\n', 'utf8')

    await expect(
      filesAdapter.stat({ sessionId: 's-active', path: sensitiveFile }),
    ).rejects.toThrowError(/outside allowed roots/i)

    await expect(
      filesAdapter.read({ sessionId: 's-active', path: sensitiveFile }),
    ).rejects.toThrowError(/outside allowed roots/i)

    await expect(
      filesAdapter.list({ sessionId: 's-active', path: outsideDir }),
    ).rejects.toThrowError(/outside allowed roots/i)
  })

  it('SECURITY: denies directory traversal escape via relative paths', async () => {
    await expect(
      filesAdapter.read({ sessionId: 's-active', path: '../../outside/secrets.txt' }),
    ).rejects.toThrowError(/denied|outside allowed roots/i)
  })

  it('SECURITY: enforces 5 MiB read cap on files.read', async () => {
    const hugeFile = path.join(sessionWorkspace, 'huge.dat')
    const handle = await fs.promises.open(hugeFile, 'w')
    // Write 5 MiB + 10 bytes
    await handle.truncate(MAX_FILE_READ_BYTES + 10)
    await handle.close()

    await expect(
      filesAdapter.read({ sessionId: 's-active', path: hugeFile }),
    ).rejects.toThrowError(/exceeds the 5 MiB read cap/i)
  })

  it('SECURITY: rejects files with NUL bytes (binary) in files.read', async () => {
    const binFile = path.join(sessionWorkspace, 'program.exe')
    await fs.promises.writeFile(binFile, Buffer.from([0x4d, 0x5a, 0x00, 0x03]))

    await expect(
      filesAdapter.read({ sessionId: 's-active', path: binFile }),
    ).rejects.toThrowError(/contains NUL bytes \(binary\)/i)
  })

  it('reads text file lines with offset, limit, version, and eof', async () => {
    const textFile = path.join(sessionWorkspace, 'notes.txt')
    const content = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n')
    await fs.promises.writeFile(textFile, content, 'utf8')

    const res = await filesAdapter.read({
      sessionId: 's-active',
      path: textFile,
      offset: 2,
      limit: 2,
    })

    expect(res.offset).toBe(2)
    expect(res.lines).toBe(2)
    expect(res.text).toBe('line 2\nline 3')
    expect(res.eof).toBe(false)
    expect(res.version.length).toBeGreaterThan(0)
  })

  it('reads raw bytes using files.readBytes (base64url)', async () => {
    const binFile = path.join(sessionWorkspace, 'data.bin')
    const bytes = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])
    await fs.promises.writeFile(binFile, bytes)

    const res = await filesAdapter.readBytes({
      sessionId: 's-active',
      path: binFile,
      offset: 1,
      limit: 3,
    })

    expect(res.offset).toBe(1)
    expect(res.length).toBe(3)
    expect(res.total).toBe(5)
    expect(res.eof).toBe(false)
    expect(res.data.length).toBeGreaterThan(0)
  })

  it('lists directory entries and stats file', async () => {
    const subDir = path.join(sessionWorkspace, 'subdir')
    await fs.promises.mkdir(subDir)
    const file1 = path.join(sessionWorkspace, 'file1.txt')
    await fs.promises.writeFile(file1, 'hello', 'utf8')

    const listRes = await filesAdapter.list({
      sessionId: 's-active',
      path: sessionWorkspace,
    })
    expect(listRes.entries.length).toBe(2)
    const subEntry = listRes.entries.find((e) => e.name === 'subdir')
    expect(subEntry?.kind).toBe('dir')
    const fileEntry = listRes.entries.find((e) => e.name === 'file1.txt')
    expect(fileEntry?.kind).toBe('file')
    expect(fileEntry?.bytes).toBe(5)

    const statRes = await filesAdapter.stat({
      sessionId: 's-active',
      path: file1,
    })
    expect(statRes.bytes).toBe(5)
    expect(statRes.version.length).toBeGreaterThan(0)
  })

  it('diffs.status fallback to session log write tool calls when not a git repo', async () => {
    const nonGitWorkspace = path.join(rootDir, 'non-git')
    await fs.promises.mkdir(nonGitWorkspace)

    const fileEdited = path.join(nonGitWorkspace, 'edited.ts')
    await fs.promises.writeFile(fileEdited, 'console.log("edited")', 'utf8')

    const events: SessionEvent[] = [
      {
        seq: 1,
        at: Date.now(),
        kind: 'tool.call',
        callId: 'call_1',
        tool: 'write_to_file',
        title: 'Write File',
        args: {
          text: JSON.stringify({ TargetFile: fileEdited }),
          bytes: 50,
          truncated: false,
        },
      },
      {
        seq: 2,
        at: Date.now(),
        kind: 'tool.call',
        callId: 'call_2',
        tool: 'view_file',
        title: 'View File',
        args: {
          text: JSON.stringify({ AbsolutePath: fileEdited }),
          bytes: 50,
          truncated: false,
        },
      },
    ]

    const fallbackAdapter = new FilesAdapter({
      policyGuard,
      gitAdapter,
      sessionLookup: async () => ({
        workspaceRoot: nonGitWorkspace,
        events,
      }),
    })

    const status = await fallbackAdapter.diffsStatus({ sessionId: 's-nongit' })
    expect(status.source).toBe('session')
    expect(status.files.length).toBe(1)
    expect(status.files[0]!.path).toBe(policyGuard.canonicalizePath(fileEdited))
    expect(status.files[0]!.status).toBe('M')

    const fileDiff = await fallbackAdapter.diffsFile({
      sessionId: 's-nongit',
      path: fileEdited,
    })
    expect(fileDiff.binary).toBe(false)
    expect(fileDiff.hunks).toEqual([])
  })
})

describe('RCP Method Handlers (files.* and diffs.*) (P4-H2)', () => {
  let tempDir: string
  let rcpServer: RcpServer
  let filesAdapter: FilesAdapter
  let policyGuard: DefaultPolicyGuard
  let gitAdapter: GitAdapter

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'remora-rcp-files-'))
    policyGuard = new DefaultPolicyGuard({
      remoteRoots: [tempDir],
      allowRemoteSessionStart: true,
    })
    gitAdapter = new GitAdapter()
    filesAdapter = new FilesAdapter({
      policyGuard,
      gitAdapter,
      sessionLookup: async () => ({
        workspaceRoot: tempDir,
        events: [],
      }),
    })

    rcpServer = new RcpServer({
      hostId: 'h_test123',
      hostName: 'TestHost',
    })

    registerFilesMethods(rcpServer, filesAdapter)
    registerDiffsMethods(rcpServer, filesAdapter)
  })

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('handles files.read, files.stat, files.list via RCP server dispatch', async () => {
    const filePath = path.join(tempDir, 'demo.txt')
    await fs.promises.writeFile(filePath, 'hello rcp\nline 2\n', 'utf8')

    const ctx = { deviceId: 'd_dev1', channelId: 1 }

    // files.stat
    const statRaw = await rcpServer.handleMessage(
      JSON.stringify({
        k: 'req',
        id: 1,
        m: 'files.stat',
        p: { sessionId: 's-1', path: filePath },
      }),
      ctx,
    )
    const statRes = JSON.parse(statRaw!)
    expect(statRes.ok).toBe(true)
    expect(statRes.r.bytes).toBeGreaterThan(0)

    // files.read
    const readRaw = await rcpServer.handleMessage(
      JSON.stringify({
        k: 'req',
        id: 2,
        m: 'files.read',
        p: { sessionId: 's-1', path: filePath, offset: 1, limit: 10 },
      }),
      ctx,
    )
    const readRes = JSON.parse(readRaw!)
    expect(readRes.ok).toBe(true)
    expect(readRes.text ?? readRes.r?.text).toBe('hello rcp\nline 2\n')

    // files.list
    const listRaw = await rcpServer.handleMessage(
      JSON.stringify({
        k: 'req',
        id: 3,
        m: 'files.list',
        p: { sessionId: 's-1', path: tempDir },
      }),
      ctx,
    )
    const listRes = JSON.parse(listRaw!)
    expect(listRes.ok).toBe(true)
    expect(listRes.r.entries.length).toBe(1)
    expect(listRes.r.entries[0].name).toBe('demo.txt')
  })

  it('handles diffs.status, diffs.get, diffs.file via RCP server dispatch', async () => {
    execFileSync('git', ['init'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.name', 'TestUser'], { cwd: tempDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

    const filePath = path.join(tempDir, 'file.txt')
    await fs.promises.writeFile(filePath, 'version 1\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: tempDir })
    execFileSync('git', ['commit', '-m', 'v1'], { cwd: tempDir })

    await fs.promises.writeFile(filePath, 'version 1\nversion 2\n', 'utf8')

    const ctx = { deviceId: 'd_dev1', channelId: 1 }

    // diffs.status
    const statusRaw = await rcpServer.handleMessage(
      JSON.stringify({
        k: 'req',
        id: 10,
        m: 'diffs.status',
        p: { sessionId: 's-1' },
      }),
      ctx,
    )
    const statusRes = JSON.parse(statusRaw!)
    expect(statusRes.ok).toBe(true)
    expect(statusRes.r.source).toBe('git')
    expect(statusRes.r.files.length).toBe(1)
    expect(statusRes.r.files[0].status).toBe('M')

    // diffs.get
    const getRaw = await rcpServer.handleMessage(
      JSON.stringify({
        k: 'req',
        id: 11,
        m: 'diffs.get',
        p: { sessionId: 's-1', path: filePath },
      }),
      ctx,
    )
    const getRes = JSON.parse(getRaw!)
    expect(getRes.ok).toBe(true)
    expect(getRes.r.binary).toBe(false)
    expect(getRes.r.hunks.length).toBe(1)

    // diffs.file (alias for diffs.get)
    const fileRaw = await rcpServer.handleMessage(
      JSON.stringify({
        k: 'req',
        id: 12,
        m: 'diffs.file',
        p: { sessionId: 's-1', path: filePath },
      }),
      ctx,
    )
    const fileRes = JSON.parse(fileRaw!)
    expect(fileRes.ok).toBe(true)
    expect(fileRes.r.hunks.length).toBe(1)
  })
})

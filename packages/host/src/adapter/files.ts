/**
 * Files and Diffs Adapter (RCP/1 §9, blueprint §8.8, threat model T12 & T17).
 * Implements read-only file access and hardened diffs:
 * - files.list, files.stat, files.read, files.readBytes, files.changes
 * - diffs.status, diffs.get / diffs.file, diffs.hunk
 *
 * Security controls:
 * - Policy Guard containment: reads confined to session workspace root ∪ remoteRoots
 * - 5 MiB read cap on files.read (rejects larger files with too_large)
 * - Binary file rejection in files.read (NUL bytes rejected as bad_request)
 * - Session-derived fallback for diffs.status when not a git repo or git is absent
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  RCP_ERROR_CODES,
  createRcpError,
  type SessionEvent,
} from '@remora/protocol'
import { encodeBase64Url } from '@remora/crypto'
import type { PolicyGuard } from '../policy/index.ts'
import { FILE_WRITE_TOOLS } from '../policy/risk.ts'
import { RcpMethodError, type RcpStreamSink } from '../rcp/index.ts'
import {
  gatewayWorkspaceFilesChanges,
  gatewayWorkspaceFilesList,
  gatewayWorkspaceFilesRead,
  gatewayWorkspaceFilesReadBytes,
  gatewayWorkspaceFilesStat,
  type TypertGateway,
} from './gateway.ts'
import { GitAdapter, type GitFileStatus } from './git.ts'
import type { SessionAdapter } from './sessions.ts'

/** Inclusive byte cap on a complete-file read (5 MiB per RCP/1 §9 & blueprint §8.8). */
export const MAX_FILE_READ_BYTES = 5 * 1024 * 1024

export interface FilesAdapterOptions {
  gateway?: TypertGateway | undefined
  policyGuard: PolicyGuard
  gitAdapter?: GitAdapter | undefined
  sessionAdapter?: SessionAdapter | undefined
  sessionLookup?:
    | ((sessionId: string) => Promise<{ workspaceRoot: string | null; events?: SessionEvent[] | undefined } | null>)
    | undefined
  now?: (() => number) | undefined
}

export class FilesAdapter {
  private readonly gateway?: TypertGateway | undefined
  private readonly policyGuard: PolicyGuard
  private readonly gitAdapter: GitAdapter
  private readonly sessionAdapter?: SessionAdapter | undefined
  private readonly sessionLookup?:
    | ((sessionId: string) => Promise<{ workspaceRoot: string | null; events?: SessionEvent[] | undefined } | null>)
    | undefined

  constructor(options: FilesAdapterOptions) {
    this.gateway = options.gateway
    this.policyGuard = options.policyGuard
    this.gitAdapter = options.gitAdapter ?? new GitAdapter()
    this.sessionAdapter = options.sessionAdapter
    this.sessionLookup = options.sessionLookup
  }

  /**
   * Resolves session details (workspace root, events) and computes allowed roots:
   * allowedRoots = session's workspace root ∪ remoteRoots (blueprint §8.8).
   */
  async resolveSessionContext(sessionId: string): Promise<{
    workspaceRoot: string | null
    events: SessionEvent[]
    allowedRoots: string[]
  }> {
    let details: { workspaceRoot: string | null; events?: SessionEvent[] | undefined } | null = null

    if (this.sessionLookup) {
      details = await this.sessionLookup(sessionId)
    } else if (this.sessionAdapter) {
      details = await this.sessionAdapter.getSessionDetails(sessionId)
    }

    const workspaceRoot = details?.workspaceRoot ? this.policyGuard.canonicalizePath(details.workspaceRoot) : null
    const events = details?.events ?? []

    const allowedRoots: string[] = []
    if (workspaceRoot) {
      allowedRoots.push(workspaceRoot)
    }
    for (const root of this.policyGuard.remoteRoots) {
      if (!allowedRoots.includes(root)) {
        allowedRoots.push(root)
      }
    }

    if (allowedRoots.length === 0) {
      throw new RcpMethodError(
        createRcpError(
          RCP_ERROR_CODES.not_found,
          `session '${sessionId}' has no workspace root and no remote roots configured`,
        ),
      )
    }

    return {
      workspaceRoot,
      events,
      allowedRoots,
    }
  }

  /**
   * Canonicalizes and checks that a requested path is inside allowedRoots.
   */
  resolveAndCheckPath(
    rawPath: string,
    workspaceRoot: string | null,
    allowedRoots: readonly string[],
  ): string {
    let resolved = rawPath
    if (!path.isAbsolute(rawPath)) {
      if (!workspaceRoot) {
        throw new RcpMethodError(
          createRcpError(
            RCP_ERROR_CODES.invalid_request,
            'relative path requires a session with a workspace root',
          ),
        )
      }
      resolved = path.resolve(workspaceRoot, rawPath)
    }

    const canonical = this.policyGuard.canonicalizePath(resolved)
    if (!this.policyGuard.checkPathAccess(canonical, allowedRoots)) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.forbidden, 'path outside allowed roots'),
      )
    }
    return canonical
  }

  /**
   * files.list (RCP/1 §9)
   */
  async list(params: {
    sessionId: string
    path: string
  }): Promise<{
    path: string
    entries: Array<{ name: string; kind: 'dir' | 'file' | 'link'; bytes?: number }>
    truncated: boolean
  }> {
    const { workspaceRoot, allowedRoots } = await this.resolveSessionContext(params.sessionId)
    const canonical = this.resolveAndCheckPath(params.path, workspaceRoot, allowedRoots)

    if (this.gateway) {
      try {
        const listing = await gatewayWorkspaceFilesList(this.gateway, {
          sessionId: params.sessionId,
          path: canonical,
        })
        return {
          path: canonical,
          entries: listing.entries.map((e) => ({
            name: e.name,
            kind: e.type === 'directory' ? 'dir' : e.type === 'file' ? 'file' : 'link',
            ...(e.size !== undefined ? { bytes: e.size } : {}),
          })),
          truncated: listing.truncated,
        }
      } catch (err) {
        if (err instanceof RcpMethodError) throw err
        // Fall back to direct filesystem read
      }
    }

    try {
      const dirents = await fs.promises.readdir(canonical, { withFileTypes: true })
      const entries: Array<{ name: string; kind: 'dir' | 'file' | 'link'; bytes?: number }> = []

      for (const d of dirents) {
        const kind: 'dir' | 'file' | 'link' = d.isDirectory()
          ? 'dir'
          : d.isSymbolicLink()
            ? 'link'
            : 'file'
        let bytes: number | undefined = undefined
        if (kind === 'file') {
          try {
            const st = await fs.promises.stat(path.join(canonical, d.name))
            bytes = st.size
          } catch {
            // Ignore stat failures for single files in listing
          }
        }
        entries.push({
          name: d.name,
          kind,
          ...(bytes !== undefined ? { bytes } : {}),
        })
      }

      entries.sort((a, b) => a.name.localeCompare(b.name))
      const MAX_ENTRIES = 1000
      const truncated = entries.length > MAX_ENTRIES
      if (truncated) {
        entries.splice(MAX_ENTRIES)
      }

      return {
        path: canonical,
        entries,
        truncated,
      }
    } catch (err: unknown) {
      if (err instanceof RcpMethodError) throw err
      const nodeErr = err as { code?: string }
      if (nodeErr.code === 'ENOENT') {
        throw new RcpMethodError(
          createRcpError(RCP_ERROR_CODES.not_found, `directory '${canonical}' not found`),
        )
      }
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.internal_error, 'failed to list directory entries'),
      )
    }
  }

  /**
   * files.stat (RCP/1 §9)
   */
  async stat(params: {
    sessionId: string
    path: string
  }): Promise<{
    path: string
    version: string
    bytes?: number
  }> {
    const { workspaceRoot, allowedRoots } = await this.resolveSessionContext(params.sessionId)
    const canonical = this.resolveAndCheckPath(params.path, workspaceRoot, allowedRoots)

    if (this.gateway) {
      try {
        const st = await gatewayWorkspaceFilesStat(this.gateway, {
          sessionId: params.sessionId,
          path: canonical,
        })
        return {
          path: canonical,
          version: st.version,
          ...(st.bytes !== undefined ? { bytes: st.bytes } : {}),
        }
      } catch (err) {
        if (err instanceof RcpMethodError) throw err
        // Fall back to direct filesystem stat
      }
    }

    try {
      const st = await fs.promises.stat(canonical)
      return {
        path: canonical,
        version: `${Math.round(st.mtimeMs)}-${st.size}`,
        bytes: st.size,
      }
    } catch (err: unknown) {
      if (err instanceof RcpMethodError) throw err
      const nodeErr = err as { code?: string }
      if (nodeErr.code === 'ENOENT') {
        throw new RcpMethodError(
          createRcpError(RCP_ERROR_CODES.not_found, `file '${canonical}' not found`),
        )
      }
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.internal_error, 'failed to stat file'),
      )
    }
  }

  /**
   * files.read (RCP/1 §9)
   * Enforces 5 MiB read cap and rejects binary files containing NUL bytes.
   */
  async read(params: {
    sessionId: string
    path: string
    offset?: number | undefined
    limit?: number | undefined
  }): Promise<{
    path: string
    version: string
    offset: number
    text: string
    lines: number
    eof: boolean
    bytes?: number
  }> {
    const { workspaceRoot, allowedRoots } = await this.resolveSessionContext(params.sessionId)
    const canonical = this.resolveAndCheckPath(params.path, workspaceRoot, allowedRoots)

    let fileStat: fs.Stats
    try {
      fileStat = await fs.promises.stat(canonical)
    } catch (err: unknown) {
      const nodeErr = err as { code?: string }
      if (nodeErr.code === 'ENOENT') {
        throw new RcpMethodError(
          createRcpError(RCP_ERROR_CODES.not_found, `file '${canonical}' not found`),
        )
      }
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.internal_error, 'failed to access file'),
      )
    }

    // 5 MiB read cap (blueprint §8.8, RCP/1 §9)
    if (fileStat.size > MAX_FILE_READ_BYTES) {
      throw new RcpMethodError(
        createRcpError(
          RCP_ERROR_CODES.too_large,
          `file "${canonical}" exceeds the 5 MiB read cap`,
          { path: canonical, limit: MAX_FILE_READ_BYTES },
        ),
      )
    }

    const offset = Math.max(1, params.offset ?? 1)
    const limit = Math.min(400, Math.max(1, params.limit ?? 100))

    if (this.gateway) {
      try {
        const textRes = await gatewayWorkspaceFilesRead(this.gateway, {
          sessionId: params.sessionId,
          path: canonical,
          range: { offset, limit },
        })
        return {
          path: canonical,
          version: textRes.version,
          offset: textRes.offset,
          text: textRes.text,
          lines: textRes.lines,
          eof: textRes.eof,
          ...(textRes.bytes !== undefined ? { bytes: textRes.bytes } : {}),
        }
      } catch (err) {
        if (err instanceof RcpMethodError) throw err
        // Fall back to direct filesystem read
      }
    }

    const buffer = await fs.promises.readFile(canonical)

    // Binary check: NUL byte presence
    if (buffer.includes(0)) {
      throw new RcpMethodError(
        createRcpError(
          RCP_ERROR_CODES.invalid_params,
          `file "${canonical}" contains NUL bytes (binary)`,
          { path: canonical },
        ),
      )
    }

    const fullText = buffer.toString('utf8')
    const allLines = fullText.length === 0 ? [] : fullText.split(/\r?\n/)
    const startIndex = offset - 1
    const slicedLines = allLines.slice(startIndex, startIndex + limit)
    const eof = startIndex + limit >= allLines.length

    return {
      path: canonical,
      version: `${Math.round(fileStat.mtimeMs)}-${fileStat.size}`,
      offset,
      text: slicedLines.join('\n'),
      lines: slicedLines.length,
      eof,
      bytes: fileStat.size,
    }
  }

  /**
   * files.readBytes (RCP/1 §9)
   */
  async readBytes(params: {
    sessionId: string
    path: string
    offset: number
    limit?: number | undefined
  }): Promise<{
    path: string
    version: string
    offset: number
    length: number
    data: string
    total: number
    eof: boolean
  }> {
    const { workspaceRoot, allowedRoots } = await this.resolveSessionContext(params.sessionId)
    const canonical = this.resolveAndCheckPath(params.path, workspaceRoot, allowedRoots)

    let fileStat: fs.Stats
    try {
      fileStat = await fs.promises.stat(canonical)
    } catch (err: unknown) {
      const nodeErr = err as { code?: string }
      if (nodeErr.code === 'ENOENT') {
        throw new RcpMethodError(
          createRcpError(RCP_ERROR_CODES.not_found, `file '${canonical}' not found`),
        )
      }
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.internal_error, 'failed to access file'),
      )
    }

    const offset = Math.max(0, params.offset)
    const limit = Math.min(32_768, Math.max(1, params.limit ?? 32_768))

    if (this.gateway) {
      try {
        const rawRes = await gatewayWorkspaceFilesReadBytes(this.gateway, {
          sessionId: params.sessionId,
          path: canonical,
          range: { offset, length: limit },
        })
        const dataBuffer = Buffer.from(rawRes.data, 'base64')
        return {
          path: canonical,
          version: rawRes.version,
          offset: rawRes.offset,
          length: dataBuffer.length,
          data: encodeBase64Url(dataBuffer),
          total: fileStat.size,
          eof: rawRes.eof,
        }
      } catch (err) {
        if (err instanceof RcpMethodError) throw err
        // Fall back to direct filesystem read
      }
    }

    const handle = await fs.promises.open(canonical, 'r')
    try {
      const chunk = Buffer.alloc(limit)
      const { bytesRead } = await handle.read(chunk, 0, limit, offset)
      const dataSlice = chunk.subarray(0, bytesRead)
      const eof = offset + bytesRead >= fileStat.size

      return {
        path: canonical,
        version: `${Math.round(fileStat.mtimeMs)}-${fileStat.size}`,
        offset,
        length: bytesRead,
        data: encodeBase64Url(dataSlice),
        total: fileStat.size,
        eof,
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * files.changes (RCP/1 §9 stream)
   */
  async changes(params: { sessionId: string }, sink: RcpStreamSink): Promise<void> {
    await this.resolveSessionContext(params.sessionId)

    if (this.gateway) {
      try {
        const stream = await gatewayWorkspaceFilesChanges(this.gateway, {
          sessionId: params.sessionId,
        }, sink.signal)

        for await (const frame of stream) {
          if (sink.signal.aborted) break
          if (!frame || typeof frame !== 'object') continue
          const f = frame as { kind?: string; change?: { absolutePath?: string } }
          if (f.kind === 'ready') {
            await sink.sendItem({ type: 'ready' })
          } else if (f.kind === 'change' && f.change?.absolutePath) {
            await sink.sendItem({
              type: 'changed',
              paths: [f.change.absolutePath],
            })
          }
        }
        await sink.end(true)
        return
      } catch {
        // Fall back to static ready frame
      }
    }

    await sink.sendItem({ type: 'ready' })
    await new Promise<void>((resolve) => {
      sink.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    await sink.end(true)
  }

  /**
   * diffs.status (RCP/1 §9)
   * Uses git status if in a git repository; otherwise falls back to files touched
   * by write/edit tool calls in the session event log (blueprint §8.8).
   */
  async diffsStatus(params: { sessionId: string }): Promise<{
    source: 'git' | 'session'
    branch?: string | undefined
    files: Array<{
      path: string
      status: GitFileStatus
      oldPath?: string | undefined
      adds?: number | undefined
      dels?: number | undefined
    }>
    truncated: boolean
  }> {
    const { workspaceRoot, events, allowedRoots } = await this.resolveSessionContext(params.sessionId)

    if (workspaceRoot && (await this.gitAdapter.isGitRepo(workspaceRoot))) {
      const gitStatus = await this.gitAdapter.getStatus(workspaceRoot)
      if (gitStatus !== null) {
        return {
          source: 'git',
          ...(gitStatus.branch !== undefined ? { branch: gitStatus.branch } : {}),
          files: gitStatus.files,
          truncated: gitStatus.truncated,
        }
      }
    }

    // Fallback: extract touched files from write/edit tool calls in the session event log
    const touchedPaths = this.extractTouchedFilesFromEvents(events, workspaceRoot, allowedRoots)
    const files = touchedPaths.map((p) => ({
      path: p,
      status: 'M' as GitFileStatus,
    }))

    return {
      source: 'session',
      files,
      truncated: false,
    }
  }

  /**
   * diffs.get / diffs.file (RCP/1 §9)
   * Hardened git unified diff with hunk pagination.
   */
  async diffsFile(params: {
    sessionId: string
    path: string
    fromHunk?: number | undefined
  }): Promise<{
    path: string
    binary: boolean
    hunks: Array<{ header: string; lines: string[] }>
    nextHunk?: number | undefined
  }> {
    const { workspaceRoot, allowedRoots } = await this.resolveSessionContext(params.sessionId)
    const canonical = this.resolveAndCheckPath(params.path, workspaceRoot, allowedRoots)

    if (workspaceRoot && (await this.gitAdapter.isGitRepo(workspaceRoot))) {
      return await this.gitAdapter.getFileDiff(workspaceRoot, canonical, params.fromHunk)
    }

    // Non-git workspace fallback: no hunks (blueprint §8.8)
    return {
      path: canonical,
      binary: false,
      hunks: [],
    }
  }

  /**
   * diffs.hunk (RCP/1 §9)
   */
  async diffsHunk(params: {
    sessionId: string
    path: string
    hunk: number
  }): Promise<{
    path: string
    hunk: number
    header: string
    lines: string[]
    binary: boolean
  }> {
    const fileDiff = await this.diffsFile({
      sessionId: params.sessionId,
      path: params.path,
      fromHunk: params.hunk,
    })

    if (fileDiff.binary) {
      return {
        path: fileDiff.path,
        hunk: params.hunk,
        header: '',
        lines: [],
        binary: true,
      }
    }

    const hunk = fileDiff.hunks[0]
    return {
      path: fileDiff.path,
      hunk: params.hunk,
      header: hunk?.header ?? '',
      lines: hunk?.lines ?? [],
      binary: false,
    }
  }

  /**
   * Extracts target file paths modified by file-write tools in session events.
   */
  private extractTouchedFilesFromEvents(
    events: readonly SessionEvent[],
    workspaceRoot: string | null,
    allowedRoots: readonly string[],
  ): string[] {
    const touched = new Set<string>()

    for (const evt of events) {
      if (evt.kind !== 'tool.call') continue
      const isWrite = FILE_WRITE_TOOLS.has(evt.tool) || /write|edit|replace|patch/i.test(evt.tool)
      if (!isWrite) continue

      const extracted = this.extractPathFromToolArgs(evt.args.text)
      if (extracted) {
        try {
          const canonical = this.resolveAndCheckPath(extracted, workspaceRoot, allowedRoots)
          touched.add(canonical)
        } catch {
          // Path outside roots or invalid, ignore
        }
      }
    }

    return Array.from(touched).sort()
  }

  private extractPathFromToolArgs(argsText: string): string | null {
    if (!argsText) return null

    try {
      const parsed = JSON.parse(argsText) as Record<string, unknown>
      const cand =
        parsed.targetFile ??
        parsed.TargetFile ??
        parsed.path ??
        parsed.filePath ??
        parsed.file ??
        parsed.destination ??
        parsed.target
      if (typeof cand === 'string' && cand.trim().length > 0) {
        return cand.trim()
      }
    } catch {
      // Regex fallback for truncated or non-strict JSON previews
      const match = /["'](?:TargetFile|targetFile|filePath|path|file|destination|target)["']\s*:\s*["']([^"']+)["']/i.exec(
        argsText,
      )
      if (match?.[1]) {
        return match[1].trim()
      }
    }

    return null
  }
}

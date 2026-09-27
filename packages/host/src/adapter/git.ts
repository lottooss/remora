/**
 * Hardened Git Runner for Remora Host (docs/specs/rcp-v1.md §9, blueprint §8.8).
 * Spawns git with security flags to prevent execution of hostile repository configs:
 * - -c core.fsmonitor=false: disables arbitrary fsmonitor executable execution
 * - -c core.hooksPath=<empty temp dir>: isolates hooks from repository hooks
 * - --no-optional-locks: avoids index locking conflicts
 * - --no-ext-diff: disables diff.external executable invocation
 * - --no-textconv: disables filter.*.textconv helper execution
 * - --no-color: ensures clean, unstyled output
 *
 * Implements:
 * - 5 s timeout
 * - 1 MiB stdout buffer cap
 * - -z NUL-delimited parsing for robust path handling
 * - Hunk pagination bounded to <= 36 KiB (fits within 48 KiB RCP limit)
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Max buffer size for git outputs (1 MiB per blueprint §8.8). */
export const GIT_MAX_BUFFER = 1024 * 1024

/** Timeout for git process execution (5 seconds per blueprint §8.8). */
export const GIT_TIMEOUT_MS = 5000

/** Target max serialized byte budget for hunks in a single diffs.file response (36 KiB). */
export const MAX_HUNKS_BYTE_BUDGET = 36_000

export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?'

export interface GitStatusEntry {
  path: string
  status: GitFileStatus
  oldPath?: string | undefined
  adds?: number | undefined
  dels?: number | undefined
}

export interface GitStatusResult {
  branch?: string | undefined
  files: GitStatusEntry[]
  truncated: boolean
}

export interface GitDiffHunk {
  header: string
  lines: string[]
}

export interface GitDiffResult {
  path: string
  binary: boolean
  hunks: GitDiffHunk[]
  nextHunk?: number | undefined
}

export class GitAdapter {
  private emptyHooksDir: string | null = null

  /**
   * Lazily creates and returns a clean, empty temporary directory for core.hooksPath.
   */
  getEmptyHooksDir(): string {
    if (!this.emptyHooksDir || !fs.existsSync(this.emptyHooksDir)) {
      const dir = path.join(os.tmpdir(), 'remora-git-empty-hooks')
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      this.emptyHooksDir = dir
    }
    return this.emptyHooksDir
  }

  /**
   * Spawns git with mandatory security hardening flags.
   */
  async execGit(
    cwd: string,
    args: string[],
    options?: { timeoutMs?: number | undefined; maxBuffer?: number | undefined },
  ): Promise<string> {
    const hooksDir = this.getEmptyHooksDir()
    const hardenedArgs = [
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${hooksDir}`,
      '--no-optional-locks',
      ...args,
    ]

    try {
      const { stdout } = await execFileAsync('git', hardenedArgs, {
        cwd,
        timeout: options?.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: options?.maxBuffer ?? GIT_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      })
      return stdout
    } catch (err: unknown) {
      const childErr = err as { code?: number | string; stdout?: string; stderr?: string }
      // git diff exits with code 1 when differences are found. This is normal stdout.
      if (childErr.code === 1 && typeof childErr.stdout === 'string') {
        return childErr.stdout
      }
      throw err
    }
  }

  /**
   * Checks whether the given directory is inside a git working tree.
   */
  async isGitRepo(cwd: string): Promise<boolean> {
    try {
      const stdout = await this.execGit(cwd, ['rev-parse', '--is-inside-work-tree'])
      return stdout.trim() === 'true'
    } catch {
      return false
    }
  }

  /**
   * Retrieves repository status via `git status --porcelain=v2 --branch -z`.
   * Returns null if cwd is not a git repository.
   */
  async getStatus(cwd: string): Promise<GitStatusResult | null> {
    let stdout: string
    let truncated = false
    try {
      stdout = await this.execGit(cwd, ['status', '--porcelain=v2', '--branch', '-z'])
    } catch (err: unknown) {
      const childErr = err as { code?: number | string; stdout?: string }
      if (childErr.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        truncated = true
        stdout = childErr.stdout ?? ''
      } else {
        // Not a git repository or git unavailable
        return null
      }
    }

    return this.parseStatusV2(stdout, cwd, truncated)
  }

  /**
   * Parses porcelain v2 -z status output.
   */
  parseStatusV2(stdout: string, cwd: string, initialTruncated = false): GitStatusResult {
    let branch: string | undefined = undefined
    const files: GitStatusEntry[] = []
    let truncated = initialTruncated

    // Tokens are separated by NUL byte
    const tokens = stdout.split('\0')

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (!token || token.length === 0) continue

      if (token.startsWith('# branch.head ')) {
        const b = token.slice('# branch.head '.length).trim()
        if (b && b !== '(detached)') {
          branch = b
        }
        continue
      }

      if (token.startsWith('#')) {
        // Other branch metadata header (# branch.oid, # branch.upstream, etc.)
        continue
      }

      if (token.startsWith('1 ')) {
        // Ordinary changed entry: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        // 8 space delimiters before <path>
        let spaceCount = 0
        let pathStart = -1
        for (let j = 0; j < token.length; j++) {
          if (token[j] === ' ') {
            spaceCount++
            if (spaceCount === 8) {
              pathStart = j + 1
              break
            }
          }
        }
        if (pathStart !== -1) {
          const prefixParts = token.slice(0, pathStart - 1).split(' ')
          const xy = prefixParts[1] ?? '..'
          const relPath = token.slice(pathStart)
          const status = this.mapXyToStatus(xy)
          files.push({
            path: path.resolve(cwd, relPath),
            status,
          })
        }
        continue
      }

      if (token.startsWith('2 ')) {
        // Renamed/copied entry: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
        // 9 space delimiters before <path>, next token is <origPath>
        let spaceCount = 0
        let pathStart = -1
        for (let j = 0; j < token.length; j++) {
          if (token[j] === ' ') {
            spaceCount++
            if (spaceCount === 9) {
              pathStart = j + 1
              break
            }
          }
        }
        if (pathStart !== -1) {
          const prefixParts = token.slice(0, pathStart - 1).split(' ')
          const xy = prefixParts[1] ?? '..'
          const relPath = token.slice(pathStart)
          // Next token is <origPath>
          i++
          const origRelPath = tokens[i] ?? ''
          const status: GitFileStatus = xy.includes('R') ? 'R' : 'C'
          files.push({
            path: path.resolve(cwd, relPath),
            status,
            ...(origRelPath ? { oldPath: path.resolve(cwd, origRelPath) } : {}),
          })
        }
        continue
      }

      if (token.startsWith('u ')) {
        // Unmerged entry
        const lastSpace = token.lastIndexOf(' ')
        if (lastSpace !== -1) {
          const relPath = token.slice(lastSpace + 1)
          files.push({
            path: path.resolve(cwd, relPath),
            status: 'U',
          })
        }
        continue
      }

      if (token.startsWith('? ')) {
        // Untracked entry: ? <path>
        const relPath = token.slice(2)
        files.push({
          path: path.resolve(cwd, relPath),
          status: '?',
        })
        continue
      }
    }

    // Sort files by path for deterministic results
    files.sort((a, b) => a.path.localeCompare(b.path))

    // Max 500 files per status response
    const MAX_FILES = 500
    if (files.length > MAX_FILES) {
      truncated = true
      files.splice(MAX_FILES)
    }

    return {
      ...(branch !== undefined ? { branch } : {}),
      files,
      truncated,
    }
  }

  private mapXyToStatus(xy: string): GitFileStatus {
    const x = xy[0] ?? '.'
    const y = xy[1] ?? '.'
    if (x === 'D' || y === 'D') return 'D'
    if (x === 'A' || y === 'A') return 'A'
    if (x === 'M' || y === 'M') return 'M'
    if (x === 'R' || y === 'R') return 'R'
    if (x === 'C' || y === 'C') return 'C'
    if (x === 'U' || y === 'U') return 'U'
    return 'M'
  }

  /**
   * Retrieves unified diff for a single file with hunk pagination.
   * Hardened with --no-ext-diff, --no-textconv, --no-color.
   */
  async getFileDiff(
    cwd: string,
    targetPath: string,
    fromHunk = 0,
  ): Promise<GitDiffResult> {
    const absolutePath = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath)

    let rawDiff = ''

    // First attempt: diff against HEAD (covers staged and unstaged changes)
    try {
      rawDiff = await this.execGit(cwd, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '-U3',
        'HEAD',
        '--',
        absolutePath,
      ])
    } catch {
      // HEAD may not exist (initial commit repository)
      try {
        // Try cached + working tree diffs
        const cached = await this.execGit(cwd, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '-U3',
          '--cached',
          '--',
          absolutePath,
        ])
        const unstaged = await this.execGit(cwd, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '-U3',
          '--',
          absolutePath,
        ])
        rawDiff = [cached, unstaged].filter(Boolean).join('\n')
      } catch {
        rawDiff = ''
      }
    }

    // If still empty, check if file is untracked (diff against /dev/null using --no-index)
    if (!rawDiff.trim() && fs.existsSync(absolutePath)) {
      try {
        rawDiff = await this.execGit(cwd, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '-U3',
          '--no-index',
          '--',
          '/dev/null',
          absolutePath,
        ])
      } catch {
        // Failed or binary
      }
    }

    // Check for binary diff indicators
    const isBinary =
      rawDiff.includes('Binary files ') ||
      rawDiff.includes('GIT binary patch') ||
      rawDiff.includes('\0')

    if (isBinary) {
      return {
        path: absolutePath,
        binary: true,
        hunks: [],
      }
    }

    // Parse hunks from unified diff output
    const allHunks = this.parseUnifiedDiffHunks(rawDiff)
    const startIndex = Math.max(0, fromHunk)
    const candidates = allHunks.slice(startIndex)

    const resultHunks: GitDiffHunk[] = []
    let currentBytes = 0
    let nextHunk: number | undefined = undefined

    for (let i = 0; i < candidates.length; i++) {
      const hunk = candidates[i]!
      const hunkBytes = Buffer.byteLength(JSON.stringify(hunk), 'utf8')

      if (resultHunks.length > 0 && currentBytes + hunkBytes > MAX_HUNKS_BYTE_BUDGET) {
        nextHunk = startIndex + i
        break
      }

      resultHunks.push(hunk)
      currentBytes += hunkBytes
    }

    return {
      path: absolutePath,
      binary: false,
      hunks: resultHunks,
      ...(nextHunk !== undefined ? { nextHunk } : {}),
    }
  }

  /**
   * Parses standard unified diff output into structured hunks.
   */
  private parseUnifiedDiffHunks(diffText: string): GitDiffHunk[] {
    const hunks: GitDiffHunk[] = []
    const lines = diffText.split(/\r?\n/)
    let currentHunk: GitDiffHunk | null = null

    for (const line of lines) {
      if (line.startsWith('@@ ')) {
        if (currentHunk) {
          hunks.push(currentHunk)
        }
        currentHunk = { header: line, lines: [] }
      } else if (currentHunk) {
        // Lines inside hunk start with ' ', '+', '-', or '\'
        if (
          line.startsWith(' ') ||
          line.startsWith('+') ||
          line.startsWith('-') ||
          line.startsWith('\\')
        ) {
          currentHunk.lines.push(line)
        }
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk)
    }

    return hunks
  }
}

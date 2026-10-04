/**
 * P7-H8 packaging contract (docs/tasks/P7-H8.md): the packed `@remora/host`
 * tarball is self-contained and the host build never silently externalizes an
 * `@remora/*` import.
 *
 * The test reproduces a clean checkout instead of trusting the local
 * workspace: it copies the workspace sources (git-tracked and untracked
 * non-ignored files, so no `lib/`, `node_modules/` or tarballs) into a temp
 * directory, installs from the lockfile, and runs only the host's own `build`
 * script — none of the sibling `@remora/*` packages has been built there.
 * It then packs the host, installs the tarball into an empty directory next to
 * the two dsh peer dependencies (what `dsh plugin add <tgz>` relies on), and
 * imports it. The real workspace is never written to.
 *
 * Before the fix the host build printed `[UNRESOLVED_IMPORT] Could not resolve
 * '@remora/crypto' … treating it as an external dependency`, exited 0, and the
 * installed tarball failed with `Cannot find package '@remora/crypto'`.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const IS_WINDOWS = process.platform === 'win32'
const STEP_TIMEOUT_MS = 300_000

/** Root files a pnpm install from the lockfile needs. */
const ROOT_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'])
/** Every workspace manifest, so the frozen lockfile matches the copied workspace. */
const WORKSPACE_MANIFEST = /^apps\/[^/]+\/package\.json$/
/** Full sources of the TypeScript packages (the host and every package it can depend on). */
const PACKAGE_SOURCES = /^packages\//

interface RunResult {
  status: number | null
  output: string
}

/** Quote one argument for cmd.exe (only used for the `.cmd` shims pnpm and npm on Windows). */
function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

/**
 * Run a command synchronously and return its exit status with combined stdout and stderr.
 * On Windows `pnpm` and `npm` are `.cmd` shims, so they run through cmd.exe as one quoted
 * command line; `git` and Node itself are spawned directly.
 */
function run(command: string, args: string[], cwd: string): RunResult {
  const viaShell = IS_WINDOWS && command !== process.execPath && command !== 'git'
  const options = {
    cwd,
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  } as const
  const result = viaShell
    ? spawnSync([command, ...args.map(quoteForCmd)].join(' '), { ...options, shell: true })
    : spawnSync(command, args, options)
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${String(result.error)}` : ''}`
  return { status: result.status, output }
}

/** Run a command and fail with its full output unless it exits 0. */
function runOk(command: string, args: string[], cwd: string): string {
  const result = run(command, args, cwd)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status} in ${cwd}:\n${result.output}`)
  }
  return result.output
}

/** Copy the workspace files a clean checkout would contain into `destination`. */
function copyCleanCheckout(destination: string): void {
  const listed = runOk('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], REPO_ROOT)
  const files = listed
    .split('\0')
    .filter((file) => ROOT_FILES.has(file) || WORKSPACE_MANIFEST.test(file) || PACKAGE_SOURCES.test(file))
  for (const file of files) {
    const source = path.join(REPO_ROOT, file)
    // `--cached` also lists tracked files deleted in the working tree; a checkout would not have them.
    if (!fs.existsSync(source)) continue
    const target = path.join(destination, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
}

/** Matches a static or dynamic runtime import of any `@remora/*` package in emitted JavaScript. */
const REMORA_RUNTIME_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']@remora\//

/** List every emitted `.js` file under `dir`, recursively. */
function listJsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(entry.parentPath, entry.name))
}

/** Read a JSON file whose shape the caller narrows. */
function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** Names of the packages in one dependency field of a manifest. */
function dependencyNames(manifest: Record<string, unknown>, field: string): string[] {
  const value = manifest[field]
  return typeof value === 'object' && value !== null ? Object.keys(value) : []
}

/** Exact version of a devDependency pinned in the host manifest. */
function pinnedDevVersion(manifest: Record<string, unknown>, name: string): string {
  const devDependencies = manifest['devDependencies']
  const version =
    typeof devDependencies === 'object' && devDependencies !== null
      ? (devDependencies as Record<string, unknown>)[name]
      : undefined
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`packages/host/package.json must pin devDependency ${name} to an exact version`)
  }
  return version
}

describe('P7-H8 self-contained host tarball (clean checkout)', () => {
  let tempRoot = ''
  let workspace = ''
  let hostDir = ''
  let buildOutput = ''
  let packedManifest: Record<string, unknown> = {}
  let consumerDir = ''

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remora-host-pack-'))
    workspace = path.join(tempRoot, 'checkout')
    hostDir = path.join(workspace, 'packages', 'host')
    copyCleanCheckout(workspace)

    runOk('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'], workspace)
    for (const sibling of ['crypto', 'protocol', 'relay-link']) {
      expect(fs.existsSync(path.join(workspace, 'packages', sibling, 'lib'))).toBe(false)
    }

    // Only the host's own build script: a clean checkout has no sibling build output.
    buildOutput = runOk('pnpm', ['run', 'build'], hostDir)

    const packDir = path.join(tempRoot, 'pack')
    fs.mkdirSync(packDir)
    runOk('pnpm', ['pack', '--pack-destination', packDir], hostDir)
    const tarballs = fs.readdirSync(packDir).filter((file) => file.endsWith('.tgz'))
    expect(tarballs).toHaveLength(1)
    const tarball = path.join(packDir, tarballs[0] ?? '')

    const hostManifest = readJson(path.join(hostDir, 'package.json'))
    consumerDir = path.join(tempRoot, 'consumer')
    fs.mkdirSync(consumerDir)
    fs.writeFileSync(
      path.join(consumerDir, 'package.json'),
      JSON.stringify({ name: 'remora-pack-consumer', private: true, type: 'module' }),
    )
    runOk(
      'npm',
      [
        'install',
        tarball,
        `@deepseek-ai/cordis@${pinnedDevVersion(hostManifest, '@deepseek-ai/cordis')}`,
        `@deepseek-ai/schemastery@${pinnedDevVersion(hostManifest, '@deepseek-ai/schemastery')}`,
        '--no-audit',
        '--no-fund',
        '--prefer-offline',
        '--loglevel=error',
      ],
      consumerDir,
    )
    packedManifest = readJson(path.join(consumerDir, 'node_modules', '@remora', 'host', 'package.json'))
  }, STEP_TIMEOUT_MS * 4)

  afterAll(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('builds from a clean checkout without externalizing an unresolved import', () => {
    expect(buildOutput).not.toContain('UNRESOLVED_IMPORT')
  })

  it('emits no runtime @remora/* import in the installed lib', () => {
    const libDir = path.join(consumerDir, 'node_modules', '@remora', 'host', 'lib')
    const jsFiles = listJsFiles(libDir)
    expect(jsFiles.map((file) => path.relative(libDir, file))).toContain('index.js')
    const offenders = jsFiles.filter((file) => REMORA_RUNTIME_IMPORT.test(fs.readFileSync(file, 'utf8')))
    expect(offenders.map((file) => path.relative(libDir, file))).toEqual([])
  })

  it('declares no @remora/* runtime, peer, or optional dependency in the packed manifest', () => {
    const declared = ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) =>
      dependencyNames(packedManifest, field),
    )
    expect(declared.filter((name) => name.startsWith('@remora/'))).toEqual([])
  })

  it('imports @remora/host from the installed tarball next to the dsh peers', () => {
    const probe = [
      "const host = await import('@remora/host')",
      "console.log(JSON.stringify(['name', 'inject', 'Config', 'apply'].map((key) => [key, typeof host[key]])))",
    ].join('\n')
    const result = run(process.execPath, ['--input-type=module', '--eval', probe], consumerDir)
    expect(result.output).not.toContain('Cannot find package')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.output.trim())).toEqual([
      ['name', 'string'],
      ['inject', 'object'],
      ['Config', 'function'],
      ['apply', 'function'],
    ])
  })

  it('fails the bundler loudly when an @remora/* import cannot be resolved', () => {
    // The review's failure mode: bundling while a sibling has no build output.
    fs.rmSync(path.join(workspace, 'packages', 'crypto', 'lib'), { recursive: true, force: true })
    const result = run('pnpm', ['exec', 'tsdown'], hostDir)
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('@remora/crypto')
  })

  if (IS_WINDOWS) {
    it('acquires and releases the native API through the installed host apply() on real Cordis', () => {
      const probe = fs.readFileSync(path.join(REPO_ROOT, 'packages/host/test/platform/packed-host-probe.mjs'), 'utf8')
      const support = pathToFileURL(path.join(REPO_ROOT, 'packages/host/test/')).href
      const result = run(process.execPath, ['--input-type=module', '--eval', probe, support], consumerDir)
      expect(result.output, 'Installed tarball native API probe failed').toContain('packed host native acquisition and disposal complete')
      expect(result.status).toBe(0)
    })
  }
})

#!/usr/bin/env node
// Gate: no-stubs scanner for production code (docs/tasks/P7-G3.md).
//
// Fails when production sources contain stub markers, so placeholders cannot be
// reported as finished features (docs/SWARM.md §0). Scanned, repo-relative:
//   - packages/*/src/**/*.ts   excluding packages/testkit (test scaffolding by design)
//   - apps/relay/src/**        and apps/cli/src/** (the packet's two TS app roots; only
//                              .ts-family files are read — their non-source assets are
//                              not production code)
//   - apps/android/**/src/main/**/*.kt (main source sets only; test sources excluded)
//
// Findings (pattern name -> what counts):
//   TODO / FIXME / XXX   whole word, case-sensitive, anywhere in the line
//   placeholder          the word "placeholder" (case-insensitive) inside a "..." or
//                        '...' string literal on the line; Compose `placeholder = {`
//                        parameters keep the word outside the quotes and are ignored
//   PlaceholderScreen(   literal, in any file outside a /core/ui/ source path (there it
//                        is the real shared component, not a stub call site)
//   (ctx as any)         literal — the dsh crash in docs/SWARM.md §0 comes from it
//   as unknown as { on(  literal — the same untyped-Cordis escape in another shape
//   globalThis.koffi     a line containing both `globalThis` and `koffi`; covers both
//                        `globalThis.koffi` and the
//                        `(globalThis as unknown as { koffi?: ... }).koffi` shape that
//                        makes the keep-awake driver a no-op on Windows
//   not implemented      phrase, case-insensitive
//
// scripts/gates.allow.json holds the explicit allowlist. It starts EMPTY; every entry
// requires owner approval (docs/SWARM.md §4). Entry shape:
//   { "file": "<repo-relative path with forward slashes>", "pattern": "<name above>",
//     "reason": "<why this occurrence is acceptable>", "expires": "YYYY-MM-DD" }
// A malformed allowlist fails the gate (exit 2, fail closed). An entry whose `expires`
// date has passed stops suppressing (reported on stderr) until the owner renews it.
//
// In CI this runs as the non-required `no-stubs` job (continue-on-error: true) until
// P7-V3 removes that and makes the gate required. Dependency-free on purpose: the job
// runs it without `pnpm install`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const ALLOWLIST_FILE = 'gates.allow.json'
const TS_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx']
// Never walked: dependency/fixture output is not production source.
const SKIP_DIRS = new Set(['node_modules', '.git', '.gradle', '.upstream', '.scratch', 'build', 'dist'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
// One "..." or '...' span per match; escapes are skipped so \" does not end the string.
const QUOTED_SPAN = /"((?:[^"\\\r\n]|\\.)*)"|'((?:[^'\\\r\n]|\\.)*)'/g
const PLACEHOLDER_WORD = /\bplaceholder\b/i

/** @param {string} name @returns {boolean} */
const hasTsExtension = (name) => TS_EXTENSIONS.some((extension) => name.endsWith(extension))

/**
 * Patterns from docs/tasks/P7-G3.md. `file` is the repo-relative path with forward
 * slashes; a test function returns true when the line is a finding.
 */
const PATTERNS = [
  { name: 'TODO', test: (line) => /\bTODO\b/.test(line) },
  { name: 'FIXME', test: (line) => /\bFIXME\b/.test(line) },
  { name: 'XXX', test: (line) => /\bXXX\b/.test(line) },
  {
    name: 'placeholder',
    test: (line) => {
      for (const span of line.matchAll(QUOTED_SPAN)) {
        if (PLACEHOLDER_WORD.test(span[1] ?? span[2] ?? '')) return true
      }
      return false
    },
  },
  { name: 'PlaceholderScreen(', test: (line, file) => !file.includes('/core/ui/') && line.includes('PlaceholderScreen(') },
  { name: '(ctx as any)', test: (line) => line.includes('(ctx as any)') },
  { name: 'as unknown as { on(', test: (line) => line.includes('as unknown as { on(') },
  { name: 'globalThis.koffi', test: (line) => /\bglobalThis\b/.test(line) && /\bkoffi\b/.test(line) },
  { name: 'not implemented', test: (line) => /\bnot implemented\b/i.test(line) },
]
const PATTERN_NAMES = PATTERNS.map((pattern) => pattern.name)

/**
 * Recursively collects regular files below `dir`, skipping SKIP_DIRS.
 * @param {string} dir @returns {string[]} absolute paths (empty when dir is missing)
 */
function walkFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return []
    const path = join(dir, entry.name)
    if (statSync(path).isDirectory()) return walkFiles(path)
    return entry.isFile() ? [path] : []
  })
}

/**
 * Sources the gate is responsible for, under `rootDir` (the repository root, or a
 * fixture tree mirroring the same shape).
 * @param {string} rootDir @returns {string[]} repo-relative paths, forward slashes, sorted
 */
export function collectSourceFiles(rootDir) {
  const rel = (abs) => relative(rootDir, abs).split(sep).join('/')
  const files = []
  const packagesDir = join(rootDir, 'packages')
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'testkit') continue
      files.push(...walkFiles(join(packagesDir, entry.name, 'src')).filter((abs) => hasTsExtension(abs)).map(rel))
    }
  }
  for (const dir of ['apps/relay/src', 'apps/cli/src']) {
    files.push(...walkFiles(join(rootDir, dir)).filter((abs) => hasTsExtension(abs)).map(rel))
  }
  files.push(
    ...walkFiles(join(rootDir, 'apps/android'))
      .map(rel)
      .filter((path) => path.endsWith('.kt') && path.includes('/src/main/')),
  )
  return files.sort()
}

/**
 * @param {string} rootDir
 * @param {string} file repo-relative path with forward slashes
 * @returns {{ file: string, line: number, pattern: string, text: string }[]}
 */
export function scanFile(rootDir, file) {
  const findings = []
  const content = readFileSync(join(rootDir, file), 'utf8')
  content.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.test(line, file)) {
        findings.push({ file, line: index + 1, pattern: pattern.name, text: line.trim().slice(0, 240) })
      }
    }
  })
  return findings
}

/**
 * @param {string} rootDir
 * @returns {{ files: string[], findings: { file: string, line: number, pattern: string, text: string }[] }}
 */
export function scanRepository(rootDir) {
  const files = collectSourceFiles(rootDir)
  return { files, findings: files.flatMap((file) => scanFile(rootDir, file)) }
}

/**
 * Loads and validates the allowlist. Any structural problem makes the whole file
 * unusable (fail closed): the caller must not scan with a partly trusted list.
 * @param {string} path absolute path to gates.allow.json
 * @param {string} today ISO date (YYYY-MM-DD) to compare `expires` against
 * @returns {{ entries: { file: string, pattern: string, reason: string, expires: string }[] | null,
 *             expired: string[], problems: string[] }}
 */
export function loadAllowlist(path, today) {
  if (!existsSync(path)) return { entries: null, expired: [], problems: [`allowlist file is missing: ${path}`] }
  let doc
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { entries: null, expired: [], problems: [`invalid JSON (${error instanceof Error ? error.message : String(error)})`] }
  }
  if (!Array.isArray(doc)) return { entries: null, expired: [], problems: ['the file must contain a JSON array of entries'] }
  const problems = []
  const entries = []
  const expired = []
  doc.forEach((entry, index) => {
    const at = `entries[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${at}: must be an object`)
      return
    }
    for (const key of ['file', 'pattern', 'reason', 'expires']) {
      if (typeof entry[key] !== 'string' || entry[key].length === 0) problems.push(`${at}: "${key}" must be a non-empty string`)
    }
    if (typeof entry.pattern === 'string' && !PATTERN_NAMES.includes(entry.pattern)) {
      problems.push(`${at}: unknown pattern "${entry.pattern}" (supported: ${PATTERN_NAMES.join(', ')})`)
    }
    if (typeof entry.expires === 'string' && !ISO_DATE.test(entry.expires)) {
      problems.push(`${at}: "expires" must be an ISO date YYYY-MM-DD`)
    }
    if (problems.length > 0) return
    if (entry.expires < today) {
      expired.push(`${at}: expired on ${entry.expires} — remove or renew the entry`)
      return
    }
    entries.push({ file: entry.file, pattern: entry.pattern, reason: entry.reason, expires: entry.expires })
  })
  return problems.length === 0 ? { entries, expired, problems } : { entries: null, expired, problems }
}

/**
 * @param {{ file: string, line: number, pattern: string, text: string }[]} findings
 * @param {{ file: string, pattern: string, reason: string, expires: string }[]} entries
 * @returns {{ remaining: typeof findings, suppressed: (typeof findings[number] & { reason: string, expires: string })[] }}
 */
export function applyAllowlist(findings, entries) {
  const remaining = []
  const suppressed = []
  for (const finding of findings) {
    const entry = entries.find((candidate) => candidate.file === finding.file && candidate.pattern === finding.pattern)
    if (entry) suppressed.push({ ...finding, reason: entry.reason, expires: entry.expires })
    else remaining.push(finding)
  }
  return { remaining, suppressed }
}

function main() {
  const rootDir = join(import.meta.dirname, '..')
  const allowlistPath = join(rootDir, 'scripts', ALLOWLIST_FILE)
  const today = new Date().toISOString().slice(0, 10)
  const { entries, expired, problems } = loadAllowlist(allowlistPath, today)
  if (entries === null) {
    console.error(`✗ scripts/${ALLOWLIST_FILE} is invalid — fix or empty it before scanning:`)
    for (const problem of problems) console.error(`    ${problem}`)
    process.exitCode = 2
    return
  }
  for (const message of expired) console.error(`! allowlist entry ignored: ${message}`)
  const { files, findings } = scanRepository(rootDir)
  const { remaining, suppressed } = applyAllowlist(findings, entries)
  for (const finding of remaining) {
    console.error(`✗ ${finding.file}:${finding.line} ${finding.pattern}: ${finding.text}`)
  }
  for (const finding of suppressed) {
    console.log(`· ${finding.file}:${finding.line} ${finding.pattern} [allowed: ${finding.reason}; expires ${finding.expires}]`)
  }
  const verdict = remaining.length === 0 ? '✓ no stub findings' : '✗ stub findings must be fixed or owner-allowlisted'
  console.log(
    `${files.length} file(s) scanned, ${remaining.length} stub finding(s), ` +
      `${suppressed.length} allowed by scripts/${ALLOWLIST_FILE} (${entries.length} active). ${verdict}`,
  )
  process.exitCode = remaining.length === 0 ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()

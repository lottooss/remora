// Unit tests for scripts/check-no-stubs.mjs — docs/tasks/P7-G3.md acceptance:
// "The scanner has its own unit test with fixture files for every pattern."
//
// The tests run the real scanner (no mocks) over the committed fixture tree in
// scripts/testdata/no-stubs/, which covers every pattern and every exclusion rule.
// The allowlist loader is exercised against temp files so the committed
// scripts/gates.allow.json can stay empty (entries require owner approval,
// docs/SWARM.md §4). The repository itself is deliberately NOT asserted here: until
// P7-V3 the gate is expected to fail on real stubs (the CI `no-stubs` job), and later
// packets fix them one by one.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyAllowlist, collectSourceFiles, loadAllowlist, scanFile, scanRepository } from './check-no-stubs.mjs'

const FIXTURE_ROOT = join(import.meta.dirname, 'testdata', 'no-stubs')

// Every pattern name from docs/tasks/P7-G3.md; the fixture tree must exercise each one.
const ALL_PATTERNS = [
  'TODO',
  'FIXME',
  'XXX',
  'placeholder',
  'PlaceholderScreen(',
  '(ctx as any)',
  'as unknown as { on(',
  'globalThis.koffi',
  'not implemented',
]

let tempDir
afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

/** @returns {string} fresh temp directory that is cleaned up after the test */
function makeTempDir() {
  tempDir ??= mkdtempSync(join(tmpdir(), 'check-no-stubs-test-'))
  return tempDir
}

describe('collectSourceFiles', () => {
  it('collects exactly the production source files of the fixture tree, sorted', () => {
    expect(collectSourceFiles(FIXTURE_ROOT)).toEqual([
      'apps/android/app/src/main/kotlin/io/github/lottooss/remora/Stubs.kt',
      'apps/android/core/ui/src/main/kotlin/io/github/lottooss/remora/core/ui/PlaceholderScreen.kt',
      'apps/android/feature/sessions/src/main/kotlin/ComposeForm.kt',
      'apps/cli/src/stubs.ts',
      'apps/relay/src/stubs.ts',
      'packages/app/src/stubs.ts',
    ])
  })

  it('excludes packages/testkit and non-src/main Kotlin sources', () => {
    const files = collectSourceFiles(FIXTURE_ROOT)
    expect(files).not.toContain('packages/testkit/src/ignored.ts')
    expect(files).not.toContain('apps/android/app/src/test/kotlin/RepoTest.kt')
  })
})

describe('scanRepository over the fixture tree', () => {
  const { files, findings } = scanRepository(FIXTURE_ROOT)

  it('scans the collected files', () => {
    expect(files).toHaveLength(6)
  })

  it('reports a finding for every pattern in docs/tasks/P7-G3.md', () => {
    const fired = new Set(findings.map((finding) => finding.pattern))
    for (const name of ALL_PATTERNS) {
      expect(fired.has(name), `pattern "${name}" must be covered by a fixture`).toBe(true)
    }
    expect(fired.size).toBe(ALL_PATTERNS.length)
  })

  it('reports exactly the 16 declared findings, in file and line order', () => {
    expect(findings).toEqual([
      { file: 'apps/android/app/src/main/kotlin/io/github/lottooss/remora/Stubs.kt', line: 5, pattern: 'TODO', text: '// TODO: send token to relay' },
      { file: 'apps/android/app/src/main/kotlin/io/github/lottooss/remora/Stubs.kt', line: 6, pattern: 'placeholder', text: 'val label = "Unlock (placeholder)"' },
      { file: 'apps/android/app/src/main/kotlin/io/github/lottooss/remora/Stubs.kt', line: 7, pattern: 'PlaceholderScreen(', text: 'val shell = PlaceholderScreen(' },
      { file: 'apps/android/app/src/main/kotlin/io/github/lottooss/remora/Stubs.kt', line: 10, pattern: 'not implemented', text: 'fun notDone(): Nothing = error("not implemented")' },
      { file: 'apps/cli/src/stubs.ts', line: 2, pattern: 'XXX', text: "export const marker = 'XXX cli'" },
      { file: 'apps/relay/src/stubs.ts', line: 2, pattern: 'FIXME', text: "export const marker = 'FIXME relay'" },
      { file: 'packages/app/src/stubs.ts', line: 4, pattern: 'TODO', text: '// TODO comment marker' },
      { file: 'packages/app/src/stubs.ts', line: 5, pattern: 'FIXME', text: '// FIXME comment marker' },
      { file: 'packages/app/src/stubs.ts', line: 6, pattern: 'XXX', text: '// XXX comment marker' },
      { file: 'packages/app/src/stubs.ts', line: 8, pattern: 'placeholder', text: 'export const doubleQuoted = "unlock (placeholder)"' },
      { file: 'packages/app/src/stubs.ts', line: 9, pattern: 'placeholder', text: "export const singleQuoted = 'placeholder text'" },
      { file: 'packages/app/src/stubs.ts', line: 10, pattern: '(ctx as any)', text: 'export const context = (ctx as any).typertGateway' },
      { file: 'packages/app/src/stubs.ts', line: 11, pattern: 'as unknown as { on(', text: 'export const untyped = ctx as unknown as { on(event: string): () => void }' },
      { file: 'packages/app/src/stubs.ts', line: 12, pattern: 'globalThis.koffi', text: 'export const koffi = globalThis.koffi' },
      { file: 'packages/app/src/stubs.ts', line: 13, pattern: 'globalThis.koffi', text: 'export const koffiUntyped = (globalThis as unknown as { koffi?: unknown }).koffi' },
      { file: 'packages/app/src/stubs.ts', line: 15, pattern: 'not implemented', text: "throw new Error('not implemented')" },
    ])
  })

  it('stays silent on the exclusion fixtures', () => {
    const reported = new Set(findings.map((finding) => finding.file))
    // packages/testkit exclusion
    expect(reported.has('packages/testkit/src/ignored.ts')).toBe(false)
    // non-src/main Kotlin source set exclusion
    expect(reported.has('apps/android/app/src/test/kotlin/RepoTest.kt')).toBe(false)
    // core/ui exemption for PlaceholderScreen(
    expect(reported.has('apps/android/core/ui/src/main/kotlin/io/github/lottooss/remora/core/ui/PlaceholderScreen.kt')).toBe(false)
    // Compose `placeholder = { ... }` parameters and the word in comments
    expect(reported.has('apps/android/feature/sessions/src/main/kotlin/ComposeForm.kt')).toBe(false)
  })
})

describe('scanFile', () => {
  it('reports precise line numbers and trimmed text', () => {
    expect(scanFile(FIXTURE_ROOT, 'apps/android/app/src/main/kotlin/io/github/lottooss/remora/Stubs.kt')).toEqual([
      { file: 'apps/android/app/src/main/kotlin/io/github/lottooss/remora/Stubs.kt', line: 5, pattern: 'TODO', text: '// TODO: send token to relay' },
      { file: 'apps/android/app/src/main/kotlin/io/github/lottooss/remora/Stubs.kt', line: 6, pattern: 'placeholder', text: 'val label = "Unlock (placeholder)"' },
      { file: 'apps/android/app/src/main/kotlin/io/github/lottooss/remora/Stubs.kt', line: 7, pattern: 'PlaceholderScreen(', text: 'val shell = PlaceholderScreen(' },
      { file: 'apps/android/app/src/main/kotlin/io/github/lottooss/remora/Stubs.kt', line: 10, pattern: 'not implemented', text: 'fun notDone(): Nothing = error("not implemented")' },
    ])
  })

  it('handles CRLF line endings (Windows checkouts)', () => {
    const dir = makeTempDir()
    const file = join(dir, 'crlf.ts')
    writeFileSync(file, 'const clean = 1\r\n// TODO crlf marker\r\nconst clean2 = 2\r\n')
    expect(scanFile(dir, 'crlf.ts')).toEqual([
      { file: 'crlf.ts', line: 2, pattern: 'TODO', text: '// TODO crlf marker' },
    ])
  })
})

describe('applyAllowlist', () => {
  const findings = scanRepository(FIXTURE_ROOT).findings

  it('suppresses only the exact file+pattern match and records the entry', () => {
    const entry = { file: 'apps/relay/src/stubs.ts', pattern: 'FIXME', reason: 'example approved by the owner', expires: '2999-01-01' }
    const { remaining, suppressed } = applyAllowlist(findings, [entry])
    expect(suppressed).toEqual([
      { file: 'apps/relay/src/stubs.ts', line: 2, pattern: 'FIXME', text: "export const marker = 'FIXME relay'", reason: 'example approved by the owner', expires: '2999-01-01' },
    ])
    expect(remaining).toHaveLength(findings.length - 1)
    expect(remaining.find((finding) => finding.file === 'apps/relay/src/stubs.ts')).toBeUndefined()
  })

  it('does not suppress when the file or the pattern differs', () => {
    // The fixture file exists but has no findings, so nothing can match the entry.
    const wrongFile = { file: 'apps/android/feature/sessions/src/main/kotlin/ComposeForm.kt', pattern: 'FIXME', reason: 'x', expires: '2999-01-01' }
    expect(applyAllowlist(findings, [wrongFile]).suppressed).toEqual([])
    const wrongPattern = { file: 'apps/relay/src/stubs.ts', pattern: 'TODO', reason: 'x', expires: '2999-01-01' }
    expect(applyAllowlist(findings, [wrongPattern]).suppressed).toEqual([])
  })
})

describe('loadAllowlist', () => {
  const writeAllowlist = (content) => {
    const path = join(makeTempDir(), 'gates.allow.json')
    writeFileSync(path, content)
    return path
  }

  it('loads well-formed entries', () => {
    const path = writeAllowlist(JSON.stringify([
      { file: 'apps/relay/src/stubs.ts', pattern: 'FIXME', reason: 'example', expires: '2999-01-01' },
    ]))
    const { entries, expired, problems } = loadAllowlist(path, '2026-09-30')
    expect(problems).toEqual([])
    expect(expired).toEqual([])
    expect(entries).toEqual([{ file: 'apps/relay/src/stubs.ts', pattern: 'FIXME', reason: 'example', expires: '2999-01-01' }])
  })

  it('drops expired entries instead of suppressing (fail closed), without failing the file', () => {
    const path = writeAllowlist(JSON.stringify([
      { file: 'a.ts', pattern: 'TODO', reason: 'old', expires: '2020-01-01' },
      { file: 'b.ts', pattern: 'FIXME', reason: 'current', expires: '2999-01-01' },
    ]))
    const { entries, expired, problems } = loadAllowlist(path, '2026-09-30')
    expect(problems).toEqual([])
    expect(entries).toEqual([{ file: 'b.ts', pattern: 'FIXME', reason: 'current', expires: '2999-01-01' }])
    expect(expired).toEqual(['entries[0]: expired on 2020-01-01 — remove or renew the entry'])
  })

  it('rejects an unknown pattern name', () => {
    const path = writeAllowlist(JSON.stringify([{ file: 'a.ts', pattern: 'HACK', reason: 'x', expires: '2999-01-01' }]))
    const { entries, problems } = loadAllowlist(path, '2026-09-30')
    expect(entries).toBeNull()
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('unknown pattern "HACK"')
  })

  it('rejects missing fields, a bad expires date, non-objects and non-arrays (fail closed)', () => {
    for (const content of [
      JSON.stringify([{ file: 'a.ts', pattern: 'TODO', reason: 'x' }]), // missing expires
      JSON.stringify([{ file: 'a.ts', pattern: 'TODO', expires: '2999-01-01' }]), // missing reason
      JSON.stringify([{ file: 'a.ts', pattern: 'TODO', reason: 'x', expires: 'next year' }]), // bad date
      JSON.stringify(['not an object']),
      JSON.stringify({ file: 'a.ts' }), // not an array
    ]) {
      const { entries, problems } = loadAllowlist(writeAllowlist(content), '2026-09-30')
      expect(entries, content).toBeNull()
      expect(problems.length, content).toBeGreaterThan(0)
    }
  })

  it('rejects malformed JSON and a missing file', () => {
    expect(loadAllowlist(writeAllowlist('{not json'), '2026-09-30').entries).toBeNull()
    const missing = loadAllowlist(join(makeTempDir(), 'absent.json'), '2026-09-30')
    expect(missing.entries).toBeNull()
    expect(missing.problems[0]).toContain('missing')
  })
})

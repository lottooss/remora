#!/usr/bin/env node
// Validate every conformance vector file (conformance/vectors/**/*.json) against the
// rules of conformance/schema/vector-file.schema.json. Dependency-free on purpose: the
// format is small, and the TypeScript and Kotlin loaders rely on exactly these fields.
//
// Usage: node scripts/check-conformance.mjs [--strict]
//
// Without --strict only the schema rules are enforced (the `conformance:check` gate).
// With --strict (task P7-G2) a file is additionally rejected when any case is a
// placeholder (`input.status === "scaffold"` or a name matching /placeholder|scaffold/i)
// or when it has fewer cases than the per-area minimums:
//   - crypto/*: >= 3 cases including >= 1 error case (the external Cacophony vector is
//     exempt: it is upstream's file and complete as published)
//   - rcp/methods/*: >= 2 valid (expect) + >= 1 invalid (error) cases
//   - rcp/envelope.json, rcp/limits.json, rcp/session-events.json, relay/*:
//     >= 5 cases including >= 1 error case
// Strict mode fails until every vector is real (wave 4, P7-V1..P7-V3); in CI it runs as
// the non-required `conformance-strict` job (continue-on-error) until P7-V3 removes that.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dirname, '..')
const vectorsDir = join(root, 'conformance', 'vectors')

/** @param {string} dir @returns {string[]} */
function jsonFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return jsonFiles(path)
    return name.endsWith('.json') ? [path] : []
  })
}

const SUITE = /^[a-z0-9-]+(\/[a-z0-9.-]+)+$/
const ERROR_CODE = /^[a-z0-9_]+$/
const TOP_KEYS = new Set(['suite', 'version', 'source', 'notes', 'cases'])
const CASE_KEYS = new Set(['name', 'input', 'expect', 'error'])
const SCAFFOLD_STATUS = 'scaffold'
const SCAFFOLD_NAME = /placeholder|scaffold/i
const EXTERNAL_EXEMPT = new Set(['crypto/noise-cacophony-ikpsk2.json'])
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** @param {unknown} doc @returns {string[]} problems */
function validate(doc) {
  const problems = []
  if (!isObject(doc)) return ['file must contain a JSON object']
  for (const key of Object.keys(doc)) if (!TOP_KEYS.has(key)) problems.push(`unknown top-level key "${key}"`)
  if (typeof doc.suite !== 'string' || !SUITE.test(doc.suite)) problems.push('"suite" must look like "area/name"')
  if (!Number.isInteger(doc.version) || doc.version < 1) problems.push('"version" must be an integer >= 1')
  if (typeof doc.source !== 'string' || doc.source.length === 0) problems.push('"source" must say where the vectors come from')
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) {
    problems.push('"cases" must be a non-empty array')
    return problems
  }
  const names = new Set()
  doc.cases.forEach((testCase, index) => {
    const at = `cases[${index}]`
    if (!isObject(testCase)) { problems.push(`${at} must be an object`); return }
    for (const key of Object.keys(testCase)) if (!CASE_KEYS.has(key)) problems.push(`${at}: unknown key "${key}"`)
    if (typeof testCase.name !== 'string' || testCase.name.length === 0) problems.push(`${at}: "name" is required`)
    else if (names.has(testCase.name)) problems.push(`${at}: duplicate name "${testCase.name}"`)
    else names.add(testCase.name)
    if (!isObject(testCase.input)) problems.push(`${at}: "input" must be an object`)
    const hasExpect = Object.hasOwn(testCase, 'expect')
    const hasError = Object.hasOwn(testCase, 'error')
    if (hasExpect === hasError) problems.push(`${at}: exactly one of "expect" or "error" is required`)
    if (hasError && (typeof testCase.error !== 'string' || !ERROR_CODE.test(testCase.error))) {
      problems.push(`${at}: "error" must be a snake_case code`)
    }
  })
  return problems
}

/**
 * Per-area strict minimums from docs/tasks/P7-G2.md. 0 means "not required".
 * @param {string} key file path relative to conformance/vectors, with forward slashes
 * @returns {{ minCases: number, minValid: number, minErrors: number } | null}
 *   null when the area has no strict minimum defined (unknown area, reported as a
 *   violation so the gate never silently skips a file) or the file is exempt.
 */
function strictMinimums(key) {
  if (EXTERNAL_EXEMPT.has(key)) return null
  if (key.startsWith('crypto/')) return { minCases: 3, minValid: 0, minErrors: 1 }
  if (key.startsWith('rcp/methods/')) return { minCases: 0, minValid: 2, minErrors: 1 }
  if (key === 'rcp/envelope.json' || key === 'rcp/limits.json' || key === 'rcp/session-events.json') {
    return { minCases: 5, minValid: 0, minErrors: 1 }
  }
  if (key.startsWith('relay/')) return { minCases: 5, minValid: 0, minErrors: 1 }
  return null
}

/** @param {unknown} doc @param {string} key @returns {string[]} strict violations */
function validateStrict(doc, key) {
  const violations = []
  if (!isObject(doc) || !Array.isArray(doc.cases)) return violations // schema problems already reported
  let validCases = 0
  let errorCases = 0
  doc.cases.forEach((testCase, index) => {
    const at = `cases[${index}]`
    if (!isObject(testCase)) return
    if (isObject(testCase.input) && testCase.input.status === SCAFFOLD_STATUS) {
      violations.push(`${at}: placeholder case (input.status = "${SCAFFOLD_STATUS}")`)
    }
    if (typeof testCase.name === 'string' && SCAFFOLD_NAME.test(testCase.name)) {
      violations.push(`${at}: placeholder case name "${testCase.name}"`)
    }
    if (Object.hasOwn(testCase, 'expect')) validCases += 1
    if (Object.hasOwn(testCase, 'error')) errorCases += 1
  })
  const minimums = strictMinimums(key)
  if (minimums) {
    if (doc.cases.length < minimums.minCases) {
      violations.push(`${doc.cases.length} case(s), strict minimum is ${minimums.minCases}`)
    }
    if (validCases < minimums.minValid) {
      violations.push(`${validCases} valid case(s), strict minimum is ${minimums.minValid}`)
    }
    if (errorCases < minimums.minErrors) {
      violations.push(`${errorCases} error case(s), strict minimum is ${minimums.minErrors}`)
    }
  } else if (!EXTERNAL_EXEMPT.has(key)) {
    violations.push('unknown vector area: no strict minimum defined (update scripts/check-conformance.mjs)')
  }
  return violations
}

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const unknownArgs = args.filter((arg) => arg !== '--strict')
if (unknownArgs.length > 0) {
  console.error(`unknown argument(s): ${unknownArgs.join(' ')} (supported: --strict)`)
  process.exitCode = 1
} else {
  let failures = 0
  let strictViolationsTotal = 0
  const files = jsonFiles(vectorsDir)
  for (const file of files) {
    const name = relative(root, file)
    const key = relative(vectorsDir, file).split('\\').join('/')
    let doc
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      console.error(`✗ ${name}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
      failures += 1
      continue
    }
    const problems = validate(doc)
    const strictViolations = strict ? validateStrict(doc, key) : []
    strictViolationsTotal += strictViolations.length
    if (problems.length > 0 || strictViolations.length > 0) {
      failures += 1
      console.error(`✗ ${name}`)
      for (const problem of problems) console.error(`    ${problem}`)
      for (const violation of strictViolations) console.error(`    strict: ${violation}`)
    } else {
      console.log(`✓ ${name} (${doc.cases.length} cases)`)
    }
  }
  const violationNote = strict ? `, ${strictViolationsTotal} strict violation(s)` : ''
  console.log(`${files.length} vector file(s) checked, ${failures} with problems${violationNote}`)
  process.exitCode = failures === 0 ? 0 : 1
}

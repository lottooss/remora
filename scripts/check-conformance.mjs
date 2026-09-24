#!/usr/bin/env node
// Validate every conformance vector file (conformance/vectors/**/*.json) against the
// rules of conformance/schema/vector-file.schema.json. Dependency-free on purpose: the
// format is small, and the TypeScript and Kotlin loaders rely on exactly these fields.
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

let failures = 0
const files = jsonFiles(vectorsDir)
for (const file of files) {
  const name = relative(root, file)
  let doc
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`✗ ${name}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
    failures += 1
    continue
  }
  const problems = validate(doc)
  if (problems.length > 0) {
    failures += 1
    console.error(`✗ ${name}`)
    for (const problem of problems) console.error(`    ${problem}`)
  } else {
    console.log(`✓ ${name} (${doc.cases.length} cases)`)
  }
}
console.log(`${files.length} vector file(s) checked, ${failures} with problems`)
process.exitCode = failures === 0 ? 0 : 1

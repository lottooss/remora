/// <reference types="node" />
// Node built-ins are test-only: the package runtime (workerd) stays node-free,
// so the package tsconfig keeps `types: []` and this file opts in explicitly.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { RCP_METHODS } from '../src/rcp/index.ts'
import { parseSpecMethods, parseSpecSummary } from './spec-method-table.ts'

/**
 * Acceptance test for task P7-C1: `@remora/protocol`'s method registry must be
 * exactly the method set the RCP/1 spec defines — no host- or registry-only
 * extras, no spec method missing — and the generated Kotlin parity export
 * `conformance/vectors/rcp/method-list.json` must repeat the same list.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const specPath = `${repoRoot}docs/specs/rcp-v1.md`
const methodListPath = `${repoRoot}conformance/vectors/rcp/method-list.json`

const specText = readFileSync(specPath, 'utf8')
const specMethods = parseSpecMethods(specText)

const registryTriples: ReadonlyArray<{
  name: string
  kind: 'unary' | 'stream'
  mutating: boolean
}> = RCP_METHODS.map((method) => ({
  name: method.name,
  kind: method.kind,
  mutating: method.mutating,
}))

describe('RCP/1 spec ↔ registry method list (P7-C1)', () => {
  it('parses the normative §4–§10 method tables', () => {
    // Guards the parser itself: the frozen spec must yield the documented set.
    expect(specMethods.length).toBeGreaterThanOrEqual(27)
    expect(new Set(specMethods.map((method) => method.name)).has('hello')).toBe(true)
  })

  it('RCP_METHODS (name, kind, mutating) equals spec §4–§10 exactly, in spec order', () => {
    const specNames = new Set(specMethods.map((method) => method.name))
    const registryNames = new Set(registryTriples.map((method) => method.name))
    const notInSpec = registryTriples
      .filter((method) => !specNames.has(method.name))
      .map((method) => method.name)
    const missingFromRegistry = specMethods
      .filter((method) => !registryNames.has(method.name))
      .map((method) => method.name)
    expect(notInSpec, 'registry methods the spec does not define').toEqual([])
    expect(missingFromRegistry, 'spec methods missing from the registry').toEqual([])
    expect(registryTriples, 'registry must match the spec tables in name, kind, mutating, order').toEqual(
      specMethods,
    )
  })

  it('the §11 method summary lists exactly the §4–§10 methods with matching mutating flags', () => {
    const summary = parseSpecSummary(specText, specMethods)
    const summaryNames = summary.map((entry) => entry.name).sort()
    const definedNames = specMethods.map((method) => method.name).sort()
    expect(summaryNames, '§11 must summarize exactly the §4–§10 methods').toEqual(definedNames)
    for (const entry of summary) {
      const defined = specMethods.find((method) => method.name === entry.name)
      expect(defined?.mutating, `§11 mutating flag for ${entry.name}`).toBe(entry.mutating)
    }
  })

  it('conformance/vectors/rcp/method-list.json equals RCP_METHODS (generated export, Kotlin parity in P7-A5)', () => {
    const doc: unknown = JSON.parse(readFileSync(methodListPath, 'utf8'))
    expect(doc).toMatchObject({ suite: 'rcp/method-list', version: 1 })
    const cases = (
      doc as {
        cases: {
          name: unknown
          input: { method: unknown }
          expect: { kind: unknown; mutating: unknown }
        }[]
      }
    ).cases
    const entries = cases.map((testCase) => ({
      name: testCase.input.method,
      kind: testCase.expect.kind,
      mutating: testCase.expect.mutating,
    }))
    expect(entries).toEqual(registryTriples)
  })
})

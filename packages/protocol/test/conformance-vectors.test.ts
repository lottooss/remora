import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'

import {
  ControlFrameSchema,
  MAX_RCP_MESSAGE_BYTES,
  MessageSchema,
  RCP_METHOD_NAMES,
  RcpErrorSchema,
  SessionEventSchema,
  decodeDataFrame,
  getRcpMethod,
} from '../src/index.ts'

/**
 * Conformance vector consumer for RCP/1 and RLY/1 (task P7-V2). Every case in
 * conformance/vectors/{rcp,relay}/** is decoded with the @remora/protocol
 * schemas and codecs: valid cases must decode and carry every field the case's
 * `expect` names (implementations may drop unknown optional fields), invalid
 * cases must be rejected. Kotlin decodes the same files in :core:protocol.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const vectorsRoot = join(repoRoot, 'conformance', 'vectors')

interface VectorCase {
  name: string
  input: { direction?: string; value?: unknown; hex?: string }
  expect?: unknown
  error?: string
}
interface VectorFile {
  suite: string
  version: number
  source: string
  notes?: string
  cases: VectorCase[]
}
interface LoadedVector {
  file: string
  doc: VectorFile
}

function loadVectorFiles(directory: string): LoadedVector[] {
  const entries = readdirSync(join(vectorsRoot, directory), { withFileTypes: true })
  const files: LoadedVector[] = []
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`
    if (entry.isDirectory()) files.push(...loadVectorFiles(relative))
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push({
        file: relative,
        doc: JSON.parse(readFileSync(join(vectorsRoot, relative), 'utf8')) as VectorFile,
      })
    }
  }
  return files
}

/** Subset match: every field named by `expected` must be present and equal. */
function matchesExpect(decoded: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(decoded) &&
      decoded.length === expected.length &&
      expected.every((item, index) => matchesExpect(decoded[index], item))
    )
  }
  if (expected !== null && typeof expected === 'object') {
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return false
    return Object.entries(expected).every(
      ([key, value]) =>
        key in decoded && matchesExpect((decoded as Record<string, unknown>)[key], value),
    )
  }
  return decoded === expected
}

/** Runs one vector case against a schema; returns the decoded value or undefined. */
function runCase(doc: VectorFile, testCase: VectorCase, schema: ZodType | undefined): unknown {
  if (schema === undefined) throw new Error(`${doc.suite}/${testCase.name}: no schema mapped`)
  const parsed = schema.safeParse(testCase.input.value)
  if ('error' in testCase) {
    expect(parsed.success, `${doc.suite}/${testCase.name} must be rejected`).toBe(false)
    return undefined
  }
  if (!parsed.success) {
    throw new Error(`${doc.suite}/${testCase.name} must decode: ${parsed.error.message}`)
  }
  expect(
    matchesExpect(parsed.data, testCase.expect),
    `${doc.suite}/${testCase.name}: decoded payload must carry the expected fields`,
  ).toBe(true)
  return parsed.data
}

function requireVector(files: LoadedVector[], file: string): { vector: LoadedVector; cases: VectorCase[] } {
  const vector = files.find((entry) => entry.file === file)
  if (!vector) throw new Error(`missing vector file ${file}`)
  return { vector, cases: vector.doc.cases }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Item schema of a stream method; `undefined` for unary methods. */
function itemSchemaOf(method: ReturnType<typeof getRcpMethod>): ZodType | undefined {
  return method?.kind === 'stream' ? method.itemSchema : undefined
}

describe('rcp vector files', () => {
  const rcpFiles = loadVectorFiles('rcp')

  it('cover envelope, limits, session events, and every registry method', () => {
    const files = new Set(rcpFiles.map(({ file }) => file))
    for (const required of ['rcp/envelope.json', 'rcp/limits.json', 'rcp/session-events.json']) {
      expect(files.has(required), `missing ${required}`).toBe(true)
    }
    const methodFiles = rcpFiles
      .filter(({ file }) => file.startsWith('rcp/methods/') && file.endsWith('.json'))
      .map(({ file }) => file.slice('rcp/methods/'.length, -'.json'.length))
    expect(new Set(methodFiles), 'one vector file per RCP_METHODS entry').toEqual(
      new Set(RCP_METHOD_NAMES),
    )
  })

  describe('rcp/envelope.json', () => {
    const { vector, cases } = requireVector(rcpFiles, 'rcp/envelope.json')
    for (const testCase of cases) {
      it(testCase.name, () => {
        runCase(vector.doc, testCase, MessageSchema)
      })
    }
  })

  describe('rcp/session-events.json', () => {
    const { vector, cases } = requireVector(rcpFiles, 'rcp/session-events.json')
    for (const testCase of cases) {
      it(testCase.name, () => {
        runCase(vector.doc, testCase, SessionEventSchema)
      })
    }
  })

  for (const { file, doc } of rcpFiles) {
    if (!file.startsWith('rcp/methods/') || !file.endsWith('.json')) continue
    const methodName = file.slice('rcp/methods/'.length, -'.json'.length)
    const method = getRcpMethod(methodName)
    describe(file, () => {
      it('names a registry method and maps every direction it uses', () => {
        expect(method, `${file} must name a method in RCP_METHODS`).toBeDefined()
        for (const testCase of doc.cases) {
          const direction = testCase.input.direction ?? ''
          if (direction === 'error') continue // errors decode with RcpErrorSchema
          const schema =
            direction === 'params'
              ? method?.paramsSchema
              : direction === 'result'
                ? method?.resultSchema
                : itemSchemaOf(method)
          expect(schema, `${file}: direction ${direction} has no schema`).toBeDefined()
        }
      })
      for (const testCase of doc.cases) {
        it(testCase.name, () => {
          const direction = testCase.input.direction
          if (direction === 'error') {
            runCase(doc, testCase, RcpErrorSchema)
            return
          }
          const schema =
            direction === 'params'
              ? method?.paramsSchema
              : direction === 'result'
                ? method?.resultSchema
                : itemSchemaOf(method)
          runCase(doc, testCase, schema)
        })
      }
    })
  }

  describe('rcp/limits.json', () => {
    const { vector, cases } = requireVector(rcpFiles, 'rcp/limits.json')
    it('exists', () => expect(vector).toBeDefined())
    const encoder = new TextEncoder()
    for (const testCase of cases) {
      it(testCase.name, () => {
        const input = testCase.input as { unit: string; repeat: number; padding?: string }
        // The exact recipe serialization from the vector notes: fixed JSON
        // syntax (56 bytes) plus the filled request text.
        const message = JSON.stringify({
          k: 'req',
          id: 1,
          m: 'sessions.prompt',
          p: { text: input.unit.repeat(input.repeat) + (input.padding ?? '') },
        })
        const bytes = encoder.encode(message).length
        if ('error' in testCase) {
          expect(testCase.error).toBe('too_large')
          expect(bytes).toBeGreaterThan(MAX_RCP_MESSAGE_BYTES)
        } else {
          expect((testCase.expect as { bytes: number }).bytes).toBe(bytes)
          expect(bytes).toBeLessThanOrEqual(MAX_RCP_MESSAGE_BYTES)
        }
      })
    }
  })
})

describe('relay vector files', () => {
  const relayFiles = loadVectorFiles('relay')

  it('cover data frames, control frames, and the auth handshake', () => {
    const files = new Set(relayFiles.map(({ file }) => file))
    for (const required of ['relay/data-frame.json', 'relay/control-frames.json', 'relay/auth.json']) {
      expect(files.has(required), `missing ${required}`).toBe(true)
    }
  })

  describe('relay/data-frame.json', () => {
    const { cases } = requireVector(relayFiles, 'relay/data-frame.json')
    for (const testCase of cases) {
      it(testCase.name, () => {
        const hex = testCase.input.hex
        if (typeof hex !== 'string') throw new Error(`${testCase.name}: input.hex must be a string`)
        const bytes = new Uint8Array(hex.length / 2)
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
        }
        if ('error' in testCase) {
          expect(() => decodeDataFrame(bytes)).toThrow()
          return
        }
        const frame = decodeDataFrame(bytes)
        const expected = testCase.expect as {
          version: number
          type: number
          channel: number
          peerKind: number
          peerId: string
          payload: string
        }
        expect(frame.version).toBe(expected.version)
        expect(frame.type).toBe(expected.type)
        expect(frame.channel).toBe(expected.channel)
        expect(frame.peerKind).toBe(expected.peerKind)
        expect(toHex(frame.peerId)).toBe(expected.peerId)
        expect(toHex(frame.payload)).toBe(expected.payload)
      })
    }
  })

  for (const { file, doc } of relayFiles) {
    if (file === 'relay/data-frame.json') continue // byte-level codec cases above
    describe(file, () => {
      for (const testCase of doc.cases) {
        it(testCase.name, () => {
          runCase(doc, testCase, ControlFrameSchema)
        })
      }
    })
  }
})

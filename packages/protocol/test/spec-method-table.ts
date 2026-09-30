/**
 * Parses the normative RCP/1 method tables out of docs/specs/rcp-v1.md so the
 * registry can be asserted against the spec instead of a hand-copied list
 * (task P7-C1). Test-only helper: never imported from `src/`.
 *
 * Sources of truth per section:
 * - §4: `### \`name\`` headings for `hello`, `ping`, `host.status` (unary, never mutating).
 * - §5/§6/§8/§9/§10: `| Method | Kind | … |` tables; `Kind` says `unary`/`stream`
 *   and contains `mutating` for mutating methods.
 * - §7: `| Message | Direction | Payload |` table. Only `device → host` rows are
 *   device-callable RCP methods (excludes the host-initiated `pair.*` messages);
 *   they are unary, and a `requestId` in the payload marks them mutating
 *   (§7 payloads, §11 idempotency column: `requestId`).
 * - §11: `| Method | Mutating | … |` summary; `Method` cells may use comma lists,
 *   slash groups (`sessions.list/search/…`) and prefix globs (`files.*`), and the
 *   `Mutating` cell may be `mixed`, resolved against the §4–§10 tables.
 */

export interface SpecMethod {
  name: string
  kind: 'unary' | 'stream'
  mutating: boolean
}

export interface SpecSummaryEntry {
  name: string
  mutating: boolean
}

/** Placeholder for markdown escaped pipes so cell splitting stays correct. */
const ESCAPED_PIPE = '\u0000'

function splitRow(line: string): string[] {
  return line
    .replaceAll('\\|', ESCAPED_PIPE)
    .split('|')
    .map((cell) => cell.replaceAll(ESCAPED_PIPE, '|').trim())
}

function backtickedTokens(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => {
    const token = match[1]
    if (token === undefined) throw new Error(`unreachable match group in: ${cell}`)
    return token
  })
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => cell === '' || /^:?-+:?$/.test(cell))
}

/** Splits the spec into sections keyed by their `## <number>.` heading number. */
function sectionsOf(specText: string): Map<number, string> {
  const sections = new Map<number, string>()
  let current: { number: number; lines: string[] } | undefined
  for (const line of specText.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      if (current) sections.set(current.number, current.lines.join('\n'))
      const match = /^## (\d+)\./.exec(line)
      current = match?.[1] === undefined ? undefined : { number: Number(match[1]), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) sections.set(current.number, current.lines.join('\n'))
  return sections
}

/** All markdown table rows of a section, separator rows removed. */
function tableRowsOf(section: string): string[][] {
  return section
    .split(/\r?\n/)
    .filter((line) => line.startsWith('|'))
    .map((line) => splitRow(line))
    .filter((cells) => !isSeparatorRow(cells))
}

function requireSection(sections: Map<number, string>, number: number, title: string): string {
  const section = sections.get(number)
  if (section === undefined) {
    throw new Error(`docs/specs/rcp-v1.md is missing the §${number} section (${title})`)
  }
  return section
}

function requireHeaderRow(rows: string[][], sectionNumber: number, mustInclude: string[]): number {
  const index = rows.findIndex((cells) => mustInclude.every((title) => cells.includes(title)))
  if (index === -1) {
    throw new Error(
      `docs/specs/rcp-v1.md §${sectionNumber} has no table with a ${mustInclude.join('/')} column`,
    )
  }
  return index
}

/** Expands `sessions.list/search/follow` into full method names. */
function expandSlashGroup(token: string): string[] {
  const parts = token.split('/')
  const head = parts[0]
  if (head === undefined || !head.includes('.')) {
    throw new Error(`cannot expand slash group "${token}" in spec §11`)
  }
  const base = head.slice(0, head.lastIndexOf('.') + 1)
  return parts.map((part, index) => (index === 0 ? head : base + part))
}

/** Expands `files.*` against the §4–§10 method universe (never the registry). */
function expandPrefixGlob(token: string, defined: SpecMethod[]): string[] {
  const prefix = token.slice(0, -1)
  const matches = defined.filter((method) => method.name.startsWith(prefix)).map((m) => m.name)
  if (matches.length === 0) throw new Error(`glob "${token}" in spec §11 matches no §4–§10 method`)
  return matches
}

/**
 * The ordered device-callable method list defined by spec §4–§10. Order follows
 * the spec (§4, then each section's table top to bottom); duplicates fail.
 */
export function parseSpecMethods(specText: string): SpecMethod[] {
  const sections = sectionsOf(specText)
  const methods: SpecMethod[] = []

  for (const match of requireSection(sections, 4, 'Session start').matchAll(/^### `([^`]+)`/gm)) {
    const name = match[1]
    if (name === undefined) throw new Error('unreachable match group in §4 heading')
    methods.push({ name, kind: 'unary', mutating: false })
  }

  const methodSections: ReadonlyArray<[number, string]> = [
    [5, 'Sessions'],
    [6, 'Workspaces and new sessions'],
    [8, 'Interaction (approvals and questions)'],
    [9, 'Files and diffs'],
    [10, 'Notifications'],
  ]
  for (const [number, title] of methodSections) {
    const rows = tableRowsOf(requireSection(sections, number, title))
    const header = requireHeaderRow(rows, number, ['Method', 'Kind'])
    for (const cells of rows.slice(header + 1)) {
      const tokens = backtickedTokens(cells[1] ?? '')
      if (tokens.length !== 1) {
        throw new Error(`§${number} method row must name exactly one method: ${cells.join(' | ')}`)
      }
      const kindCell = cells[2] ?? ''
      methods.push({
        name: tokens[0] as string,
        kind: kindCell.includes('stream') ? 'stream' : 'unary',
        mutating: kindCell.includes('mutating'),
      })
    }
  }

  const pairingRows = tableRowsOf(requireSection(sections, 7, 'Pairing and devices'))
  const pairingHeader = requireHeaderRow(pairingRows, 7, ['Message', 'Direction', 'Payload'])
  for (const cells of pairingRows.slice(pairingHeader + 1)) {
    if (!(cells[2] ?? '').includes('device → host')) continue // host-initiated pair.* messages
    const tokens = backtickedTokens(cells[1] ?? '')
    if (tokens.length !== 1) {
      throw new Error(`§7 message row must name exactly one message: ${cells.join(' | ')}`)
    }
    methods.push({
      name: tokens[0] as string,
      kind: 'unary',
      mutating: (cells[3] ?? '').includes('requestId'),
    })
  }

  const seen = new Set<string>()
  for (const method of methods) {
    if (seen.has(method.name)) throw new Error(`spec defines ${method.name} twice`)
    seen.add(method.name)
  }
  return methods
}

/**
 * The §11 summary as (name, mutating) pairs, with slash groups and prefix globs
 * expanded against `defined` (the §4–§10 parse) and `mixed` mutating cells
 * resolved the same way.
 */
export function parseSpecSummary(specText: string, defined: SpecMethod[]): SpecSummaryEntry[] {
  const rows = tableRowsOf(requireSection(sectionsOf(specText), 11, 'Method summary'))
  const header = requireHeaderRow(rows, 11, ['Method', 'Mutating'])
  const mutatingByName = new Map(defined.map((method) => [method.name, method.mutating]))

  const entries: SpecSummaryEntry[] = []
  for (const cells of rows.slice(header + 1)) {
    const mutatingCell = cells[2] ?? ''
    const names: string[] = []
    for (const token of backtickedTokens(cells[1] ?? '')) {
      if (token.includes('/')) names.push(...expandSlashGroup(token))
      else if (token.endsWith('.*')) names.push(...expandPrefixGlob(token, defined))
      else names.push(token)
    }
    if (names.length === 0) {
      throw new Error(`§11 row names no method: ${cells.join(' | ')}`)
    }
    for (const name of names) {
      let mutating: boolean
      if (mutatingCell === 'yes') mutating = true
      else if (mutatingCell === 'no') mutating = false
      else if (mutatingCell === 'mixed') {
        const resolved = mutatingByName.get(name)
        if (resolved === undefined) {
          throw new Error(`§11 "mixed" row names ${name}, which §4–§10 do not define`)
        }
        mutating = resolved
      } else throw new Error(`§11 Mutating cell must be yes/no/mixed, got "${mutatingCell}"`)
      entries.push({ name, mutating })
    }
  }
  return entries
}

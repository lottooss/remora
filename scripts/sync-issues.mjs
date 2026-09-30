#!/usr/bin/env node
// Create or update GitHub milestones, labels, and one issue per task packet from
// docs/tasks/*.md (the source of truth). Idempotent: issues are matched by the
// hidden marker `<!-- remora-task: <id> -->` in their body.
// Usage: node scripts/sync-issues.mjs [--dry-run] [--repo owner/name]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const root = join(import.meta.dirname, '..')
const tasksDir = join(root, 'docs', 'tasks')
const dryRun = process.argv.includes('--dry-run')
const repoArg = process.argv.indexOf('--repo')

const MILESTONES = {
  P0: ['P0 · Specify & Spike', 'Contracts drafted, six spikes answer the open assumptions, contracts frozen as v1.'],
  P1: ['P1 · Foundations', 'Protocol/crypto in TS + Kotlin pass vectors; relay core; host plugin loads in dsh; e2e harness.'],
  P2: ['P2 · Pairing & Sessions', 'Vertical slice on a real phone: pair, list, follow, prompt, stream, cancel.'],
  P3: ['P3 · Interaction & Safety', 'Approvals and questions from the phone, biometric signatures, Policy Guard, security suite.'],
  P4: ['P4 · Remote Work', 'New sessions in allowlisted roots, files and diffs.'],
  P5: ['P5 · Notifications & Always-on', 'FCM push, host-offline alerts, remora service, keep-awake.'],
  P6: ['P6 · Harden & Release', 'Reliability, performance, security sign-off, operations guide, v1.0.0.'],
  P7: ['P7 · Remediation & Real Integration', 'Make it actually work: unfakeable gates, fix the real dsh/phone integration, fill vectors, owner verification. Playbook: docs/SWARM.md.'],
}
const ROLE_COLORS = { integrator: '5319e7', 'protocol-crypto': 'b60205', relay: 'f9a03f', host: '0e8a16', android: '1d76db', verification: 'fbca04', owner: 'fef2c0' }
const KIND_COLORS = { spike: 'c2e0c6', feature: 'a2eeef', chore: 'ededed', test: 'd4c5f9', docs: 'bfdadc' }
const SIZE_COLORS = { S: 'e6f4ea', M: 'c5def5', L: 'f9d0c4' }
const EXTRA_LABELS = {
  'contract-change': ['d93f0b', 'Proposed change to a frozen spec, public protocol/crypto API, or vectors'],
  blocked: ['000000', 'Waiting on another task or an owner action'],
  'owner-action': ['fef2c0', 'Needs the repository owner (accounts, secrets, devices, approvals)'],
}

/** @param {string[]} args */
function gh(args) {
  return execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

function readTasks() {
  return readdirSync(tasksDir)
    .filter((name) => /^P\d-[A-Z]\d+\.md$/.test(name))
    .map((name) => {
      const text = readFileSync(join(tasksDir, name), 'utf8').replaceAll('\r\n', '\n')
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
      if (match === null) throw new Error(`${name}: missing front matter`)
      const meta = parseYaml(match[1])
      for (const key of ['id', 'title', 'phase', 'role', 'kind', 'size', 'depends_on', 'owned_paths']) {
        if (meta[key] === undefined) throw new Error(`${name}: front matter lacks "${key}"`)
      }
      if (`${meta.id}.md` !== name) throw new Error(`${name}: id ${meta.id} does not match the file name`)
      if (!(meta.phase in MILESTONES)) throw new Error(`${name}: unknown phase ${meta.phase}`)
      return { ...meta, body: match[2].trim() }
    })
}

/**
 * Order tasks so every task follows its dependencies (ties broken by id), so issue
 * numbers follow a valid execution order.
 * @param {Array<{ id: string, depends_on: string[] }>} tasks
 */
function topologicalOrder(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  for (const task of tasks) {
    for (const dep of task.depends_on) if (!byId.has(dep)) throw new Error(`${task.id}: unknown dependency ${dep}`)
  }
  const byIdOrder = (a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })
  const done = new Set()
  const ordered = []
  while (ordered.length < tasks.length) {
    const ready = tasks.filter((task) => !done.has(task.id) && task.depends_on.every((dep) => done.has(dep))).sort(byIdOrder)
    if (ready.length === 0) throw new Error('dependency cycle among task packets')
    const next = ready[0]
    done.add(next.id)
    ordered.push(next)
  }
  return ordered
}

function labelsFor(task) {
  const labels = [`phase:${task.phase}`, `role:${task.role}`, `kind:${task.kind}`, `size:${task.size}`]
  if (task.role === 'owner') labels.push('owner-action')
  if (task.wave !== undefined) labels.push(`wave:${task.wave}`)
  return labels
}

function issueBody(task, repo, numbers) {
  const deps = task.depends_on.length === 0
    ? 'none'
    : task.depends_on.map((id) => (numbers.has(id) ? `${id} (#${numbers.get(id)})` : id)).join(', ')
  return [
    `<!-- remora-task: ${task.id} -->`,
    `> Generated from [\`docs/tasks/${task.id}.md\`](https://github.com/${repo}/blob/main/docs/tasks/${task.id}.md) by \`scripts/sync-issues.mjs\`. Edit the packet, not this issue body.`,
    '',
    `| Role | Kind | Size | Wave | Depends on |`,
    `|---|---|---|---|---|`,
    `| ${task.role} | ${task.kind} | ${task.size} | ${task.wave ?? '-'} | ${deps} |`,
    '',
    `**Owned paths:** ${task.owned_paths.map((p) => `\`${p}\``).join(', ')}`,
    '',
    task.body,
  ].join('\n')
}

const repo = repoArg > 0 ? process.argv[repoArg + 1] : gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
const tasks = topologicalOrder(readTasks())
console.log(`${tasks.length} task packets → ${repo}${dryRun ? ' (dry run)' : ''}`)

// Labels.
const wantedLabels = new Map()
for (const phase of Object.keys(MILESTONES)) wantedLabels.set(`phase:${phase}`, ['0e8a16', MILESTONES[phase][0]])
for (const [role, color] of Object.entries(ROLE_COLORS)) wantedLabels.set(`role:${role}`, [color, `Owned by the ${role} role (AGENTS.md §3)`])
for (const [kind, color] of Object.entries(KIND_COLORS)) wantedLabels.set(`kind:${kind}`, [color, `Task kind: ${kind}`])
for (const [size, color] of Object.entries(SIZE_COLORS)) wantedLabels.set(`size:${size}`, [color, `Rough size ${size} (docs/tasks/README.md)`])
for (const [name, value] of Object.entries(EXTRA_LABELS)) wantedLabels.set(name, value)
for (const wave of new Set(tasks.map((t) => t.wave).filter((w) => w !== undefined))) {
  wantedLabels.set(`wave:${wave}`, ['0052cc', `Swarm wave ${wave} (docs/SWARM.md): start only when every earlier wave is merged`])
}
const existingLabels = new Set(dryRun ? [] : JSON.parse(gh(['label', 'list', '--repo', repo, '--limit', '500', '--json', 'name'])).map((l) => l.name))
for (const [name, [color, description]] of wantedLabels) {
  if (existingLabels.has(name)) continue
  console.log(`label + ${name}`)
  if (!dryRun) gh(['label', 'create', name, '--repo', repo, '--color', color, '--description', description])
}

// Milestones.
const existingMilestones = new Set(dryRun ? [] : JSON.parse(gh(['api', `repos/${repo}/milestones?state=all&per_page=100`])).map((m) => m.title))
for (const [title, description] of Object.values(MILESTONES)) {
  if (existingMilestones.has(title)) continue
  console.log(`milestone + ${title}`)
  if (!dryRun) gh(['api', '-X', 'POST', `repos/${repo}/milestones`, '-f', `title=${title}`, '-f', `description=${description}`])
}

// Issues: pass 1 creates/updates, pass 2 fills dependency issue numbers.
const existing = new Map()
if (!dryRun) {
  const issues = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '1000', '--json', 'number,body']))
  for (const issue of issues) {
    const marker = /<!-- remora-task: (P\d-[A-Z]\d+) -->/.exec(issue.body ?? '')
    if (marker !== null) existing.set(marker[1], issue)
  }
}
const numbers = new Map([...existing].map(([id, issue]) => [id, issue.number]))
const tmp = mkdtempSync(join(tmpdir(), 'remora-issues-'))
try {
  for (const pass of [1, 2]) {
    for (const task of tasks) {
      const title = `${task.id} · ${task.title}`
      const body = issueBody(task, repo, numbers)
      const bodyFile = join(tmp, `${task.id}.md`)
      writeFileSync(bodyFile, body)
      const milestone = MILESTONES[task.phase][0]
      const current = existing.get(task.id)
      if (current === undefined) {
        if (pass === 2) continue
        console.log(`issue + ${title}`)
        if (dryRun) continue
        const url = gh(['issue', 'create', '--repo', repo, '--title', title, '--body-file', bodyFile, '--milestone', milestone, ...labelsFor(task).flatMap((l) => ['--label', l])])
        const number = Number(url.split('/').pop())
        numbers.set(task.id, number)
        existing.set(task.id, { number, body })
      } else if (current.body !== body) {
        if (pass === 1 && dryRun) console.log(`issue ~ ${title} (#${current.number})`)
        if (dryRun) continue
        gh(['issue', 'edit', String(current.number), '--repo', repo, '--title', title, '--body-file', bodyFile, '--milestone', milestone, ...labelsFor(task).flatMap((l) => ['--add-label', l])])
        existing.set(task.id, { number: current.number, body })
        if (pass === 1) console.log(`issue ~ ${title} (#${current.number})`)
      }
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log('done')

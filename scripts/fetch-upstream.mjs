#!/usr/bin/env node
// Sparse, blobless, read-only checkout of the pinned DeepSeek Harness source into
// .upstream/deepseek-harness (git-ignored), at the tag in upstream.lock.json.
// Usage: node scripts/fetch-upstream.mjs [--all]   (--all disables sparse checkout)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const lock = JSON.parse(readFileSync(join(root, 'upstream.lock.json'), 'utf8'))
const dest = join(root, '.upstream', 'deepseek-harness')
const all = process.argv.includes('--all')

/** @param {string[]} args @param {string} [cwd] */
const git = (args, cwd = root) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim()

function currentTag() {
  try {
    return git(['describe', '--tags', '--exact-match', 'HEAD'], dest)
  } catch {
    // Not a git checkout, or HEAD is not exactly at a tag: treat as stale.
    return undefined
  }
}

if (existsSync(dest) && currentTag() !== lock.gitTag) {
  console.log(`removing stale checkout (${currentTag() ?? 'unknown'} ≠ ${lock.gitTag})`)
  rmSync(dest, { recursive: true, force: true })
}

if (!existsSync(dest)) {
  mkdirSync(join(root, '.upstream'), { recursive: true })
  console.log(`cloning ${lock.repository} @ ${lock.gitTag} …`)
  git(['clone', '--quiet', '--depth', '1', '--branch', lock.gitTag, '--filter=blob:none', ...(all ? [] : ['--sparse']), lock.repository, dest])
}

if (all) {
  git(['sparse-checkout', 'disable'], dest)
} else {
  git(['sparse-checkout', 'set', ...lock.sparsePaths], dest)
}

console.log(`upstream ready: ${dest}`)
console.log(`  tag ${lock.gitTag} (${git(['rev-parse', '--short=10', 'HEAD'], dest)}), npm ${lock.npmPackage}@${lock.npmVersion}`)
console.log(all ? '  full checkout' : `  sparse paths: ${lock.sparsePaths.join(', ')}`)

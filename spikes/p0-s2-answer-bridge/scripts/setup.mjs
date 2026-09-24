/**
 * Install @deepseek-ai/dsh@0.1.5-rc.3 into a local prefix, create the
 * remora-dev profile from the web template, and add the P0-S2 spike bundle.
 *
 * Idempotent. Run from anywhere:
 *   node scripts/setup.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(spikeRoot, '..', '..')
const installDir = join(spikeRoot, '.install')
const dshBin = join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const outDir = join(spikeRoot, 'out')
const DSH_VERSION = '0.1.5-rc.3'

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  })
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${cmd} ${args.join(' ')}`)
  }
  return result
}

mkdirSync(installDir, { recursive: true })
mkdirSync(outDir, { recursive: true })

const pkgPath = join(installDir, 'package.json')
if (!existsSync(pkgPath)) {
  writeFileSync(pkgPath, `${JSON.stringify({
    name: 'p0-s2-dsh-install',
    private: true,
    type: 'module',
  }, null, 2)}\n`)
}

console.log(`[setup] installing @deepseek-ai/dsh@${DSH_VERSION} …`)
run('npm', ['install', '--no-fund', '--no-audit', `@deepseek-ai/dsh@${DSH_VERSION}`], { cwd: installDir })

// Ensure the spike outDir is absolute in the bundle patch the profile will load.
const patchPath = join(spikeRoot, 'cordis.patch.yml')
let patch = readFileSync(patchPath, 'utf8')
patch = patch.replace(/outDir: ''/, `outDir: '${outDir.replaceAll('\\', '/')}'`)
writeFileSync(patchPath, patch)
console.log(`[setup] outDir → ${outDir}`)

const profile = 'remora-dev'
const profileDir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', profile)
const profileExists = existsSync(join(profileDir, 'package.json'))

if (!profileExists) {
  console.log(`[setup] creating profile ${profile} from web template …`)
  run(dshBin, [
    '--profile', profile,
    '--from-default-profile', 'web',
    '--dump-config',
  ], { cwd: repoRoot })
} else {
  console.log(`[setup] profile ${profile} already exists`)
}

console.log('[setup] adding spike bundle …')
run(dshBin, [
  'plugin', '--profile', profile,
  'add', spikeRoot.replaceAll('\\', '/'),
], { cwd: repoRoot })

console.log('[setup] done')
console.log(`  dsh:   ${dshBin}`)
console.log(`  out:   ${outDir}`)
console.log(`  start: node scripts/run-experiments.mjs`)

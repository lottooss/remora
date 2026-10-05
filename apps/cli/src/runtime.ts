import fs from 'node:fs'
import path from 'node:path'
import { getRuntimeDir } from './paths.ts'
import { CliUsageError } from './options.ts'

/** Matches upstream.lock.json; updating it requires dsh compatibility review. */
export const PINNED_DSH_VERSION = '0.1.5-rc.3'

/** Locate the dedicated runtime without relying on mutable global PATH shims. */
export function resolveDshRuntime(version: string = PINNED_DSH_VERSION): string {
  if (version !== PINNED_DSH_VERSION) {
    throw new CliUsageError(`This release requires dsh ${PINNED_DSH_VERSION}.`)
  }
  const packageDir = path.join(getRuntimeDir(), 'node_modules', '@deepseek-ai', 'dsh')
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || !('name' in manifest) ||
        manifest.name !== '@deepseek-ai/dsh' || !('version' in manifest) || manifest.version !== version ||
        !('bin' in manifest) || typeof manifest.bin !== 'object' || manifest.bin === null ||
        !('dsh' in manifest.bin) || manifest.bin.dsh !== 'lib/bin.js') throw new Error('Invalid runtime')
    const entry = path.join(packageDir, 'lib', 'bin.js')
    if (!fs.statSync(entry).isFile()) throw new Error('Missing runtime')
    return entry
  } catch {
    throw new CliUsageError(`Install @deepseek-ai/dsh@${version} into the dedicated Remora runtime first; see docs/runbooks/operations.md section 3.`)
  }
}

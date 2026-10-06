import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { Feature } from '@remora/protocol'
import type { PolicyGuard } from '../policy/index.ts'
import type { HostRuntimeProvider } from '../rcp/index.ts'

const DshManifestSchema = z.object({
  name: z.literal('@deepseek-ai/dsh'),
  version: z.string().min(1),
})
const ProfileManifestSchema = z.object({
  dsh: z.object({ profile: z.object({ bundles: z.array(z.string()) }) }),
})

interface RuntimeOptions {
  remoraVersion: string
  features: readonly Feature[]
  policyGuard: PolicyGuard
  isKeepAwakeAcquired(): boolean
}

/**
 * Reads the pinned CLI's actual manifest and app-boot root profile, without
 * importing a second dsh runtime or guessing from the lockfile/process cwd.
 * Unknown launchers fail closed; their metadata needs a verified adapter seam.
 */
async function readDshMetadata(ctx: Context): Promise<{ version: string; profile: string }> {
  const baseUrl = ctx.root.baseUrl
  const executable = process.argv[1]
  if (!baseUrl || !executable) throw new Error('dsh launch metadata unavailable')
  const rootUrl = new URL(baseUrl)
  if (rootUrl.protocol !== 'file:') throw new Error('dsh profile URL unavailable')
  const profileDir = fileURLToPath(rootUrl)
  // app-boot sets root.baseUrl to dirname(profile/cordis.yml). The profile
  // manifest check rejects a generic Cordis context with an arbitrary cwd.
  ProfileManifestSchema.parse(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')))
  const profile = basename(profileDir)
  if (!profile) throw new Error('dsh profile name unavailable')
  // apps/cli/src/bin.ts and the installed lib/bin.js both read ../package.json.
  // Resolve a launcher symlink before applying that same documented layout.
  const binary = await realpath(executable)
  const manifest = DshManifestSchema.parse(JSON.parse(await readFile(join(dirname(binary), '..', 'package.json'), 'utf8')))
  return { version: manifest.version, profile }
}

/** Binds RCP metadata to the loaded policy and current dsh agent/OS state. */
export function createDshRuntimeProvider(ctx: Context, options: RuntimeOptions): HostRuntimeProvider {
  let metadata: Promise<{ version: string; profile: string }> | undefined
  const readMetadata = () => metadata ??= readDshMetadata(ctx)
  return {
    async hello() {
      const dsh = await readMetadata()
      const platform = process.platform
      if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
        throw new Error('unsupported host platform')
      }
      return {
        os: platform,
        pathSeparator: sep === '\\' ? '\\' : '/',
        versions: { remora: options.remoraVersion, dsh: dsh.version },
        features: options.features,
        roots: options.policyGuard.remoteRoots,
        policy: {
          approvalBiometric: options.policyGuard.approvalBiometric,
          allowRemoteSessionStart: options.policyGuard.allowRemoteSessionStart,
        },
      }
    },
    async status() {
      const dsh = await readMetadata()
      return {
        agentsRunning: ctx.agents.list().filter((agent) => agent.status === 'running').length,
        keepAwake: options.isKeepAwakeAcquired(),
        dsh,
      }
    },
  }
}

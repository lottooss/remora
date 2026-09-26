import fs from 'node:fs'
import path from 'node:path'
import {
  FsBrowseParamsSchema,
  FsMkdirParamsSchema,
  RCP_ERROR_CODES,
  createRcpError,
} from '@remora/protocol'
import type { PolicyGuard } from '../../policy/index.ts'
import {
  gatewayDirectoryPickerCreateDirectory,
  gatewayDirectoryPickerList,
  type TypertGateway,
} from '../../adapter/gateway.ts'
import { RcpMethodError, type RcpServer } from '../index.ts'

export interface FsAdapterOptions {
  gateway?: TypertGateway | undefined
  policyGuard: PolicyGuard
  now?: () => number
}

export class FsAdapter {
  private readonly gateway?: TypertGateway | undefined
  private readonly policyGuard: PolicyGuard
  private readonly now: () => number
  private readonly mkdirDedupeCache = new Map<string, { result: { path: string }; time: number }>()

  constructor(options: FsAdapterOptions) {
    this.gateway = options.gateway
    this.policyGuard = options.policyGuard
    this.now = options.now ?? Date.now
  }

  /**
   * fs.browse (RCP/1 §6)
   * Without path: returns the configured remote roots.
   * With path: returns directory entries inside the root.
   */
  async browse(params: { path?: string | undefined }): Promise<{
    path: string | null
    parent: string | null
    entries: { name: string; kind: 'dir' | 'file' | 'link' }[]
    truncated: boolean
  }> {
    if (!params.path) {
      return {
        path: null,
        parent: null,
        entries: this.policyGuard.remoteRoots.map((root) => ({
          name: root,
          kind: 'dir' as const,
        })),
        truncated: false,
      }
    }

    const canonicalPath = this.policyGuard.canonicalizePath(params.path)
    if (!this.policyGuard.checkPathAccess(canonicalPath)) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.forbidden, 'path outside roots'),
      )
    }

    const parentDir = path.dirname(canonicalPath)
    const parent =
      parentDir !== canonicalPath && this.policyGuard.checkPathAccess(parentDir)
        ? parentDir
        : null

    if (this.gateway) {
      try {
        const listing = await gatewayDirectoryPickerList(this.gateway, { path: canonicalPath })
        return {
          path: canonicalPath,
          parent,
          entries: listing.entries.map((e) => ({
            name: e.name,
            kind: 'dir' as const,
          })),
          truncated: listing.truncated,
        }
      } catch (err) {
        if (err instanceof RcpMethodError) throw err
        // Fall back to node filesystem listing
      }
    }

    try {
      const dirents = await fs.promises.readdir(canonicalPath, { withFileTypes: true })
      const entries = dirents
        .map((d) => ({
          name: d.name,
          kind: (d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file') as 'dir' | 'file' | 'link',
        }))
        .sort((a, b) => a.name.localeCompare(b.name))

      return {
        path: canonicalPath,
        parent,
        entries,
        truncated: false,
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new RcpMethodError(
          createRcpError(RCP_ERROR_CODES.not_found, `directory '${params.path}' not found`),
        )
      }
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw new RcpMethodError(
          createRcpError(RCP_ERROR_CODES.forbidden, `permission denied for '${params.path}'`),
        )
      }
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.internal_error, `failed to list directory '${params.path}'`),
      )
    }
  }

  /**
   * fs.mkdir (RCP/1 §6)
   * Creates a directory inside an allowlisted root.
   */
  async mkdir(params: {
    parent: string
    name: string
    requestId: string
  }): Promise<{ path: string }> {
    if (!this.policyGuard.allowRemoteSessionStart) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.forbidden, 'remote session start is disabled'),
      )
    }

    const name = params.name
    if (!name || name.trim() === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.invalid_params, 'name must be a single path segment'),
      )
    }

    const canonicalParent = this.policyGuard.canonicalizePath(params.parent)
    if (!this.policyGuard.checkPathAccess(canonicalParent)) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.forbidden, 'path outside roots'),
      )
    }

    const targetPath = path.join(canonicalParent, name)

    const cached = this.mkdirDedupeCache.get(params.requestId)
    if (cached) {
      return cached.result
    }

    let createdPath: string
    if (this.gateway) {
      try {
        createdPath = await gatewayDirectoryPickerCreateDirectory(this.gateway, {
          path: canonicalParent,
          name,
        })
      } catch (err) {
        if (err instanceof RcpMethodError) throw err
        try {
          await fs.promises.mkdir(targetPath, { recursive: false })
          createdPath = targetPath
        } catch (mErr: any) {
          if (mErr.code === 'EEXIST') {
            throw new RcpMethodError(
              createRcpError(RCP_ERROR_CODES.conflict, `directory already exists: '${name}'`),
            )
          }
          throw mErr
        }
      }
    } else {
      try {
        await fs.promises.mkdir(targetPath, { recursive: false })
        createdPath = targetPath
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          throw new RcpMethodError(
            createRcpError(RCP_ERROR_CODES.conflict, `directory already exists: '${name}'`),
          )
        }
        throw new RcpMethodError(
          createRcpError(RCP_ERROR_CODES.internal_error, `failed to create directory '${name}'`),
        )
      }
    }

    const canonicalTarget = this.policyGuard.canonicalizePath(createdPath)
    if (!this.policyGuard.checkPathAccess(canonicalTarget)) {
      await fs.promises.rm(createdPath, { recursive: true, force: true }).catch(() => {})
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.forbidden, 'path outside roots'),
      )
    }

    const result = { path: canonicalTarget }
    this.mkdirDedupeCache.set(params.requestId, { result, time: this.now() })
    return result
  }
}

export function registerFsMethods(rcpServer: RcpServer, adapter: FsAdapter): void {
  rcpServer.registerMethod('fs.browse', async (p) => {
    const parsed = FsBrowseParamsSchema.safeParse(p ?? {})
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid fs.browse params'))
    }
    return await adapter.browse(parsed.data)
  })

  rcpServer.registerMethod('fs.mkdir', async (p) => {
    const parsed = FsMkdirParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid fs.mkdir params'))
    }
    return await adapter.mkdir(parsed.data)
  })
}

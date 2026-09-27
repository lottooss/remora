/**
 * Workspace adapter (RCP/1 §6, blueprint §11.6, dsh-integration §4):
 * Manages workspaces and directories through dsh TypertGateway and PolicyGuard:
 * - workspaces.follow (stream: baseline, upsert, removed) with remoteAllowed computed
 * - workspaces.create (idempotent, guarded by roots and allowRemoteSessionStart)
 * - workspaces.list (unary, list of current workspaces)
 */
import {
  RCP_ERROR_CODES,
  createRcpError,
  type Workspace,
} from '@remora/protocol'
import type { PolicyGuard } from '../policy/index.ts'
import { RcpMethodError, type RcpStreamSink } from '../rcp/index.ts'
import {
  gatewayWorkspaceCreate,
  gatewayWorkspaceFollow,
  type TypertGateway,
} from './gateway.ts'

export interface WorkspaceAdapterOptions {
  gateway: TypertGateway
  policyGuard: PolicyGuard
  now?: () => number
}

export class WorkspaceAdapter {
  private readonly gateway: TypertGateway
  private readonly policyGuard: PolicyGuard
  private readonly now: () => number
  private readonly createDedupeCache = new Map<string, { result: { workspace: Workspace; created: boolean }; time: number }>()
  private readonly workspacesById = new Map<string, Workspace>()

  constructor(options: WorkspaceAdapterOptions) {
    this.gateway = options.gateway
    this.policyGuard = options.policyGuard
    this.now = options.now ?? Date.now
  }

  /** Registers or updates an existing known workspace */
  addWorkspace(workspace: Workspace): void {
    this.workspacesById.set(workspace.id, {
      ...workspace,
      remoteAllowed: this.policyGuard.checkPathAccess(workspace.path),
    })
  }

  /** Gets a workspace by ID if known */
  async get(workspaceId: string): Promise<Workspace | undefined> {
    return this.workspacesById.get(workspaceId)
  }

  /**
   * workspaces.list (RCP/1 §6)
   */
  async list(): Promise<{ workspaces: Workspace[] }> {
    return {
      workspaces: Array.from(this.workspacesById.values()).map((ws) => ({
        ...ws,
        remoteAllowed: this.policyGuard.checkPathAccess(ws.path),
      })),
    }
  }

  /**
   * workspaces.create (RCP/1 §6)
   * Guarded: path must be inside roots, allowRemoteSessionStart must be true.
   * Idempotent by requestId.
   */
  async create(params: {
    path: string
    requestId: string
  }): Promise<{ workspace: Workspace; created: boolean }> {
    if (!this.policyGuard.allowRemoteSessionStart) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.forbidden, 'remote session start is disabled'),
      )
    }

    const canonicalPath = this.policyGuard.canonicalizePath(params.path)
    if (!this.policyGuard.checkPathAccess(canonicalPath)) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.forbidden, 'path outside roots'),
      )
    }

    const cached = this.createDedupeCache.get(params.requestId)
    if (cached) {
      return cached.result
    }

    const res = await gatewayWorkspaceCreate(this.gateway, { path: canonicalPath })
    const workspace: Workspace = {
      id: res.workspace.workspaceId,
      title: res.workspace.title,
      path: res.workspace.path,
      remoteAllowed: this.policyGuard.checkPathAccess(res.workspace.path),
    }
    this.workspacesById.set(workspace.id, workspace)

    const result = { workspace, created: res.created }
    this.createDedupeCache.set(params.requestId, { result, time: this.now() })
    return result
  }

  /**
   * workspaces.follow (RCP/1 §6)
   * Streams baseline and updates to the client sink.
   */
  async follow(sink: RcpStreamSink): Promise<void> {
    const stream = await gatewayWorkspaceFollow(this.gateway, sink.signal)

    for await (const rawFrame of stream) {
      if (sink.signal.aborted) break
      const frame = rawFrame as any
      if (!frame || typeof frame !== 'object') continue

      if (frame.type === 'baseline') {
        const items = (frame.value?.items ?? []) as any[]
        const workspaces: Workspace[] = items.map((item) => {
          const ws: Workspace = {
            id: item.workspaceId,
            title: item.title,
            path: item.path,
            remoteAllowed: this.policyGuard.checkPathAccess(item.path),
          }
          this.workspacesById.set(ws.id, ws)
          return ws
        })
        await sink.sendItem({ type: 'baseline', workspaces })
      } else if (frame.type === 'upsert' && frame.workspace) {
        const item = frame.workspace
        const ws: Workspace = {
          id: item.workspaceId,
          title: item.title,
          path: item.path,
          remoteAllowed: this.policyGuard.checkPathAccess(item.path),
        }
        this.workspacesById.set(ws.id, ws)
        await sink.sendItem({ type: 'upsert', workspace: ws })
      } else if (frame.type === 'remove' && frame.workspaceId) {
        this.workspacesById.delete(frame.workspaceId)
        await sink.sendItem({ type: 'removed', id: frame.workspaceId })
      }
    }
  }
}

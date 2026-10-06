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
    // RcpServer waits for this method before returning sid. Consume the live
    // iterator in the background; its signal is aborted on cancel/disconnect.
    void (async () => {
      try {
        for await (const rawFrame of stream) {
          if (sink.signal.aborted) break
          if (!isRecord(rawFrame)) throw new Error('invalid workspace stream frame')
          if (rawFrame['type'] === 'baseline') {
            const value = rawFrame['value']
            if (!isRecord(value) || !Array.isArray(value['items'])) throw new Error('invalid workspace baseline')
            const workspaces = value['items'].map((item: unknown) => this.mapWorkspace(item))
            // A reconnect baseline replaces the entire cache, including removals.
            this.workspacesById.clear()
            for (const workspace of workspaces) this.workspacesById.set(workspace.id, workspace)
            if (!await sink.sendItem({ type: 'baseline', workspaces })) throw new Error('workspace delivery failed')
          } else if (rawFrame['type'] === 'upsert') {
            const workspace = this.mapWorkspace(rawFrame['workspace'])
            this.workspacesById.set(workspace.id, workspace)
            if (!await sink.sendItem({ type: 'upsert', workspace })) throw new Error('workspace delivery failed')
          } else if (rawFrame['type'] === 'remove') {
            const id = rawFrame['workspaceId']
            if (typeof id !== 'string' || id.length === 0) throw new Error('invalid workspace removal')
            this.workspacesById.delete(id)
            if (!await sink.sendItem({ type: 'removed', id })) throw new Error('workspace delivery failed')
          }
          // dsh order/archive frames do not change RCP's workspace row shape.
        }
        if (!sink.signal.aborted) await sink.end(true)
      } catch {
        if (!sink.signal.aborted) {
          await sink.end(false, createRcpError(RCP_ERROR_CODES.internal_error, 'workspace stream failed'))
        }
      }
    })().catch(() => { /* The channel may close while the terminal frame is sent. */ })
  }

  private mapWorkspace(value: unknown): Workspace {
    if (!isRecord(value) || typeof value['workspaceId'] !== 'string' || value['workspaceId'].length === 0
      || typeof value['title'] !== 'string' || typeof value['path'] !== 'string') {
      throw new Error('invalid workspace stream row')
    }
    return {
      id: value['workspaceId'],
      title: value['title'],
      path: value['path'],
      remoteAllowed: this.policyGuard.checkPathAccess(value['path']),
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

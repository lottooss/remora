export interface KeepAwakeDriver {
  acquire(): void
  release(): void
  readonly isAcquired: boolean
}

export class NoopKeepAwakeDriver implements KeepAwakeDriver {
  private _isAcquired = false

  acquire(): void {
    this._isAcquired = true
  }

  release(): void {
    this._isAcquired = false
  }

  get isAcquired(): boolean {
    return this._isAcquired
  }
}

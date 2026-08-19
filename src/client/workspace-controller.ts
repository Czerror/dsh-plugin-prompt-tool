export interface PromptToolWorkspaceSnapshot {
  open: boolean
}

/** 侧边栏入口与中央列工作台共享的轻量开关状态。 */
export class PromptToolWorkspaceController {
  private snapshot: PromptToolWorkspaceSnapshot = { open: false }
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): PromptToolWorkspaceSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open(): void { this.setOpen(true) }
  close(): void { this.setOpen(false) }
  toggle(): void { this.setOpen(!this.snapshot.open) }

  private setOpen(open: boolean): void {
    if (this.snapshot.open === open) return
    this.snapshot = { open }
    for (const listener of this.listeners) listener()
  }
}

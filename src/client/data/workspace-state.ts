import type { GlobalWorkspaceStore } from './use-prompt-tool-store.ts'

export interface WorkspaceStoreHolder {
  subscribe(listener: () => void): () => void
  getSnapshot(): GlobalWorkspaceStore | undefined
  publish(store: GlobalWorkspaceStore): void
  dispose(): void
}

export function createWorkspaceStoreHolder(): WorkspaceStoreHolder {
  let current: GlobalWorkspaceStore | undefined
  let disposed = false
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  return {
    subscribe(listener) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => current,
    publish(store) {
      if (disposed || current === store) return
      current = store
      notify()
    },
    dispose() {
      if (disposed) return
      disposed = true
      current = undefined
      listeners.clear()
    },
  }
}

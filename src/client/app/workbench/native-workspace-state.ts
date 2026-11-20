import { createWorkspaceBrowseState } from '../workspace/workspace-browse-state.ts'

/** 三个入口共享导航；正文草稿归数据 owner。 */
export function createWorkspaceViewState() {
  return { browse: createWorkspaceBrowseState() }
}

export type WorkspaceViewState = ReturnType<typeof createWorkspaceViewState>

/** 只绑定实际可见槽位；隐藏的右侧 tab 不得改变操作会话。 */
export function createNativeWorkspaceState() {
  let snapshot = { active: false }
  const surfaces = new Set<symbol>()
  const view = createWorkspaceViewState()
  const listeners = new Set<() => void>()
  const publish = (): void => {
    const active = surfaces.size > 0
    if (snapshot.active === active) return
    snapshot = { active }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    mount(id: symbol) {
      surfaces.add(id)
      publish()
      return () => { surfaces.delete(id); publish() }
    },
    view,
    dispose() { surfaces.clear(); listeners.clear() },
  }
}

export type NativeWorkspaceState = ReturnType<typeof createNativeWorkspaceState>

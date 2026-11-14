import { createWorkspaceBrowseState } from '../workspace/workspace-browse-state.ts'
import type { WorkspacePage } from '../workspace/workspace-pages.ts'

/** 同一前台会话的三个入口共享导航；正文草稿归数据 owner。 */
export function createWorkspaceViewState() {
  let page: WorkspacePage = 'features'
  const listeners = new Set<() => void>()
  return {
    browse: createWorkspaceBrowseState(),
    getSnapshot: () => page,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    select(next: WorkspacePage) {
      if (page === next) return
      page = next
      for (const listener of listeners) listener()
    },
  }
}

export type WorkspaceViewState = ReturnType<typeof createWorkspaceViewState>

/** 只绑定实际可见槽位；隐藏的右侧 tab 不得改变操作会话。 */
export function createNativeWorkspaceState() {
  let snapshot: { active: boolean; sessionId?: string } = { active: false }
  const surfaces = new Map<symbol, string | undefined>()
  const views = new Map<string, WorkspaceViewState>()
  const listeners = new Set<() => void>()
  const publish = (): void => {
    const active = surfaces.size > 0
    const sessionId = active ? [...surfaces.values()].at(-1) : snapshot.sessionId
    if (snapshot.active === active && snapshot.sessionId === sessionId) return
    snapshot = { active, sessionId }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    mount(id: symbol, sessionId: string | undefined) {
      surfaces.set(id, sessionId)
      publish()
      return () => { surfaces.delete(id); publish() }
    },
    view(sessionId: string | undefined) {
      const key = sessionId ?? ''
      let view = views.get(key)
      if (view === undefined) { view = createWorkspaceViewState(); views.set(key, view) }
      return view
    },
    dispose() { surfaces.clear(); views.clear(); listeners.clear() },
  }
}

export type NativeWorkspaceState = ReturnType<typeof createNativeWorkspaceState>

/** 仅保留可恢复的浏览上下文；确认、导入、拖拽与业务草稿仍由各自 owner 管理。 */
export interface ConfigPageBrowse {
  filter: string
  viewFilter: string
  expanded?: string
  variablesExpanded: boolean
  feedback?: { kind: 'ok' | 'error'; message: string }
}

export function createWorkspaceBrowseState() {
  let diagnosticsOpen = false
  const diagnosticsListeners = new Set<() => void>()
  return {
    diagnosticsResults: {
      getSnapshot: () => diagnosticsOpen,
      subscribe(listener: () => void) { diagnosticsListeners.add(listener); return () => { diagnosticsListeners.delete(listener) } },
      toggle() {
        diagnosticsOpen = !diagnosticsOpen
        for (const listener of diagnosticsListeners) listener()
      },
    },
    configs: new Map<string, ConfigPageBrowse>(),
    scroll: new Map<string, number>(),
    tools: { query: '', selectedId: '', expanded: {} as Record<string, boolean> },
  }
}

export function configPageBrowse(state: ReturnType<typeof createWorkspaceBrowseState>, key: string): ConfigPageBrowse {
  let value = state.configs.get(key)
  if (value === undefined) {
    value = { filter: '', viewFilter: 'all', variablesExpanded: false }
    state.configs.set(key, value)
  }
  return value
}

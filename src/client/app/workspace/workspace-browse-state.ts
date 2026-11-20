import type { RuleDiagnosticTarget } from '../../data/rule-diagnostics-session.ts'

/** 仅保留可恢复的浏览上下文；确认、导入、拖拽与业务草稿仍由各自 owner 管理。 */
export interface ConfigPageBrowse {
  filter: string
  viewFilter: string
  expanded?: string
  allModules?: boolean
  rulesScroll?: number
  ruleNodes?: Map<string, string>
  ruleCanvas?: Map<string, { scale: number; x: number; y: number; positions: Record<string, { x: number; y: number }> }>
  combination?: boolean
  diagnosticTarget?: RuleDiagnosticTarget
  publish(): void
  subscribe(listener: () => void): () => void
  revision(): number
  variablesExpanded: boolean
  feedback?: { kind: 'ok' | 'error'; message: string }
}

export function createWorkspaceBrowseState() {
  let diagnosticsOpen = false
  const diagnosticsListeners = new Set<() => void>()
  let moduleId: string | undefined
  const moduleListeners = new Set<() => void>()
  return {
    audience: 'features' as 'features' | 'subagent',
    moduleManager: {
      getSnapshot: () => moduleId,
      subscribe(listener: () => void) { moduleListeners.add(listener); return () => { moduleListeners.delete(listener) } },
      select(id: string) { if (id !== moduleId) { moduleId = id; for (const listener of moduleListeners) listener() } },
    },
    diagnosticsResults: {
      getSnapshot: () => diagnosticsOpen,
      subscribe(listener: () => void) { diagnosticsListeners.add(listener); return () => { diagnosticsListeners.delete(listener) } },
      toggle() {
        diagnosticsOpen = !diagnosticsOpen
        for (const listener of diagnosticsListeners) listener()
      },
    },
    configs: new Map<string, ConfigPageBrowse>(),
    diagnosticReturn: undefined as RuleDiagnosticTarget | undefined,
    scroll: new Map<string, number>(),
  }
}

export function configPageBrowse(state: ReturnType<typeof createWorkspaceBrowseState>, key: string): ConfigPageBrowse {
  let value = state.configs.get(key)
  if (value === undefined) {
    const listeners = new Set<() => void>()
    let revision = 0
    value = {
      filter: '', viewFilter: 'all', variablesExpanded: false,
      ruleCanvas: new Map(),
      publish() { revision++; for (const listener of listeners) listener() },
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      revision: () => revision,
    }
    state.configs.set(key, value)
  }
  return value
}

import type { SkillStatusTab } from '../../features/skills/skill-status.ts'

/** 仅保留可恢复的浏览上下文；确认、导入、拖拽与业务草稿仍由各自 owner 管理。 */
export interface ConfigPageBrowse {
  filter: string
  viewFilter: string
  expanded?: string
  variablesExpanded: boolean
  feedback?: { kind: 'ok' | 'error'; message: string }
}

export function createWorkspaceBrowseState() {
  return {
    configs: new Map<string, ConfigPageBrowse>(),
    scroll: new Map<string, number>(),
    skills: { query: '', status: 'all' as SkillStatusTab },
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

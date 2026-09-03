export interface PolicyDraft {
  defaultProfile?: string
  ceiling?: { allow?: string[]; deny?: string[] }
  profiles?: Array<{ id: string; name?: string; allow?: string[]; deny?: string[]; modelSelectable?: boolean }>
  characterBindings?: Array<{ characterId: string; profile: string; modelSelectable?: boolean }>
  taskRules?: Array<{ id: string; name?: string; pattern: string; profile: string; order?: number; modelSelectable?: boolean }>
  modelExpansion?: { enabled?: boolean; allow?: string[]; maxAdditionalTools?: number; requireApproval?: boolean }
}

export const asList = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : []
export const asBool = (value: unknown): boolean => value === true
export const asNum = (value: unknown): number => Number.isSafeInteger(value) ? value as number : 0
export const splitList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)

/** 空策略骨架（首次启用的一键初始化：default 从现有 toolFilterAllow 复制）。 */
export function createEmptyPolicy(seedAllow: string): PolicyDraft {
  return {
    defaultProfile: 'base',
    ceiling: { allow: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search'], deny: [] },
    profiles: [{
      id: 'base',
      name: '基础',
      allow: splitList(seedAllow),
      deny: [],
      modelSelectable: false,
    }],
    characterBindings: [],
    taskRules: [],
    modelExpansion: { enabled: false, allow: [], maxAdditionalTools: 2, requireApproval: true },
  }
}

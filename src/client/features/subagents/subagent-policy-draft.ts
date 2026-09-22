import type { PolicyDraft } from '../../data/workspace-drafts.ts'
export type { PolicyDraft } from '../../data/workspace-drafts.ts'

export const asList = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : []
export const asBool = (value: unknown): boolean => value === true
export const asNum = (value: unknown): number => Number.isSafeInteger(value) ? value as number : 0
export const splitList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)

/** 空策略骨架（首次启用的一键初始化：`seedAllow` 由调用方给出，如能力卡当前的授权上限）。 */
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

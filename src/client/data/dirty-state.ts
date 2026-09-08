/** 客户端脏检测、保存快照与保存后重载判定（纯逻辑）。 */
import type { PromptConfigDraft } from '../prompt-tool-types.ts'
import { ENGINE_PARAM_KEYS, type EngineParamKey } from '../../shared/engine-params.ts'
import { EMPTY_FIELDS, hasIncompleteStageDrafts, type Fields } from './prompt-tool-fields.ts'

const SETTINGS_SNAPSHOT_KEYS = [
  'injectAgentsPrompt', 'skillSwitches', 'skillOrder', 'skillsDirs', 'skillRankBase',
  'residentAgentsPath', 'presetDir', 'presetOrder', 'fallbackText', 'writeAgents', 'writePreset',
] as const
export type SwitchSnapshot = Pick<Fields, EngineParamKey | typeof SETTINGS_SNAPSHOT_KEYS[number]>

/** 全量参数自动进入快照；结构化复制隔离保存期间继续编辑的数组和对象。 */
export function snapshotSwitches(fields: Fields): SwitchSnapshot {
  return structuredClone(Object.fromEntries([...ENGINE_PARAM_KEYS, ...SETTINGS_SNAPSHOT_KEYS]
    .map((key) => [key, fields[key]]))) as SwitchSnapshot
}

export const EMPTY_SWITCHES = snapshotSwitches(EMPTY_FIELDS)

/** 两个空数组不算脏，防止首屏自动保存清空已有提示词配置。 */
export const promptConfigsDirty = (current: PromptConfigDraft[], saved: PromptConfigDraft[]): boolean =>
  current !== saved && !(current.length === 0 && saved.length === 0)

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 深比较 snapshot 内的数组/record；不使用 JSON.stringify，避免键顺序影响脏检测。 */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (isPlainRecord(a) || isPlainRecord(b)) {
    if (!isPlainRecord(a) || !isPlainRecord(b)) return false
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) if (!deepEqual(a[key], b[key])) return false
    return true
  }
  return false
}

export const switchesEqual = (a: SwitchSnapshot, b: SwitchSnapshot): boolean => deepEqual(a, b)

/** 参数保存后仅在草稿未继续变化且没有未完成阶段时重载。 */
export const shouldReloadAfterParamSave = (current: SwitchSnapshot, saved: SwitchSnapshot): boolean =>
  switchesEqual(current, saved) && !hasIncompleteStageDrafts(saved.stages)

/** 任一通道出现新草稿时，旧保存响应不得触发全量重载。 */
export const shouldReloadAfterPresetSave = (
  savedDraftVersion: number,
  currentDraftVersion: number,
  otherDraftsClean: boolean,
): boolean => savedDraftVersion === currentDraftVersion && otherDraftsClean

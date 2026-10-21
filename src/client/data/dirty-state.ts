/** 客户端脏检测、保存快照与保存后重载判定（纯逻辑）。 */
import { EMPTY_FIELDS, SHARED_PARAM_KEYS, type Fields, type SharedParamKey } from './prompt-tool-fields.ts'

const SETTINGS_SNAPSHOT_KEYS = [
  'modulesEnabled',
] as const
export type SwitchSnapshot = Pick<Fields, SharedParamKey | typeof SETTINGS_SNAPSHOT_KEYS[number]>

/** 公共参数进入快照；规则模型参数不参与公共通道脏检测。 */
export function snapshotSwitches(fields: Fields): SwitchSnapshot {
  return structuredClone(Object.fromEntries([...SHARED_PARAM_KEYS, ...SETTINGS_SNAPSHOT_KEYS]
    .map((key) => [key, fields[key]]))) as SwitchSnapshot
}

export const EMPTY_SWITCHES = snapshotSwitches(EMPTY_FIELDS)

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

/** 任一通道出现新草稿时，旧保存响应不得触发全量重载。 */
export const shouldReloadAfterModuleSave = (
  savedDraftVersion: number,
  currentDraftVersion: number,
  otherDraftsClean: boolean,
): boolean => savedDraftVersion === currentDraftVersion && otherDraftsClean

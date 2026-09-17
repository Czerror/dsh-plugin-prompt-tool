/** settings/bootstrap 载荷到客户端 Fields 的纯映射。 */
import type { PromptConfigDraft } from '../prompt-tool-types.ts'
import type { BridgeResult, BridgeSettingsView } from './bridge-transport.ts'
import { EMPTY_FIELDS, type Fields, type SkillCatalogEntry } from './prompt-tool-fields.ts'
import { readParamOverridesPatch } from './param-overrides.ts'
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const readString = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

const readStringArray = (source: Record<string, unknown>, key: string): string[] => {
  const value = source[key]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

const readBoolean = (source: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const value = source[key]
  return typeof value === 'boolean' ? value : fallback
}

const readNumber = (source: Record<string, unknown>, key: string, fallback: number): number => {
  const value = source[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

const readSkillCatalog = (source: Record<string, unknown>, key: string): SkillCatalogEntry[] => {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const id = readString(record, 'id')
    const name = readString(record, 'name')
    const folder = readString(record, 'folder')
    const dir = readString(record, 'dir')
    const kind = readString(record, 'source')
    if (id === undefined || name === undefined || folder === undefined || dir === undefined || kind === undefined) return []
    return [{
      id,
      name,
      folder,
      dir,
      source: kind as SkillCatalogEntry['source'],
      rank: readNumber(record, 'rank', 0),
      description: readString(record, 'description') ?? '',
      valid: readBoolean(record, 'valid', true),
      blocked: record.blocked === true,
      modelInvocable: readBoolean(record, 'modelInvocable', true),
      userInvocable: readBoolean(record, 'userInvocable', true),
      ...(readString(record, 'issue') !== undefined ? { issue: readString(record, 'issue')! } : {}),
      ...(readString(record, 'winnerId') !== undefined ? { winnerId: readString(record, 'winnerId')! } : {}),
      ...(readString(record, 'path') !== undefined ? { path: readString(record, 'path')! } : {}),
    }]
  })
}

const readPromptConfigs = (source: Record<string, unknown>, key: string): PromptConfigDraft[] => {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    return typeof record.id === 'string' && record.id.length > 0 ? [entry as PromptConfigDraft] : []
  })
}


export function fieldsFromView(res: BridgeResult<BridgeSettingsView>): Fields {
  const ns = res.ok ? res.value : undefined
  const value = asRecord(ns?.value)
  const base = asRecord(ns?.base)
  // 技能清单不在 settings：来源、优先级与屏蔽状态来自 describe 事实（注册层扫描结果）。
  const extraBlocked = res.ok && Array.isArray(res.skillBlocked) ? res.skillBlocked : undefined
  const extraFolders = res.ok && Array.isArray(res.skillFolders) ? res.skillFolders : undefined
  // 技能根与清单都在响应顶层（describe/bootstrap 的扩展字段），descriptor 内的同名键只作兜底。
  const extraDirs = res.ok && Array.isArray(res.activeSkillsDirs) && res.activeSkillsDirs.length > 0
    ? res.activeSkillsDirs
    : undefined
  const dirs = extraDirs ?? (readStringArray(value, 'activeSkillsDirs').length > 0
    ? readStringArray(value, 'activeSkillsDirs')
    : readStringArray(base, 'activeSkillsDirs'))
  const next: Fields = {
    ...EMPTY_FIELDS,
    promptText: readString(value, 'promptText') ?? readString(base, 'promptText') ?? '',
    promptPath: readString(value, 'promptPath') ?? readString(base, 'promptPath') ?? '',
    agentsText: readString(value, 'agentsText') ?? readString(base, 'agentsText') ?? '',
    agentsPath: readString(value, 'agentsPath') ?? readString(base, 'agentsPath') ?? '',
    skillCatalog: res.ok && res.skillCatalog !== undefined && res.skillCatalog.length > 0
      ? res.skillCatalog
      : readSkillCatalog(value, 'skillCatalog').length > 0
        ? readSkillCatalog(value, 'skillCatalog')
        : readSkillCatalog(base, 'skillCatalog'),
    skillBlocked: extraBlocked ?? readStringArray(value, 'skillBlocked'),
    skillFolders: extraFolders ?? readStringArray(value, 'skillFolders'),
    skillsRoot: dirs[0] ?? '',
    skillsRootExists: (() => {
      const merged: Record<string, unknown> = {}
      for (const entry of [base, value, res.ok ? { skillsDirExists: res.skillsDirExists } : {}]) {
        const exists = entry.skillsDirExists
        if (exists !== null && typeof exists === 'object' && !Array.isArray(exists)) Object.assign(merged, exists)
      }
      return dirs.length > 0 && merged[dirs[0]!] === true
    })(),
    presetOrder: readNumber(value, 'presetOrder', readNumber(base, 'presetOrder', 5)),
    fallbackText: readString(value, 'fallbackText') ?? readString(base, 'fallbackText') ?? '',
    writePreset: readBoolean(value, 'writePreset', readBoolean(base, 'writePreset', true)),
    presetTemplate: readString(value, 'presetTemplate') ?? readString(base, 'presetTemplate') ?? 'standard',
    promptConfigs: value.promptConfigs !== undefined
      ? readPromptConfigs(value, 'promptConfigs')
      : readPromptConfigs(base, 'promptConfigs'),
  }
  return next
}
/** /bootstrap 已携带 descriptor；归一成 fieldsFromView 使用的结果形状。 */
export function bridgeViewFromBoot(boot: BridgeResult<BridgeSettingsView>): BridgeResult<BridgeSettingsView> {
  if (!boot.ok) return boot
  return {
    ok: true,
    value: {
      ns: 'prompt-tool',
      value: boot.value.value,
      base: boot.value.base,
      revision: boot.value.revision,
    },
    providers: boot.providers,
    modelCatalog: boot.modelCatalog,
    activeSkillsDirs: boot.activeSkillsDirs,
    skillsDirExists: boot.skillsDirExists,
    skillCatalog: boot.skillCatalog,
    skillBlocked: boot.skillBlocked,
    skillFolders: boot.skillFolders,
    templatePreStepCount: boot.templatePreStepCount,
    presetParams: boot.presetParams,
    hostDefaultModel: boot.hostDefaultModel,
    moduleFacts: boot.moduleFacts,
  }
}

/** 只从预设投影行为参数；不把 settings 重新引入预设优先级链。 */
export function mergePresetParams(fields: Fields, params: Record<string, unknown> | undefined): Fields {
  return params === undefined ? fields : { ...fields, ...readParamOverridesPatch(params) }
}

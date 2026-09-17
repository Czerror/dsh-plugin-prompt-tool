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
    const folder = readString(record, 'folder')
    const name = readString(record, 'name')
    if (folder === undefined || name === undefined) return []
    const id = readString(record, 'id')
    return [{
      folder,
      name,
      description: readString(record, 'description') ?? '',
      // 向后兼容旧宿主：旧版 /describe 只返回 folder/name/description（且旧扫描
      // 已过滤非法名），缺字段按旧语义默认 true；新版宿主显式携带 valid=false。
      valid: readBoolean(record, 'valid', true),
      ...(id !== undefined ? { id } : {}),
      ...(typeof record.dir === 'string' && record.dir.length > 0 ? { dir: record.dir } : {}),
      ...(record.duplicate === true ? { duplicate: true } : {}),
      ...(typeof record.issue === 'string' && record.issue.length > 0 ? { issue: record.issue } : {}),
      ...(record.disabled === true ? { disabled: true } : {}),
      ...(record.linked === true ? { linked: true } : {}),
      ...(readString(record, 'source') !== undefined ? { source: readString(record, 'source')! } : {}),
      ...(readString(record, 'entityPath') !== undefined ? { entityPath: readString(record, 'entityPath')! } : {}),
      ...(readString(record, 'linkPath') !== undefined ? { linkPath: readString(record, 'linkPath')! } : {}),
      ...(readString(record, 'parentId') !== undefined ? { parentId: readString(record, 'parentId')! } : {}),
      ...(record.managed === true ? { managed: true } : {}),
      modelInvocable: readBoolean(record, 'modelInvocable', true),
      userInvocable: readBoolean(record, 'userInvocable', true),
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
  // 技能管理不在 settings：顺序/目录/rank 来自 describe 事实（插件配置文件），
  // 启停来自受管 skillCatalog 的链接状态。
  const extraSkillOrder = res.ok && Array.isArray(res.skillOrder) ? res.skillOrder : undefined
  const extraSkillDirs = res.ok && Array.isArray(res.skillsDirs) ? res.skillsDirs : undefined
  const extraSkillRankBase = res.ok && typeof res.skillRankBase === 'number' ? res.skillRankBase : undefined
  const next: Fields = {
    ...EMPTY_FIELDS,
    promptText: readString(value, 'promptText') ?? readString(base, 'promptText') ?? '',
    promptPath: readString(value, 'promptPath') ?? readString(base, 'promptPath') ?? '',
    agentsText: readString(value, 'agentsText') ?? readString(base, 'agentsText') ?? '',
    agentsPath: readString(value, 'agentsPath') ?? readString(base, 'agentsPath') ?? '',
    skillOrder: extraSkillOrder ?? [],
    skillCatalog: res.ok && res.skillCatalog !== undefined && res.skillCatalog.length > 0
      ? res.skillCatalog
      : readSkillCatalog(value, 'skillCatalog').length > 0
        ? readSkillCatalog(value, 'skillCatalog')
        : readSkillCatalog(base, 'skillCatalog'),
    skillsDirs: extraSkillDirs ?? [],
    activeSkillsDirs: readStringArray(value, 'activeSkillsDirs').length > 0
      ? readStringArray(value, 'activeSkillsDirs')
      : readStringArray(base, 'activeSkillsDirs'),
    skillsDirExists: (() => {
      const merged: Record<string, boolean> = {}
      for (const entry of [base, value, res.ok ? { skillsDirExists: res.skillsDirExists } : {}]) {
        const record = entry
        const exists = record.skillsDirExists
        if (exists !== null && typeof exists === 'object' && !Array.isArray(exists)) {
          Object.assign(merged, exists as Record<string, unknown>)
        }
      }
      const result: Record<string, boolean> = {}
      for (const [path, ok] of Object.entries(merged)) {
        if (typeof ok === 'boolean') result[path] = ok
      }
      return result
    })(),
    skillRankBase: extraSkillRankBase ?? 250,
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
    skillOrder: boot.skillOrder,
    skillsDirs: boot.skillsDirs,
    skillRankBase: boot.skillRankBase,
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

/** settings/bootstrap 载荷到客户端 Fields 的纯映射。 */
import type { PromptConfigDraft } from '../prompt-tool-types.ts'
import type { BridgeResult, BridgeSettingsView } from './bridge-transport.ts'
import { EMPTY_FIELDS, type Fields, type SkillCatalogEntry } from './prompt-tool-fields.ts'
import { readParamOverridesPatch } from './param-overrides.ts'
import { DEFAULT_PRESET_ID } from '../../shared/preset-ids.ts'
import { SKILL_SOURCES } from '../../shared/skills.ts'
import type { BridgeValueMap } from '../../shared/bridge-contract.ts'
import { readConfigFieldSources, stripConfigFieldSources } from '../../shared/managed-config-fields.ts'

/** 来源随当前物化快照读回，不从配置 id 或参数值猜测。 */
export function withConfigFieldSources(config: PromptConfigDraft): PromptConfigDraft {
  const fieldSources = readConfigFieldSources(config.id, config.fieldSources)
  return { ...stripConfigFieldSources(config), ...(fieldSources === undefined ? {} : { fieldSources }) }
}

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
      source: Object.hasOwn(SKILL_SOURCES, kind) ? kind as SkillCatalogEntry['source'] : 'other',
      rank: readNumber(record, 'rank', 0),
      description: readString(record, 'description') ?? '',
      valid: readBoolean(record, 'valid', false),
      modelInvocable: readBoolean(record, 'modelInvocable', true),
      userInvocable: readBoolean(record, 'userInvocable', true),
      ...(readString(record, 'issue') !== undefined ? { issue: readString(record, 'issue')! } : {}),
      ...(readString(record, 'winnerId') !== undefined ? { winnerId: readString(record, 'winnerId')! } : {}),
      ...(readString(record, 'path') !== undefined ? { path: readString(record, 'path')! } : {}),
      // 只有遮蔽是注册表带来的事实；其余条目按文件声明为事实（不再有未注册／未确认）。
      availability: record.availability === 'shadowed' ? 'shadowed' : 'active',
      ...(typeof record.canSetPolicy === 'boolean' ? { canSetPolicy: record.canSetPolicy } : {}),
      ...(typeof record.canEdit === 'boolean' ? { canEdit: record.canEdit } : {}),
      ...(typeof record.canDelete === 'boolean' ? { canDelete: record.canDelete } : {}),
      ...(readString(record, 'provider') !== undefined ? { provider: readString(record, 'provider')! } : {}),
      ...(readString(record, 'readonlyReason') !== undefined ? { readonlyReason: readString(record, 'readonlyReason')! } : {}),
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


/** 技能快照只更新自身字段，供首屏与局部刷新共用。空数组也是权威结果。 */
export function skillFieldsFromSnapshot(snapshot: BridgeValueMap['skillsList']): Pick<Fields, 'skillCatalog' | 'skillsComplete' | 'skillFolders' | 'skillsRoot'> {
  const catalog = readSkillCatalog({ skills: snapshot.skills }, 'skills')
  return {
    // 观测是否完整只影响 skillsComplete 提示，不再据此把条目降级成 unknown：
    // 本地扫描到的技能按文件声明为事实（重构前语义，与参照实现 dsh-web 的
    // collectSkills 一致）。降级会让状态徽章停在「未确认」，并让「模型可用／
    // 用户可用」两个页签计数归零。
    skillCatalog: catalog,
    skillsComplete: snapshot.complete === true,
    skillFolders: readStringArray({ folders: snapshot.folders }, 'folders'),
    skillsRoot: readStringArray({ roots: snapshot.roots }, 'roots')[0] ?? '',
  }
}

export function fieldsFromView(res: BridgeResult<BridgeSettingsView>): Fields {
  const ns = res.ok ? res.value : undefined
  const value = asRecord(ns?.value)
  const base = asRecord(ns?.base)
  const next: Fields = {
    ...EMPTY_FIELDS,
    promptText: readString(value, 'promptText') ?? readString(base, 'promptText') ?? '',
    promptPath: readString(value, 'promptPath') ?? readString(base, 'promptPath') ?? '',
    agentsText: readString(value, 'agentsText') ?? readString(base, 'agentsText') ?? '',
    agentsPath: readString(value, 'agentsPath') ?? readString(base, 'agentsPath') ?? '',
    ...skillFieldsFromSnapshot({
      skills: res.ok ? res.skillCatalog ?? [] : [],
      complete: res.ok && res.skillsComplete === true,
      folders: res.ok ? res.skillFolders ?? [] : [],
      roots: res.ok ? res.activeSkillsDirs ?? [] : [],
    }),
    presetOrder: readNumber(value, 'presetOrder', readNumber(base, 'presetOrder', 5)),
    fallbackText: readString(value, 'fallbackText') ?? readString(base, 'fallbackText') ?? '',
    writePreset: readBoolean(value, 'writePreset', readBoolean(base, 'writePreset', true)),
    presetTemplate: readString(value, 'presetTemplate') ?? readString(base, 'presetTemplate') ?? DEFAULT_PRESET_ID,
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
    skillCatalog: boot.skillCatalog,
    skillsComplete: boot.skillsComplete,
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

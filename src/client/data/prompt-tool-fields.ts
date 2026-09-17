/** 提示词工具客户端状态模型与稳定默认值（无网络、无 React）。 */
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, type EngineParamKey, type EngineParams } from '../../shared/engine-params.ts'
import { DEFAULT_PRESET_ID } from '../../shared/preset-ids.ts'
import type { SkillCatalogEntry } from '../../shared/skills.ts'
import type { EngineMeta, PromptConfigDraft } from '../prompt-tool-types.ts'

/** 宿主默认模型回显（agent-default-model settings：provider/model/reasoningEffort；插件参数未设置 = 继承宿主）。 */
export interface HostDefaultModel {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** 技能目录条目：与服务端共用同一契约（来源、优先级、两端调用策略、同名遮蔽）。 */
export type { SkillCatalogEntry } from '../../shared/skills.ts'

/** 参数草稿类型从宿主契约派生，只转换 UI 的列表/阶段/深度形态。 */
type EngineParamDrafts = {
  [K in EngineParamKey]-?: K extends 'stages' ? StageDraft[]
    : K extends 'guideEnabled' ? boolean | undefined
      : K extends 'maxDepth' ? string
        : NonNullable<EngineParams[K]> extends string | string[] ? string : NonNullable<EngineParams[K]>
}

export interface Fields extends EngineParamDrafts {
  promptText: string
  promptPath: string
  agentsText: string
  agentsPath: string
  /** 技能清单：官方六类技能根扫描结果（两端调用策略直接来自各技能文件的 frontmatter）。 */
  skillCatalog: SkillCatalogEntry[]
  /** 用户添加的技能文件夹（只引用，不复制）。 */
  skillFolders: string[]
  /** 用户技能根（创建、复制导入与回收站的落点）。 */
  skillsRoot: string
  presetOrder: number
  fallbackText: string
  writePreset: boolean
  presetTemplate: string
  promptConfigs: PromptConfigDraft[]
}

/** 渐进披露阶段草稿（UI 编辑形态；persist 时转引擎形态 [{name, tools: string[]}]）。 */
export interface StageDraft {
  name: string
  tools: string
}

/** 是否存在未填完的阶段草稿；保存后不能立即重载，否则空行会被服务端过滤并从 UI 消失。 */
export const hasIncompleteStageDrafts = (stages: StageDraft[]): boolean =>
  stages.some((stage) => stage.name.trim().length === 0 || stage.tools.trim().length === 0)

export const EMPTY_META: EngineMeta = {
  layers: [],
  strategies: [],
  slotKinds: [],
  positions: [],
  dedupes: [],
  promotions: [],
  audienceModes: [],
  modelScopes: [],
  roles: [],
  acceptedRoles: [],
  mergeModes: [],
  fills: [],
  layerFieldPolicies: {},
  layerLabels: {},
}
export const EMPTY_FIELDS: Fields = {
  ...Object.fromEntries(ENGINE_PARAM_KEYS.map((key) => [key, ENGINE_PARAM_DEFINITIONS[key].defaultValue])) as Pick<Fields, EngineParamKey>,
  promptText: '',
  promptPath: '',
  agentsText: '',
  agentsPath: '',
  skillCatalog: [],
  skillFolders: [],
  skillsRoot: '',
  presetOrder: 5,
  fallbackText: '',
  writePreset: true,
  presetTemplate: DEFAULT_PRESET_ID,
  promptConfigs: [],
}
/** 编译期契约：所有引擎参数键都必须进入 Fields，防止 host 新增参数后 client 静默丢弃。 */
type MissingEngineParamKeys = Exclude<EngineParamKey, keyof Fields>
const _assertEngineParamsInFields: MissingEngineParamKeys extends never ? true : false = true

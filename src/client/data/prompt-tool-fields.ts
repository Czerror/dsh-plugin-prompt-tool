/** 提示词工具客户端状态模型与稳定默认值（无网络、无 React）。 */
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, type EngineParamKey, type EngineParams } from '../../shared/engine-params.ts'
import type { EngineMeta, PromptConfigDraft } from '../prompt-tool-types.ts'

/** 宿主默认模型回显（agent-default-model settings：provider/model/reasoningEffort；插件参数未设置 = 继承宿主）。 */
export interface HostDefaultModel {
  provider?: string
  model?: string
  reasoningEffort?: string
}

export interface SkillCatalogEntry {
  folder: string
  name: string
  description: string
  valid: boolean
  /** 来源技能目录绝对路径。 */
  dir?: string
  /** 同名标记：多目录存在相同 folder 时 UI 标注。 */
  duplicate?: boolean
  issue?: string
  modelInvocable: boolean
  userInvocable: boolean
}

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
  injectAgentsPrompt: boolean
  skillSwitches: Record<string, boolean>
  skillOrder: string[]
  skillCatalog: SkillCatalogEntry[]
  /** 用户技能目录列表（按添加顺序）；空 = 默认副本。 */
  skillsDirs: string[]
  /** 实际生效目录列表（空配置 = [默认副本路径]）。 */
  activeSkillsDirs: string[]
  /** 生效目录存在性（path → 是否存在）。 */
  skillsDirExists: Record<string, boolean>
  skillRankBase: number
  residentAgentsPath: string
  presetDir: string
  presetOrder: number
  fallbackText: string
  writeAgents: boolean
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
  injectAgentsPrompt: false,
  skillSwitches: {},
  skillOrder: [],
  skillCatalog: [],
  skillsDirs: [],
  activeSkillsDirs: [],
  skillsDirExists: {},
  skillRankBase: 250,
  residentAgentsPath: '',
  presetDir: '',
  presetOrder: 5,
  fallbackText: '',
  writeAgents: true,
  writePreset: true,
  presetTemplate: 'anchored',
  promptConfigs: [],
}
/** 编译期契约：所有引擎参数键都必须进入 Fields，防止 host 新增参数后 client 静默丢弃。 */
type MissingEngineParamKeys = Exclude<EngineParamKey, keyof Fields>
const _assertEngineParamsInFields: MissingEngineParamKeys extends never ? true : false = true

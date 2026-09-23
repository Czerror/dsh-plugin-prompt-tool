/** 提示词工具客户端状态模型与稳定默认值（无网络、无 React）。 */
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, type EngineParamKey, type EngineParams } from '../../shared/engine-params.ts'
import { ENGINE_LAYER_ORDER } from '../../shared/engine-capabilities.ts'
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

/** 参数草稿类型从宿主契约派生，只转换 UI 的列表/深度形态。 */
type EngineParamDrafts = {
  [K in EngineParamKey]-?: K extends 'maxDepth' ? string
    : NonNullable<EngineParams[K]> extends string | string[] ? string : NonNullable<EngineParams[K]>
}

export interface Fields extends EngineParamDrafts {
  promptText: string
  promptPath: string
  agentsText: string
  agentsPath: string
  /** 技能清单：官方六类技能根扫描结果（两端调用策略直接来自各技能文件的 frontmatter）。 */
  skillCatalog: SkillCatalogEntry[]
  /** 当前会话的注册表观测是否完整；false 不能解释成技能不存在。 */
  skillsComplete: boolean
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

/**
 * /meta 的**列表类事实键**（对应 getEngineMeta() 下发的列表）：EMPTY_META 按本表派生空表，
 * 新增列表键只改这一处。产品代码不 import engine/*.mjs（零引擎运行时依赖），故键名清单留在此处；
 * 漏掉必备键会在下面 EMPTY_META 的 `: EngineMeta` 赋值处直接编译报错（缺键会被列出）。
 * 对象型契约在 EMPTY_META 中单独初始化。
 */
const META_LIST_KEYS = [
  'layers', 'strategies', 'slotKinds', 'positions', 'dedupes', 'promotions',
  'audienceModes', 'modelScopes', 'roles', 'mergeModes', 'fills', 'subjects',
] as const satisfies readonly MetaListKey[]

/** EngineMeta 里字符串列表型的键。 */
type MetaListKey = { [K in keyof EngineMeta]-?: NonNullable<EngineMeta[K]> extends string[] ? K : never }[keyof EngineMeta]

/**
 * 按键名清单派生空表（`Record<K, string[]>` 而非索引签名）：返回类型保留显式键，
 * 因此下面 `: EngineMeta` 的赋值仍会在漏掉必备列表键时编译报错。
 */
const emptyLists = <K extends MetaListKey>(keys: readonly K[]): Record<K, string[]> =>
  Object.fromEntries(keys.map((key): [K, string[]] => [key, []])) as Record<K, string[]>

export const EMPTY_META: EngineMeta = {
  // bootstrap 返回前的加载快照；收到响应后整体替换。
  layerOrder: ENGINE_LAYER_ORDER,
  ...emptyLists(META_LIST_KEYS),
  editorGroups: [],
  layerDefaultSubjects: {},
  layerContracts: {} as EngineMeta['layerContracts'],
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
  skillsComplete: false,
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

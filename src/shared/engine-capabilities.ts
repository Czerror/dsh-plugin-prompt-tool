/** 引擎能力目录：把 UI capability id 与 preset module/row 实际事实解耦。 */
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, type EngineParamKey } from './engine-params.ts'

/** 该编辑组 / 能力 card 拥有的扁平参数键：分组渲染与技术键搜索共用这一份派生。 */
export function engineGroupParamKeys(id: string): readonly EngineParamKey[] {
  return ENGINE_PARAM_KEYS.filter((key) => ENGINE_PARAM_DEFINITIONS[key].card === id)
}

export type ModuleSourceMode = 'explicit' | 'composition' | 'official' | 'unknown'

/** 实际注册工具与 opt-in 能力的唯一目录，供注册、委托建议与自动补装消费。 */
export const MODULE_TOOL_NAMES = {
  import: 'module_import', rulesRead: 'module_rules_read', rulesEdit: 'module_rules_edit',
  fileRead: 'module_file_read', fileAppend: 'module_file_append', manifest: 'module_manifest', variables: 'module_variables',
  soulLedger: 'soul_ledger', search: 'module_search', open: 'module_open',
} as const
export const MODULE_TOOL_CAPABILITIES: Readonly<Record<string, string>> = {
  [MODULE_TOOL_NAMES.import]: 'module-import-tools',
  [MODULE_TOOL_NAMES.rulesRead]: 'module-rule-tools', [MODULE_TOOL_NAMES.rulesEdit]: 'module-rule-tools',
  [MODULE_TOOL_NAMES.fileRead]: 'module-file-tools', [MODULE_TOOL_NAMES.fileAppend]: 'module-file-tools',
  [MODULE_TOOL_NAMES.manifest]: 'module-manifest-tools',
  [MODULE_TOOL_NAMES.variables]: 'module-variable-tools',
  [MODULE_TOOL_NAMES.soulLedger]: 'soul-ledger',
  [MODULE_TOOL_NAMES.search]: 'retrieval', [MODULE_TOOL_NAMES.open]: 'retrieval',
}

/** 官方九个注入层：与 engine/schema.mjs 的 LAYER_ORDER 同源，改一处必须同步另一处。 */
export type InjectionPoint =
  | 'pre-step'
  | 'system-section'
  | 'runtime-context'
  | 'agent-request'
  | 'llm-stream'
  | 'tool-pipeline'
  | 'turn-stop'
  | 'subagent-start'
  | 'subagent-end'

/** 旧公开类型名只作输入兼容。 */

/**
 * 九层顺序的共享副本：宿主是旧版本（不下发 meta.layerOrder）时前端退化用它，
 * 而不是各自再写一份层序清单。
 */
export const INJECTION_POINT_ORDER: readonly InjectionPoint[] = [
  'pre-step',
  'system-section',
  'runtime-context',
  'agent-request',
  'llm-stream',
  'tool-pipeline',
  'turn-stop',
  'subagent-start',
  'subagent-end',
]

export interface ModuleFacts {
  declaredModules: string[] | null
  effectiveModules: string[] | null
  rowIds: string[]
  /** 组合行按 disabled 判定为关闭的行 id；effectiveModules 已剔除。仅服务端装配使用。 */
  disabledRows?: string[]
  sourceMode: ModuleSourceMode
  editable: boolean
  effectiveConfigs?: Record<string, Record<string, unknown>>
}

/** 由会话原有预设提供、插件不自行挂载的官方 recipe 行。 */
export const OFFICIAL_RECIPE_ROWS = Object.freeze(['filesystem-editor', 'persistent-shell-posix', 'tool-bash-disabled']) as readonly string[];

export interface ModuleCapability {
  id: string
  moduleKeys: readonly string[]
  rowIds: readonly string[]
  displayLayer: InjectionPoint
  /** 真实跨层影响的相关层（只在确有第二通道时登记，避免把归属铺满九层）。 */
  relatedLayers?: readonly InjectionPoint[]
  /**
   * 该能力拥有的 preset 顶层数据段（不是行级 config）。
   * 创建时若段缺失则写入 `skeleton`（保证"模块在 ⇒ 数据在"）；删除时一并移除该段。
   */
  ownSection?: {
    /** module.yml 顶层键名。 */
    key: string
    /** 启用时写入的可用骨架（必须能通过该段的校验）。 */
    skeleton: Readonly<Record<string, unknown>>
  }
}

/** 首期只登记已有 typed editor 的能力，避免万能 key/value 表单。 */
export const MODULE_CAPABILITIES: readonly ModuleCapability[] = [
  { id: 'instruction-hint', moduleKeys: ['instruction-hint'], rowIds: ['instruction-hint'], displayLayer: 'pre-step' },
  { id: 'present-as', moduleKeys: ['present-as'], rowIds: ['present-as'], displayLayer: 'tool-pipeline' },
  { id: 'run-code-env', moduleKeys: ['run-code-env'], rowIds: ['run-code-env'], displayLayer: 'tool-pipeline' },
  ...[...new Set(Object.values(MODULE_TOOL_CAPABILITIES))].map(id => ({ id, moduleKeys: [id], rowIds: [id], displayLayer: 'tool-pipeline' as const })),
  // B7 T3：tool-bootstrap / context-gate / anchor-turn / promoted-code-mode / tool-filter /
  // deliberation-gate / progress-reminder 七张专用能力卡随对应引擎模块退场，不再登记。
  { id: 'tool-config-engine', moduleKeys: ['tool-config-engine'], rowIds: ['tool-config-engine'], displayLayer: 'tool-pipeline' },
  // B2 T3：tool-git-bash 此前没有能力卡（开关只能靠「行在不在组合里」），补 `enabled` 键后登记卡片，
  // 否则 impliedModulesForParams 查不到 card，「参数在 ⇒ 装配在」对该行静默失效。
  { id: 'tool-git-bash', moduleKeys: ['tool-git-bash'], rowIds: ['tool-git-bash'], displayLayer: 'tool-pipeline' },
] as const

/**
 * 编辑组 = 前端一张可编辑卡（能力卡或专用卡）的主归属层。
 * id 必须是代码里真实存在的 card / 展开键名，不新增臆造 id。
 */
export interface EngineEditorGroup {
  id: string
  displayLayer: InjectionPoint
  /** 真实跨层影响的相关层（只有确有第二通道时才写）。 */
  relatedLayers?: readonly InjectionPoint[]
  /** 真实生效通道的只读说明键（如 'agent-request' / 'system-section'）：供 UI 显示「实际生效通道」，
   *  只写代码里可核对的事实，不承诺未验证的通道。 */
  hook: string
}

/**
 * 非能力编辑组的主归属。能力组不在这里重复登记：它们的 displayLayer 由能力定义本身承载
 * （例如工具批准策略的 card 就是能力 id `tool-config-engine`，已随能力登记）。
 */
export const ENGINE_EDITOR_GROUPS: readonly EngineEditorGroup[] = [
  // 提示词默认值（injectPrompt / firstTurnAnchor / guideText）改写 pre-step 消息批。
  { id: 'prompt-defaults', displayLayer: 'pre-step', hook: 'pre-step' },
  // 人设注册 system-section 段；includeRuntimeContext 同时抑制 runtime-context 快照，属真实跨层。
  { id: 'persona', displayLayer: 'system-section', relatedLayers: ['runtime-context'], hook: 'system-section' },
  // 模块顶层 variables 是插值源，由 runtime-context 的 placeholder 消费。
  { id: 'variables', displayLayer: 'runtime-context', hook: 'runtime-context' },
  // 主模型 provider/model 与采样参数经当前模块生成的 agent-request patch 生效。
  { id: 'main-model', displayLayer: 'agent-request', hook: 'agent-request' },
  // 本地子代理的模型路由与采样参数都在 agent-request 生效；磁盘仍沿用 subagent-start。
  { id: 'subagent-model', displayLayer: 'agent-request', hook: 'agent-request' },
  // 自定义工具定义进 tools/* 管线。
  { id: 'custom-tools', displayLayer: 'tool-pipeline', hook: 'tool-pipeline' },
] as const

/**
 * 编辑组主归属总表：能力组（id = 能力 id，通道即能力声明的 displayLayer）在前，专用编辑组在后。
 * host 的 /meta 下发与前端九层组织共用这一份派生，参数不再各自复制归属。
 */
export const ENGINE_EDITOR_GROUP_MAP: readonly EngineEditorGroup[] = [
  ...MODULE_CAPABILITIES.map(({ id, displayLayer, relatedLayers }) => ({ id, displayLayer, relatedLayers, hook: displayLayer })),
  ...ENGINE_EDITOR_GROUPS,
]

export interface EngineRecipe {
  id: string
  capabilities: readonly string[]
  initialParams?: Readonly<Record<string, unknown>>
}

/**
 * 只保留已有真实工作流的一键组合；recipe 本身不写入 module.yml。
 *
 * B7 T3 清空：三条 recipe 的成员都是随本轮退场的专用能力（phase-control /
 * phase-control-ptc / deliberation），没有任何一条还能组成合法能力集合。
 * export 与 `engineRecipe()` 保留——调用点（创建菜单、bridge 校验）不必跟着改，
 * 空表天然让组合项整个消失。
 */
export const ENGINE_RECIPES: readonly EngineRecipe[] = []

export function moduleCapability(id: string): ModuleCapability | undefined {
  return MODULE_CAPABILITIES.find((capability) => capability.id === id)
}


export function engineRecipe(id: string): EngineRecipe | undefined {
  return ENGINE_RECIPES.find((recipe) => recipe.id === id)
}

/**
 * 模块里显式写了的引擎参数 / 行配置所隐含的模块：**参数在 ⇒ 装配在**。
 *
 * 只认显式声明（`params` 的登记参数键与 `moduleConfigs` 的行键），组合源自带的默认值不算——
 * 否则任何模块都会把全部能力装回来。返回能力拥有的模块 id（去重，顺序稳定）。
 * 装配入口、模块事实与"移除能力"三处共用这一份派生，避免各自判断漂移。
 */
export function impliedModulesForParams(
  params: Readonly<Record<string, unknown>> | undefined | null,
  moduleConfigs: Readonly<Record<string, unknown>> | undefined | null,
): string[] {
  const implied = new Set<string>()
  const add = (capability: ModuleCapability | undefined): void => {
    if (capability === undefined) return
    for (const module of capability.moduleKeys) implied.add(module)
  }
  const addRow = (rowId: string): void => {
    const capability = MODULE_CAPABILITIES.find((item) => item.rowIds.includes(rowId) || item.moduleKeys.includes(rowId))
    if (capability !== undefined) add(capability)
    else if (ENGINE_PARAM_KEYS.some((key) => ENGINE_PARAM_DEFINITIONS[key].module?.row === rowId)) implied.add(rowId)
  }
  if (params !== undefined && params !== null) {
    for (const key of ENGINE_PARAM_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue
      const definition = ENGINE_PARAM_DEFINITIONS[key]
      if (definition.module !== undefined) addRow(definition.module.row)
      else add(moduleCapability(definition.card))
    }
  }
  if (moduleConfigs !== undefined && moduleConfigs !== null) {
    for (const rowId of Object.keys(moduleConfigs)) {
      addRow(rowId)
    }
  }
  return [...implied]
}

/** 运行时有效能力，保留隐式装配与已发布的事实查询语义。 */
/** 参与运行时装配的行：effectiveModules + rowIds，剔除 disabled。 */
export function enabledRowIds(facts: ModuleFacts): string[] {
  const disabled = new Set(facts.disabledRows ?? [])
  return [...new Set([...(facts.effectiveModules ?? []), ...facts.rowIds])].filter(id => !disabled.has(id))
}

/** 模块编辑面的能力准入只认 modules 声明；运行时派生能力不构成该模块的编辑声明。 */
export function isModuleCapabilityDeclared(id: string, facts: ModuleFacts | undefined): boolean {
  if (facts === undefined || facts.sourceMode !== 'explicit') return false
  const capability = moduleCapability(id)
  if (capability === undefined) return false
  const modules = facts.declaredModules
  if (modules === null) return false
  return capability.moduleKeys.some((key) => modules.includes(key))
}

/** custom tool 的运行时名称缺省回落 id；保存前拒绝会导致同层注册失败的重复项。 */
export function validateCustomToolIdentities(tools: readonly unknown[]): string[] {
  const errors: string[] = []
  const ids = new Map<string, number>()
  const names = new Map<string, number>()
  for (const [index, value] of tools.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`customTools[${index}] 必须是对象`)
      continue
    }
    const record = value as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id.length === 0) {
      errors.push(`customTools[${index}].id 必须是非空字符串`)
      continue
    }
    const name = typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : id
    const previousId = ids.get(id)
    if (previousId !== undefined) errors.push(`customTools[${index}].id 与 customTools[${previousId}] 重复：${id}`)
    else ids.set(id, index)
    const previousName = names.get(name)
    if (previousName !== undefined) errors.push(`customTools[${index}].name 与 customTools[${previousName}] 重复：${name}`)
    else names.set(name, index)
  }
  return errors
}

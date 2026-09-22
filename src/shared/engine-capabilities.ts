/** 引擎能力目录：把 UI capability id 与 preset module/row 实际事实解耦。 */
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, type EngineParamKey } from './engine-params.ts'

/** 该编辑组 / 能力 card 拥有的扁平参数键：分组渲染与技术键搜索共用这一份派生。 */
export function engineGroupParamKeys(id: string): readonly EngineParamKey[] {
  return ENGINE_PARAM_KEYS.filter((key) => ENGINE_PARAM_DEFINITIONS[key].card === id)
}

export type ModuleSourceMode = 'explicit' | 'composition' | 'official' | 'unknown'

/** 官方九个注入层：与 engine/schema.mjs 的 LAYER_ORDER 同源，改一处必须同步另一处。 */
export type EngineLayer =
  | 'pre-step'
  | 'system-section'
  | 'runtime-context'
  | 'agent-request'
  | 'llm-stream'
  | 'tool-pipeline'
  | 'turn-stop'
  | 'subagent-start'
  | 'subagent-end'

/**
 * 九层顺序的共享副本：宿主是旧版本（不下发 meta.layerOrder）时前端退化用它，
 * 而不是各自再写一份层序清单。
 */
export const ENGINE_LAYER_ORDER: readonly EngineLayer[] = [
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

export interface PresetModuleFacts {
  declaredModules: string[] | null
  effectiveModules: string[] | null
  rowIds: string[]
  sourceMode: ModuleSourceMode
  editable: boolean
  effectiveConfigs?: Record<string, Record<string, unknown>>
}

export interface EngineCapability {
  id: string
  moduleKeys: readonly string[]
  rowIds: readonly string[]
  displayLayer: EngineLayer
  /** 真实跨层影响的相关层（只在确有第二通道时登记，避免把归属铺满九层）。 */
  relatedLayers?: readonly EngineLayer[]
  /**
   * 该能力拥有的 preset 顶层数据段（不是行级 config）。
   * 创建时若段缺失则写入 `skeleton`（保证"模块在 ⇒ 数据在"）；删除时一并移除该段。
   */
  ownSection?: {
    /** preset.yml 顶层键名。 */
    key: string
    /** 启用时写入的可用骨架（必须能通过该段的校验）。 */
    skeleton: Readonly<Record<string, unknown>>
  }
}

/** 子代理工具策略的启用骨架：常用工具全放行 + 扩权受限（用户决策，可在卡片内继续收窄）。 */
export const SUBAGENT_TOOL_POLICY_SKELETON: Readonly<Record<string, unknown>> = {
  defaultProfile: 'default',
  ceiling: { allow: ['read', 'write', 'edit', 'glob', 'grep', 'bash'], deny: [] },
  profiles: [
    {
      id: 'default',
      name: '默认',
      allow: ['read', 'write', 'edit', 'glob', 'grep', 'bash'],
      deny: [],
      modelSelectable: true,
    },
  ],
  // 扩权必须严格 ⊆ ceiling.allow（校验会拒绝超限）；requireApproval 要求宿主有批准通道（无通道则 fail closed）。
  modelExpansion: {
    enabled: true,
    allow: ['write', 'edit', 'glob', 'grep'],
    maxAdditionalTools: 2,
    requireApproval: true,
  },
}

/** 首期只登记已有 typed editor 的能力，避免万能 key/value 表单。 */
export const ENGINE_CAPABILITIES: readonly EngineCapability[] = [
  // B7 T3：tool-bootstrap / context-gate / anchor-turn / promoted-code-mode / tool-filter /
  // deliberation-gate / progress-reminder 七张专用能力卡随对应引擎模块退场，不再登记。
  // 子代理工具面：模块 + 顶层策略段（段是结构化数据，物化为 subagent-tools/policy.yml）。
  {
    id: 'subagent-tool-policy',
    moduleKeys: ['subagent-tool-policy'],
    rowIds: ['subagent-tool-policy'],
    displayLayer: 'tool-pipeline',
    ownSection: { key: 'subagentToolPolicy', skeleton: SUBAGENT_TOOL_POLICY_SKELETON },
  },
  // filesystem-editor 同时提供 fs-local 与 str-replace-editor，二者必须同域。
  { id: 'str-replace-editor', moduleKeys: ['filesystem-editor'], rowIds: ['str-replace-editor'], displayLayer: 'tool-pipeline' },
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
  displayLayer: EngineLayer
  /** 真实跨层影响的相关层（只有确有第二通道时才写）。 */
  relatedLayers?: readonly EngineLayer[]
  /** 真实生效通道的只读说明键（如 'agent-request' / 'system-section'）：供 UI 显示「实际生效通道」，
   *  只写代码里可核对的事实，不承诺未验证的通道。 */
  hook: string
}

/**
 * 非能力编辑组的主归属。能力组不在这里重复登记：它们的 displayLayer 由能力定义本身承载
 * （例如「编辑器输出上限」参数的 card 就是能力 id `str-replace-editor`，已随能力登记）。
 */
export const ENGINE_EDITOR_GROUPS: readonly EngineEditorGroup[] = [
  // 提示词默认值（injectPrompt / firstTurnAnchor / guideText）改写 pre-step 消息批。
  { id: 'prompt-defaults', displayLayer: 'pre-step', hook: 'pre-step' },
  // 人设注册 system-section 段；includeRuntimeContext 同时抑制 runtime-context 快照，属真实跨层。
  { id: 'persona', displayLayer: 'system-section', relatedLayers: ['runtime-context'], hook: 'system-section' },
  // 预设顶层 variables 是插值源，由 runtime-context 的 placeholder 消费。
  { id: 'variables', displayLayer: 'runtime-context', hook: 'runtime-context' },
  // 主模型 provider/model 与采样参数经当前预设生成的 agent-request patch 生效。
  { id: 'main-model', displayLayer: 'agent-request', hook: 'agent-request' },
  // 子代理模型路由随子代理启动注入 tool-subagent 行 agentOptions；同卡采样三参数写
  // agent-request 的 subagent-model-params patch，因此关联 agent-request。
  { id: 'subagent-model', displayLayer: 'subagent-start', relatedLayers: ['agent-request'], hook: 'subagent-start' },
  // 委派递归深度（maxDepth）经 tool-subagent / tool-subagent-fork 行 config 下发，
  // 启用实例策略时改由 subagent-tool-policy 承载：两条通道都在子代理启动处生效。
  { id: 'subagent-tools', displayLayer: 'subagent-start', hook: 'subagent-start' },
  // 自定义工具定义进 tools/* 管线。
  { id: 'custom-tools', displayLayer: 'tool-pipeline', hook: 'tool-pipeline' },
] as const

/**
 * 编辑组主归属总表：能力组（id = 能力 id，通道即能力声明的 displayLayer）在前，专用编辑组在后。
 * host 的 /meta 下发与前端九层组织共用这一份派生，参数不再各自复制归属。
 */
export const ENGINE_EDITOR_GROUP_MAP: readonly EngineEditorGroup[] = [
  ...ENGINE_CAPABILITIES.map(({ id, displayLayer, relatedLayers }) => ({ id, displayLayer, relatedLayers, hook: displayLayer })),
  ...ENGINE_EDITOR_GROUPS,
]

/**
 * 该编辑组在给定层筛选下是否可见：`all` / `world-book` 视图恒可见（保持既有平铺位置），
 * 否则主归属或 `relatedLayers` 命中该层才显示。未登记的 id 不猜归属，一律可见——
 * 这样新增卡片忘登记时是「哪层都能看到」，而不是「哪层都看不到」。
 */
export function isEditorGroupVisible(id: string, viewFilter: string): boolean {
  if (viewFilter === 'all' || viewFilter === 'world-book') return true
  const group = ENGINE_EDITOR_GROUP_MAP.find((item) => item.id === id)
  if (group === undefined) return true
  return group.displayLayer === viewFilter || (group.relatedLayers ?? []).includes(viewFilter as EngineLayer)
}

export interface EngineRecipe {
  id: string
  capabilities: readonly string[]
  initialParams?: Readonly<Record<string, unknown>>
}

/**
 * 只保留已有真实工作流的一键组合；recipe 本身不写入 preset.yml。
 *
 * B7 T3 清空：三条 recipe 的成员都是随本轮退场的专用能力（phase-control /
 * phase-control-ptc / deliberation），没有任何一条还能组成合法能力集合。
 * export 与 `engineRecipe()` 保留——调用点（创建菜单、bridge 校验）不必跟着改，
 * 空表天然让组合项整个消失。
 */
export const ENGINE_RECIPES: readonly EngineRecipe[] = []

export function engineCapability(id: string): EngineCapability | undefined {
  return ENGINE_CAPABILITIES.find((capability) => capability.id === id)
}

export function engineRecipe(id: string): EngineRecipe | undefined {
  return ENGINE_RECIPES.find((recipe) => recipe.id === id)
}

/**
 * 预设里显式写了的引擎参数 / 行配置所隐含的模块：**参数在 ⇒ 装配在**。
 *
 * 只认显式声明（`params` 的登记参数键与 `moduleConfigs` 的行键），组合源自带的默认值不算——
 * 否则任何预设都会把全部能力装回来。返回能力拥有的模块 id（去重，顺序稳定）。
 * 装配入口、模块事实与"移除能力"三处共用这一份派生，避免各自判断漂移。
 */
export function impliedModulesForParams(
  params: Readonly<Record<string, unknown>> | undefined | null,
  moduleConfigs: Readonly<Record<string, unknown>> | undefined | null,
): string[] {
  const implied = new Set<string>()
  const add = (capability: EngineCapability | undefined): void => {
    if (capability === undefined) return
    for (const module of capability.moduleKeys) implied.add(module)
  }
  if (params !== undefined && params !== null) {
    for (const key of ENGINE_PARAM_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue
      add(engineCapability(ENGINE_PARAM_DEFINITIONS[key].card))
    }
  }
  if (moduleConfigs !== undefined && moduleConfigs !== null) {
    for (const rowId of Object.keys(moduleConfigs)) {
      add(ENGINE_CAPABILITIES.find((capability) => capability.rowIds.includes(rowId) || capability.moduleKeys.includes(rowId)))
    }
  }
  return [...implied]
}

/** 显式模块预设中的实际能力；包含历史策略段仍在运行的兼容装配。
 *  创建补声明由 host 单独检查 declaredModules；官方组合行不伪装成可编辑能力。 */
export function isEngineCapabilityPresent(id: string, facts: PresetModuleFacts | undefined): boolean {
  if (facts === undefined || facts.sourceMode !== 'explicit') return false
  const capability = engineCapability(id)
  if (capability === undefined) return false
  const modules = facts.effectiveModules ?? facts.declaredModules
  if (modules === null) return false
  return capability.moduleKeys.some((key) => modules.includes(key))
}

export interface CustomToolIdentity {
  index: number
  id: string
  name: string
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

/**
 * 引擎行为参数契约（单一来源）。
 *
 * 这是「可配置引擎参数」的类型唯一权威：所有消费引擎参数的接口（RuntimeOptions /
 * WritePresetOptions）从这里派生，不再各自手写一遍字段
 * （此前多处重复声明导致同字段签名漂移，如 maxDepth / modelTemperature）。
 *
 * 分层约定：
 *  - 本文件 = 引擎参数「契约层」（类型）：参数桥/模板/UI 可配置的键与类型；
 *  - ENGINE_PARAM_DEFINITIONS 统一键、校验、卡片、默认草稿与组合映射；
 *    Record<keyof EngineParams, ...> 强制完整覆盖，ENGINE_PARAM_KEYS 与 PARAM_KEYS 从其派生；
 *  - layerSettings ↔ 运行时平铺键：loadPresetSpec 展平 / savePresetParams 按层写入。
 *
 * 全部字段可选：缺省 = 模板 preset.yml layerSettings / 引擎默认，符合「一切皆可自定义」。
 */
export interface EngineParams {
  /** 首轮近距离锚定：首条真实用户消息后追加一次性首句锚点。 */
  firstTurnAnchor?: boolean
  /** 自定义锚点文本；firstTurnCustom=true 时固定使用。 */
  firstTurnText?: string
  /** 自定义锚点开关：true 固定使用 firstTurnText；false 按任务自动选择。 */
  firstTurnCustom?: boolean
  /** 自定义每轮引导文本；guideCustom=true 时固定使用。 */
  guideText?: string
  /** 自定义每轮引导开关：true 固定使用 guideText；false 按任务自动选择。 */
  guideCustom?: boolean
  /** 每轮引导独立开关；undefined = 兼容旧行为：跟随 firstTurnAnchor（关锚定 = 关引导）。 */
  guideEnabled?: boolean
  /** 锚定确认后注入 preset.md；关闭时仍保留工具引导，但不生成 prompt-injector 提示词配置内容。 */
  injectPrompt?: boolean
  /** 模型路由 provider；与模型名同时非空时给 subagent/subagent_fork 行加 agentOptions（主对话直派子代理与委派子代理通用）。 */
  modelProvider?: string
  /** 模型名；与 provider 同时非空时生效。 */
  modelName?: string
  /** 子代理固定模型路由 provider（agentOptions 注入 tool-subagent）。 */
  subagentModelProvider?: string
  /** 子代理固定模型名。 */
  subagentModelName?: string
  /** 主对话思维程度（agent-request patch reasoningEffort；''=不设置，官方档位 off/low/high/max）。 */
  modelReasoningEffort?: string
  /** 主对话采样温度（agent-request patch temperature；''=不设置）。 */
  modelTemperature?: string
  /** 主对话输出上限（agent-request patch maxTokens；''=不设置）。 */
  modelMaxTokens?: string
  /** 子代理思维程度（agent-request patch，audience=subagent；''=不设置）。 */
  subagentReasoningEffort?: string
  /** 子代理采样温度（agent-request patch，audience=subagent；''=不设置）。 */
  subagentTemperature?: string
  /** 子代理输出上限（agent-request patch，audience=subagent；''=不设置）。 */
  subagentMaxTokens?: string
  /** 委派递归深度上限（0 禁止委派 / provider-managed / 正整数；数字字符串同义）。 */
  maxDepth?: number | 'provider-managed' | string
  /** custom-fallback 锚定词（prompt-injector params.firstTurnWord）。 */
  firstTurnWord?: string
  /**
   * 锚定/引导内容键：writePreset 把它们映射进 near-anchor / router-guide 的
   * promptConfig params（由对应策略消费）。此前只在 PARAM_KEYS 旁路白名单里，
   * 保存链接受键名却被值校验拒绝，形成「白名单通过、写盘前报未知键」的断层。
   */
  /** 构建任务正则（锚定三档分类的 build 档；编译规则与 engine/classify-task.mjs 同源，flags=i）。 */
  buildPattern?: string
  /** 复杂任务正则（锚定 complex 档与引导深度判定共用）。 */
  complexPattern?: string
  /** 构建档锚句。 */
  firstTurnBuild?: string
  /** 排查档锚句。 */
  firstTurnInspect?: string
  /** 深度档锚句。 */
  firstTurnDeep?: string
  /** 引导-简短档正文。 */
  guideWeak?: string
  /** 引导-深度档正文。 */
  guideDeep?: string
  /** 晋升后 agent-instructions 全文 → 一次性 hint。 */
  instructionHint?: boolean
  /** str-replace-editor 最大输出字符数（参数桥默认官方值 16000；由引擎能力卡编辑）。 */
  strReplaceEditorMaxOutputChars?: number
  /** tool-git-bash 行的能力开关（B2 T3 补；此前该行只能靠「在不在组合里」决定启停）。 */
  toolGitBashEnabled?: boolean
  /** 自定义模型工具在执行前需用户批准的执行器种类。 */
  customToolRequireApproval?: string[] | string
}

export type EngineParamKey = keyof EngineParams

/** 双向相等断言工具：两字符串集合完全一致 → true，否则 false。 */
type AssertKeysEqual<A extends string, B extends string> =
  Exclude<A, B> extends never
    ? Exclude<B, A> extends never ? true : false
    : false

/**
 * writePreset.runtimeOf 实际透传进运行时 params 的引擎参数子集。
 * RuntimeOptions（装配态）与 WritePresetOptions（写入态）都从这里派生，
 * 防止「加参数只改一处、writePreset 忘透传」的静默漂移（如 stageAdvanceDescription 历史事故）。
 */
export type PresetWriterParams = Partial<EngineParams>

/**
 * 数值型引擎参数保存前校验（与 write-preset.modelRequestConfigs 消费规则同源）。
 * 保存层响亮失败（400 逐字段错误），渲染层保持宽容（never-brick）：
 *   - 布尔键：必须是 boolean；
 *   - 数值键（temperature / maxTokens / 字符数）：'' = 合法（删键回落默认）；
 *     非空必须可解析为数字并满足各自约束（有限数 / 正整数）；
 *   - 字符串键：必须是 string（'' = 删键回落默认）；
 *   - 列表键（执行器种类等）：必须是 string 或 string[]；
 *   - maxDepth：'' / 'provider-managed' / 非负安全整数及其数字字符串。
 * 未知键（旧内容别名等不兼容键）在保存期响亮失败，不做运行时自动兼容。
 * 注意：内容占位变量（variables）的空字符串是合理设计（世界书动态引用），
 * 本函数只校验引擎行为参数，绝不碰 variables 通道。
 */
export interface EngineParamValueError {
  key: string
  message: string
}

type ParamRule =
  | { kind: 'boolean' }
  | { kind: 'number'; check: (value: number) => string | undefined }
  | { kind: 'string'; options?: readonly string[] }
  /** 正则字符串：编译规则与 engine/classify-task.mjs 的 new RegExp(pattern, 'i') 同源。 */
  | { kind: 'pattern' }
  | { kind: 'string-list'; options?: readonly string[] }
  | { kind: 'max-depth' }

const FINITE_NUMBER: (value: number) => string | undefined = (value) =>
  Number.isFinite(value) ? undefined : '必须是有限数字'
const POSITIVE_INTEGER: (value: number) => string | undefined = (value) =>
  Number.isSafeInteger(value) && value > 0 ? undefined : '必须是正整数'

export type EngineParamDefinition = ParamRule & {
  card: string
  /**
   * 显示标签不进 shared：UI 侧按 `param.<键>` 查 prompt-tool 字典（见
   * src/client/locales-params.ts）。shared 不 import client 字典，也不持有任何文案。
   */
  /** 未配置时的编辑草稿；不等于强制写入运行时默认值。 */
  defaultValue: string | number | boolean | undefined
  module?: { row: string; key?: string; mode?: 'editor-default' }
}

/** 类型、校验、卡片归属、草稿默认值和组合行映射的唯一运行时目录。 */
export const ENGINE_PARAM_DEFINITIONS: Record<EngineParamKey, EngineParamDefinition> = {
  firstTurnAnchor: { kind: 'boolean', defaultValue: false, card: 'prompt-defaults' },
  firstTurnText: { kind: 'string', defaultValue: '', card: 'prompt-defaults' },
  firstTurnCustom: { kind: 'boolean', defaultValue: false, card: 'prompt-defaults' },
  guideText: { kind: 'string', defaultValue: '', card: 'prompt-defaults' },
  guideCustom: { kind: 'boolean', defaultValue: false, card: 'prompt-defaults' },
  guideEnabled: { kind: 'boolean', defaultValue: undefined, card: 'prompt-defaults' },
  injectPrompt: { kind: 'boolean', defaultValue: true, card: 'prompt-defaults' },
  modelProvider: { kind: 'string', defaultValue: '', card: 'main-model' },
  modelName: { kind: 'string', defaultValue: '', card: 'main-model' },
  subagentModelProvider: { kind: 'string', defaultValue: '', card: 'subagent-model' },
  subagentModelName: { kind: 'string', defaultValue: '', card: 'subagent-model' },
  modelReasoningEffort: { kind: 'string', defaultValue: '', card: 'main-model' },
  modelTemperature: { kind: 'number', check: FINITE_NUMBER, defaultValue: '', card: 'main-model' },
  modelMaxTokens: { kind: 'number', check: POSITIVE_INTEGER, defaultValue: '', card: 'main-model' },
  subagentReasoningEffort: { kind: 'string', defaultValue: '', card: 'subagent-model' },
  subagentTemperature: { kind: 'number', check: FINITE_NUMBER, defaultValue: '', card: 'subagent-model' },
  subagentMaxTokens: { kind: 'number', check: POSITIVE_INTEGER, defaultValue: '', card: 'subagent-model' },
  maxDepth: { kind: 'max-depth', defaultValue: '', card: 'subagent-tools' },
  firstTurnWord: { kind: 'string', defaultValue: '', card: 'prompt-defaults' },
  buildPattern: { kind: 'pattern', defaultValue: '', card: 'prompt-defaults' },
  complexPattern: { kind: 'pattern', defaultValue: '', card: 'prompt-defaults' },
  firstTurnBuild: { kind: 'string', defaultValue: '', card: 'prompt-defaults' },
  firstTurnInspect: { kind: 'string', defaultValue: '', card: 'prompt-defaults' },
  firstTurnDeep: { kind: 'string', defaultValue: '', card: 'prompt-defaults' },
  guideWeak: { kind: 'string', defaultValue: '', card: 'prompt-defaults' },
  guideDeep: { kind: 'string', defaultValue: '', card: 'prompt-defaults' },
  // B7 T3：card 随 `context-gate` 卡删除一并改到 prompt-defaults。`module.row` 早已绑定到
  // `instruction-hint`（B7 T1），所以这条只改展示归属，不改它写进哪一行配置。
  instructionHint: { kind: 'boolean', defaultValue: false, card: 'prompt-defaults', module: { row: 'instruction-hint', key: 'enabled' } },
  strReplaceEditorMaxOutputChars: { kind: 'number', check: POSITIVE_INTEGER, defaultValue: 16000, card: 'str-replace-editor', module: { row: 'str-replace-editor', key: 'maxOutputChars', mode: 'editor-default' } },
  toolGitBashEnabled: { kind: 'boolean', defaultValue: true, card: 'tool-git-bash', module: { row: 'tool-git-bash', key: 'enabled' } },
  customToolRequireApproval: { kind: 'string-list', options: ['shell', 'http', 'delegate', 'fs', 'ask-user'], defaultValue: '', card: 'tool-config-engine', module: { row: 'tool-config-engine', key: 'requireApproval' } },
}

export const ENGINE_PARAM_KEYS = Object.keys(ENGINE_PARAM_DEFINITIONS) as EngineParamKey[]

/** writePreset.runtimeOf 实际透传键：全部引擎参数可直接进入兼容 writer。 */
export const WRITER_PARAM_KEYS = ENGINE_PARAM_KEYS

/** 编译期断言：WRITER_PARAM_KEYS 与 PresetWriterParams 键必须一致。 */
const _assertWriterParamsKeys: AssertKeysEqual<typeof WRITER_PARAM_KEYS[number], keyof PresetWriterParams> = true

/** 已有逗号分隔/flow-array 语义，client 与生成器共享。 */
export function engineParamList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((item) => item.length > 0)
  if (typeof value !== 'string') return []
  const text = value.trim()
  const inner = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  return inner.split(',').map((item) => item.trim()).filter(Boolean)
}

/** 仅生成声明字段的行配置；复杂的子代理授权仍由 host 所有者处理。 */
export function buildEngineModuleParams(params: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}
  for (const key of ENGINE_PARAM_KEYS) {
    const definition = ENGINE_PARAM_DEFINITIONS[key]
    const binding = definition.module
    if (binding === undefined) continue
    let value = params[key]
    // editor-default：只投影调用方真正提供的合法值。缺参不补目录默认值——参数桥
    // 优先级高于 moduleConfigs 与行默认，补值会把「未配置」写成显式覆盖，压掉
    // 模板/导入预设的行级 maxOutputChars；非法值同样不写，交给行默认兜底。
    if (binding.mode === 'editor-default') {
      if (typeof value === 'string' && value.trim().length > 0) value = Number(value)
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) continue
    }
    if (value === undefined || value === null) continue
    if (definition.kind === 'boolean') value = value === true
    else if (definition.kind === 'string-list') value = engineParamList(value)
    else if (definition.kind === 'string' && (typeof value !== 'string' || value.length === 0)) continue
    else if (definition.kind === 'number') {
      if (typeof value === 'string' && value.trim().length > 0) value = Number(value)
      if (typeof value !== 'number' || definition.check(value) !== undefined) continue
    }
    const config = result[binding.row] ??= {}
    config[binding.key ?? key] = value
  }
  return result
}

/** 仅投影已登记字段，绝不把任意行配置/路径/凭据泄露给浏览器。 */
export function moduleParamFallbacks(configs: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of ENGINE_PARAM_KEYS) {
    const binding = ENGINE_PARAM_DEFINITIONS[key].module
    if (binding === undefined) continue
    const value = configs[binding.row]?.[binding.key ?? key]
    if (value !== undefined) result[key] = value
  }
  return result
}

/** 保存校验与参数桥共用深度解析；无效值在渲染时不覆盖行默认。 */
export function normalizeMaxDepth(value: unknown): number | 'provider-managed' | undefined {
  if (value === 'provider-managed') return value
  const depth = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value
  return typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 0 ? depth : undefined
}

/** 校验单个键值；返回错误消息（undefined = 通过）。 */
function validateParamValue(key: string, rule: ParamRule, value: unknown): string | undefined {
  if (value === '') return undefined
  switch (rule.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${key}: 必须是布尔值`
    case 'number': {
      // '' 是合法删键值（留空 = 不设置）。
      if (value === '') return undefined
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return `${key}: 必须是有限数字（留空 = 不设置）`
        const reason = rule.check(value)
        return reason === undefined ? undefined : `${key}: ${reason}（留空 = 不设置）`
      }
      if (typeof value === 'string') {
        const text = value.trim()
        if (text.length === 0) return `${key}: 必须是数字（留空 = 不设置）`
        const numeric = Number(text)
        if (Number.isNaN(numeric)) return `${key}: 必须是数字（留空 = 不设置）`
        const reason = rule.check(numeric)
        return reason === undefined ? undefined : `${key}: ${reason}（留空 = 不设置）`
      }
      return `${key}: 必须是数字或数字字符串（留空 = 不设置）`
    }
    case 'string':
      if (typeof value !== 'string') return `${key}: 必须是字符串`
      return value === '' || rule.options === undefined || rule.options.includes(value)
        ? undefined : `${key}: 必须为 ${rule.options.join('/')} 或留空`
    case 'pattern': {
      if (typeof value !== 'string') return `${key}: 必须是字符串`
      try {
        // 与引擎消费同源：classify-task 按 flags=i 编译；非法正则会让锚定/引导静默失效，
        // 因此这里在写盘前响亮拒绝，而不是先存下再让策略什么都不做。
        new RegExp(value, 'i')
      } catch (error) {
        return `${key}: 不是合法正则（${error instanceof Error ? error.message : String(error)}；留空 = 不设置）`
      }
      return undefined
    }
    case 'string-list':
      if (typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
        return rule.options !== undefined && engineParamList(value).some((item) => !rule.options!.includes(item))
          ? `${key}: 只允许 ${rule.options.join('/')}` : undefined
      }
      return `${key}: 必须是字符串或字符串数组`
    case 'max-depth':
      return normalizeMaxDepth(value) !== undefined
        ? undefined : `${key}: 必须是非负安全整数、数字字符串、provider-managed 或留空`
  }
}

/**
 * 校验参数键值（键集合合法性由调用方白名单先行校验，本函数同样拒绝未知键）。
 * 返回逐字段错误；空数组 = 通过。类型收窄：布尔/字符串/数值/列表各按 canonical
 * 规则校验；'' 是合法删键值，其余非法类型与越界值在保存层响亮失败。
 */
export function validateEngineParamValues(overrides: Record<string, unknown>): EngineParamValueError[] {
  const errors: EngineParamValueError[] = []
  for (const [key, value] of Object.entries(overrides)) {
    // undefined/null 由保存层跳过。
    if (value === undefined || value === null) continue
    const rule = Object.hasOwn(ENGINE_PARAM_DEFINITIONS, key) ? ENGINE_PARAM_DEFINITIONS[key as EngineParamKey] : undefined
    if (rule === undefined) {
      errors.push({ key, message: `${key}: 未知参数键，请按当前参数定义更新预设` })
      continue
    }
    const message = validateParamValue(key, rule, value)
    if (message !== undefined) errors.push({ key, message })
  }
  return errors
}

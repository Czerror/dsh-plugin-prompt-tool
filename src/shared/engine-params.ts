/**
 * 引擎行为参数契约（单一来源）。
 *
 * 这是「可配置引擎参数」的类型唯一权威：所有消费引擎参数的接口（RuntimeOptions /
 * WriteModuleOptions）从这里派生，不再各自手写一遍字段
 * （此前多处重复声明导致同字段签名漂移，如 modelTemperature）。
 *
 * 分层约定：
 *  - 本文件 = 引擎参数「契约层」（类型）：参数桥/模板/UI 可配置的键与类型；
 *  - ENGINE_PARAM_DEFINITIONS 统一键、校验、卡片、默认草稿与组合映射；
 *    Record<keyof EngineParams, ...> 强制完整覆盖，ENGINE_PARAM_KEYS 与 PARAM_KEYS 从其派生；
 *  - layerSettings ↔ 运行时平铺键：loadModuleSpec 展平 / saveModuleParams 按层写入。
 *
 * 全部字段可选：缺省 = 模板 module.yml layerSettings / 引擎默认，符合「一切皆可自定义」。
 */
import type { InjectionPoint } from './engine-capabilities.ts'

export interface EngineParams {
  presentAsEnabled?: boolean
  ptcMainMode?: string
  ptcSubagentMode?: string
  runCodeEnvEnabled?: boolean
  runCodeEnvKeys?: string[] | string
  toolGitBashPath?: string
  toolGitBashTimeoutMs?: string
  toolGitBashMaxOutputBytes?: string
  instructionHintPromoteOn?: string
  instructionHintIncludeSubagents?: boolean
  instructionHintProjectTemplate?: string
  instructionHintGlobalTemplate?: string
  instructionHintSuffixTemplate?: string
  instructionHintMessageTemplate?: string
  /** 主会话请求路由 provider；与模型名同时非空时生效。 */
  modelProvider?: string
  /** 模型名；与 provider 同时非空时生效。 */
  modelName?: string
  /** 本地子代理请求路由 provider；不改写普通官方委派的创建参数。 */
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
  /** 晋升后 agent-instructions 全文 → 一次性 hint。 */
  instructionHint?: boolean
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
 * writeModule 实际透传进运行时 params 的引擎参数子集。
 * RuntimeOptions（装配态）与 WriteModuleOptions（写入态）都从这里派生，
 * 防止「加参数只改一处、模块写者忘透传」的静默漂移（如 stageAdvanceDescription 历史事故）。
 */
export type ModuleWriterParams = Partial<EngineParams>

/**
 * 数值型引擎参数保存前校验。
 * 保存层响亮失败（400 逐字段错误），渲染层保持宽容（never-brick）：
 *   - 布尔键：必须是 boolean；
 *   - 数值键（temperature / maxTokens / 字符数）：'' = 合法（删键回落默认）；
 *     非空必须可解析为数字并满足各自约束（有限数 / 正整数）；
 *   - 字符串键：必须是 string（'' = 删键回落默认）；
 *   - 列表键（执行器种类等）：必须是 string 或 string[]；
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
  | { kind: 'string-list'; options?: readonly string[] }

const FINITE_NUMBER: (value: number) => string | undefined = (value) =>
  Number.isFinite(value) ? undefined : '必须是有限数字'
const POSITIVE_INTEGER: (value: number) => string | undefined = (value) =>
  Number.isSafeInteger(value) && value > 0 ? undefined : '必须是正整数'

export type EngineParamDefinition = ParamRule & {
  card: string
  /** 稳定磁盘归属，不随编辑卡的显示位置改变。 */
  storageLayer: InjectionPoint
  /**
   * 显示标签不进 shared：UI 侧按 `param.<键>` 查 prompt-tool 字典（见
   * src/client/locales-params.ts）。shared 不 import client 字典，也不持有任何文案。
   */
  /** 未配置时的编辑草稿；不等于强制写入运行时默认值。 */
  defaultValue: string | number | boolean | undefined
  module?: { row: string; key?: string }
  audience?: 'main' | 'subagent'
}

/** 类型、校验、卡片归属、草稿默认值和组合行映射的唯一运行时目录。 */
export const ENGINE_PARAM_DEFINITIONS: Record<EngineParamKey, EngineParamDefinition> = {
  presentAsEnabled: { kind: 'boolean', defaultValue: true, card: 'present-as', storageLayer: 'tool-pipeline', module: { row: 'present-as', key: 'enabled' } },
  ptcMainMode: { kind: 'string', options: ['native', 'ptc'], defaultValue: '', card: 'present-as', storageLayer: 'tool-pipeline', audience: 'main', module: { row: 'present-as', key: 'mainMode' } },
  ptcSubagentMode: { kind: 'string', options: ['native', 'ptc'], defaultValue: '', card: 'present-as', storageLayer: 'tool-pipeline', audience: 'subagent', module: { row: 'present-as', key: 'subagentMode' } },
  runCodeEnvEnabled: { kind: 'boolean', defaultValue: true, card: 'run-code-env', storageLayer: 'tool-pipeline', module: { row: 'run-code-env', key: 'enabled' } },
  runCodeEnvKeys: { kind: 'string-list', defaultValue: '', card: 'run-code-env', storageLayer: 'tool-pipeline', module: { row: 'run-code-env', key: 'envKeys' } },
  modelProvider: { kind: 'string', defaultValue: '', card: 'main-model', storageLayer: 'agent-request' },
  modelName: { kind: 'string', defaultValue: '', card: 'main-model', storageLayer: 'agent-request' },
  subagentModelProvider: { kind: 'string', defaultValue: '', card: 'subagent-model', storageLayer: 'subagent-start' },
  subagentModelName: { kind: 'string', defaultValue: '', card: 'subagent-model', storageLayer: 'subagent-start' },
  modelReasoningEffort: { kind: 'string', defaultValue: '', card: 'main-model', storageLayer: 'agent-request' },
  modelTemperature: { kind: 'number', check: FINITE_NUMBER, defaultValue: '', card: 'main-model', storageLayer: 'agent-request' },
  modelMaxTokens: { kind: 'number', check: POSITIVE_INTEGER, defaultValue: '', card: 'main-model', storageLayer: 'agent-request' },
  subagentReasoningEffort: { kind: 'string', defaultValue: '', card: 'subagent-model', storageLayer: 'subagent-start' },
  subagentTemperature: { kind: 'number', check: FINITE_NUMBER, defaultValue: '', card: 'subagent-model', storageLayer: 'subagent-start' },
  subagentMaxTokens: { kind: 'number', check: POSITIVE_INTEGER, defaultValue: '', card: 'subagent-model', storageLayer: 'subagent-start' },
  instructionHint: { kind: 'boolean', defaultValue: false, card: 'instruction-hint', storageLayer: 'pre-step', module: { row: 'instruction-hint', key: 'enabled' } },
  toolGitBashEnabled: { kind: 'boolean', defaultValue: true, card: 'tool-git-bash', storageLayer: 'tool-pipeline', module: { row: 'tool-git-bash', key: 'enabled' } },
  customToolRequireApproval: { kind: 'string-list', options: ['shell', 'http', 'delegate', 'fs', 'ask-user'], defaultValue: '', card: 'tool-config-engine', storageLayer: 'tool-pipeline', module: { row: 'tool-config-engine', key: 'requireApproval' } },
  toolGitBashPath: { kind: 'string', defaultValue: '', card: 'tool-git-bash', storageLayer: 'tool-pipeline', module: { row: 'tool-git-bash', key: 'bashPath' } },
  toolGitBashTimeoutMs: { kind: 'number', check: POSITIVE_INTEGER, defaultValue: '', card: 'tool-git-bash', storageLayer: 'tool-pipeline', module: { row: 'tool-git-bash', key: 'timeoutMs' } },
  toolGitBashMaxOutputBytes: { kind: 'number', check: POSITIVE_INTEGER, defaultValue: '', card: 'tool-git-bash', storageLayer: 'tool-pipeline', module: { row: 'tool-git-bash', key: 'maxOutputBytes' } },
  instructionHintPromoteOn: { kind: 'string', options: ['either', 'tool-call', 'assistant-message'], defaultValue: '', card: 'instruction-hint', storageLayer: 'pre-step', module: { row: 'instruction-hint', key: 'promoteOn' } },
  instructionHintIncludeSubagents: { kind: 'boolean', defaultValue: true, card: 'instruction-hint', storageLayer: 'pre-step', module: { row: 'instruction-hint', key: 'includeSubagents' } },
  instructionHintProjectTemplate: { kind: 'string', defaultValue: '', card: 'instruction-hint', storageLayer: 'pre-step', module: { row: 'instruction-hint', key: 'projectTemplate' } },
  instructionHintGlobalTemplate: { kind: 'string', defaultValue: '', card: 'instruction-hint', storageLayer: 'pre-step', module: { row: 'instruction-hint', key: 'globalTemplate' } },
  instructionHintSuffixTemplate: { kind: 'string', defaultValue: '', card: 'instruction-hint', storageLayer: 'pre-step', module: { row: 'instruction-hint', key: 'suffixTemplate' } },
  instructionHintMessageTemplate: { kind: 'string', defaultValue: '', card: 'instruction-hint', storageLayer: 'pre-step', module: { row: 'instruction-hint', key: 'messageTemplate' } },
}

export const ENGINE_PARAM_KEYS = Object.keys(ENGINE_PARAM_DEFINITIONS) as EngineParamKey[]

/** writeModule 实际透传键：全部引擎参数可直接进入 writer。 */
export const WRITER_PARAM_KEYS = [...ENGINE_PARAM_KEYS]

/** 编译期断言：WRITER_PARAM_KEYS 与 ModuleWriterParams 键必须一致。 */
const _assertWriterParamsKeys: AssertKeysEqual<typeof WRITER_PARAM_KEYS[number], keyof ModuleWriterParams> = true

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
  const present = configs['present-as']
  if (present !== undefined) {
    const mode = present.mode
    if (result.ptcMainMode === undefined && typeof mode === 'string') result.ptcMainMode = mode
    if (result.ptcSubagentMode === undefined && typeof mode === 'string') result.ptcSubagentMode = mode
  }
  return result
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
    case 'string-list':
      if (typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
        return rule.options !== undefined && engineParamList(value).some((item) => !rule.options!.includes(item))
          ? `${key}: 只允许 ${rule.options.join('/')}` : undefined
      }
      return `${key}: 必须是字符串或字符串数组`
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
      errors.push({ key, message: `${key}: 未知参数键，请按当前参数定义更新模块` })
      continue
    }
    const message = validateParamValue(key, rule, value)
    if (message !== undefined) errors.push({ key, message })
  }
  return errors
}

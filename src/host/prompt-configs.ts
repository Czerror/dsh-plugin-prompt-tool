/**
 * 提示词配置数据接口：默认提示词配置构建、通用 YAML 渲染、多源合并与目录加载。
 *
 * 这是「用户自定义注入内容 + 自定义注入层级位置」的功能层：
 *   1. settings.promptConfigs 数组（UI 设置最终消费此接口）
 *   2. promptConfigsDir 目录（yml/json 提示词配置文件）
 *   3. 默认四条提示词配置
 * 三者按此优先级合并，同名 id 后者覆盖，新 id 追加在默认提示词配置之后。
 * 引擎（engine/prompt-config-engine.mjs）在运行时对生成 yml 做权威校验。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface PromptConfigSpec {
  id: string
  name?: string
  enabled?: boolean
  strategy?: string
  layer?: string
  configKind?: 'ordered' | 'anchor'
  order?: number
  role?: 'user' | 'assistant'
  group?: string
  exclusive?: boolean
  position?: 'after-user' | 'before-all' | 'after-all'
  dedupe?: 'session' | 'batch' | 'none'
  promotion?: 'none' | 'main' | 'include-subagents'
  /** 消息受众：缺省（省略）= 仅主会话；公用=inherit；仅子代理=only。 */
  audience?: '公用' | '仅子代理'
  modelScope?: 'all' | 'pro' | 'flash'
  sourceKind?: string
  form?: string
  summary?: string
  identity?: { field: 'plugin' | 'kind'; value: string }
  text?: string
  /** 单条提示词配置的多段文本：注入为一条消息的多个 text 内容块。 */
  texts?: string[]
  /** 同位置多条提示词配置的插入方式：separate=先后插入独立消息（默认）；merged=拼接为一条消息。 */
  mergeMode?: 'separate' | 'merged'
  templateFile?: string
  fill?: string
  variables?: Record<string, string>
  params?: Record<string, unknown>
}

export interface PromptConfigFile {
  /** 模块文件夹内文件名（数字前缀决定引擎执行顺序）。 */
  file: string
  /** yml 文件内容。 */
  content: string
}

/** buildCordis 兼容层的运行时选项（生产路径为 writePreset + preset.yml 数据驱动）。 */
export interface BuildCordisOptions {
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
  /** 锚定确认后注入 preset.md；关闭时仍保留工具引导，但不生成 prompt-injector 提示词配置内容。 */
  injectPrompt?: boolean
  /** 子代理固定模型路由 provider；与模型名同时非空时给 subagent/subagent_fork 行加 agentOptions。 */
  subagentModelProvider?: string
  /** 子代理固定模型名；与 provider 同时非空时生效。 */
  subagentModelName?: string
  /** 子代理独立 persona（per-child shadow；缺省回退 fastModelPersona，两者缺省=继承主会话）。 */
  subagentPersona?: string
  /** 子代理工具集白名单（toolFilter.allow；支持数组或逗号/空格分隔字符串）。 */
  subagentToolFilterAllow?: string[] | string
  /** 子代理工具集黑名单（toolFilter.deny）。 */
  subagentToolFilterDeny?: string[] | string
  /** 子代理递归深度上限（0 禁止委派 / provider-managed / 正整数）。 */
  subagentMaxDepth?: number | 'provider-managed'
  /** 主对话快速模型路由人设（覆盖 preset.yml fastModelPersona 默认）。 */
  fastModelPersona?: string
  /** 注入 kind 白名单（context-gate allowKinds；数组或逗号分隔字符串）。 */
  allowKinds?: string[] | string
  /** custom-fallback 锚定词（prompt-injector params.firstTurnWord）。 */
  firstTurnWord?: string
  /** 首轮输出封顶（bootstrapMaxTokens）；0 或未设置 = 本项目默认无封顶。 */
  bootstrapMaxTokens?: number
  /** 使用 PTC 模式：默认 true。 */
  usePtcMode?: boolean
}

/** 文本块缩进 n 个空格（YAML block scalar）。 */
function indentBy(level: number, text: string): string {
  const pad = ' '.repeat(level)
  return text.split(/\r?\n/).map((line) => (line.length === 0 ? '' : pad + line)).join('\n')
}

/** YAML 标量渲染：字符串非空用 block scalar，空串 quoted，布尔/数字原样。 */
function yamlScalar(key: string, level: number, value: unknown): string {
  const pad = ' '.repeat(level)
  if (typeof value === 'string') {
    return value.length === 0 ? `${pad}${key}: ''` : `${pad}${key}: |-\n${indentBy(level + 2, value)}`
  }
  if (typeof value === 'boolean' || typeof value === 'number') return `${pad}${key}: ${String(value)}`
  if (value === null || value === undefined) return ''
  return `${pad}${key}: ${JSON.stringify(value)}`
}

/** 嵌套 map 渲染（variables / params / identity）。 */
function yamlMap(level: number, value: Record<string, unknown>): string[] {
  const pad = ' '.repeat(level)
  const lines: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue
    if (typeof item === 'object' && !Array.isArray(item)) {
      lines.push(`${pad}${key}:`)
      lines.push(...yamlMap(level + 2, item as Record<string, unknown>))
    } else {
      const line = yamlScalar(key, level, item)
      if (line.length > 0) lines.push(line)
    }
  }
  return lines
}

/** 把任意提示词配置 spec 渲染为独立提示词配置模块 yml（全部字段开放可配置）。 */
export function renderPromptConfigYaml(spec: PromptConfigSpec): string {
  const lines: string[] = [`id: ${spec.id}`]
  if (typeof spec.name === 'string' && spec.name.length > 0 && spec.name !== spec.id) lines.push(`name: ${spec.name}`)
  if (spec.configKind !== undefined) lines.push(`configKind: ${spec.configKind}`)
  if (spec.layer !== undefined) lines.push(`layer: ${spec.layer}`)
  if (spec.order !== undefined) lines.push(`order: ${spec.order}`)
  if (spec.role !== undefined) lines.push(`role: ${spec.role}`)
  lines.push(`enabled: ${spec.enabled !== false}`)
  lines.push(`strategy: ${spec.strategy ?? 'static'}`)
  if (spec.position !== undefined) lines.push(`position: ${spec.position}`)
  if (spec.dedupe !== undefined) lines.push(`dedupe: ${spec.dedupe}`)
  if (spec.promotion !== undefined) lines.push(`promotion: ${spec.promotion}`)
  if (spec.audience !== undefined) lines.push(`audience: ${spec.audience}`)
  if (spec.modelScope !== undefined) lines.push(`modelScope: ${spec.modelScope}`)
  if (typeof spec.group === 'string' && spec.group.length > 0) lines.push(`group: ${spec.group}`)
  if (spec.exclusive === true) lines.push('exclusive: true')
  if (typeof spec.sourceKind === 'string' && spec.sourceKind.length > 0 && spec.sourceKind !== spec.id) lines.push(`sourceKind: ${spec.sourceKind}`)
  if (typeof spec.form === 'string' && spec.form.length > 0 && spec.form !== 'notice') lines.push(`form: ${spec.form}`)
  if (typeof spec.summary === 'string' && spec.summary.length > 0) lines.push(yamlScalar('summary', 0, spec.summary))
  if (typeof spec.templateFile === 'string' && spec.templateFile.length > 0) lines.push(`templateFile: ${spec.templateFile}`)
  if (typeof spec.fill === 'string' && spec.fill.length > 0) lines.push(`fill: ${spec.fill}`)
  // text/texts 统一：text 为单块便捷写法，渲染归一为 texts。
  const texts = [
    ...(typeof spec.text === 'string' && spec.text.length > 0 ? [spec.text] : []),
    ...(Array.isArray(spec.texts) ? spec.texts : []),
  ]
  if (texts.length > 0) lines.push(`texts: ${JSON.stringify(texts)}`)
  if (spec.mergeMode !== undefined && spec.mergeMode !== 'separate') lines.push(`mergeMode: ${spec.mergeMode}`)
  if (spec.identity !== undefined && spec.identity.value !== spec.id) {
    lines.push('identity:', `  field: ${spec.identity.field}`, `  value: ${spec.identity.value}`)
  }
  if (spec.variables !== undefined && Object.keys(spec.variables).length > 0) {
    lines.push('variables:')
    lines.push(...yamlMap(2, spec.variables as Record<string, unknown>))
  }
  if (spec.params !== undefined && Object.keys(spec.params).length > 0) {
    lines.push('params:')
    lines.push(...yamlMap(2, spec.params))
  }
  return lines.join('\n').trimEnd()
}

/** 多源提示词配置合并：同名 id 后者覆盖（保留默认提示词配置位置），新 id 追加在末尾。 */
export function mergePromptConfigs(...sources: Array<PromptConfigSpec[] | undefined>): PromptConfigSpec[] {
  const ordered: PromptConfigSpec[] = []
  const byId = new Map<string, number>()
  for (const source of sources) {
    for (const spec of source ?? []) {
      if (spec === null || typeof spec !== 'object' || typeof spec.id !== 'string' || spec.id.length === 0) {
        throw new TypeError('every prompt config must have a non-empty string id')
      }
      const existing = byId.get(spec.id)
      if (existing === undefined) {
        byId.set(spec.id, ordered.length)
        ordered.push(spec)
      } else {
        ordered[existing] = spec
      }
    }
  }
  return ordered
}

/** 从用户提示词配置目录加载 yml/json 提示词配置（文件名排序；内容必须能解析）。 */
export function loadPromptConfigFiles(dir: string): PromptConfigSpec[] {
  if (dir.length === 0) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    throw new Error(`promptConfigsDir ${JSON.stringify(dir)} is not readable: ${String((error as Error).message ?? error)}`)
  }
  const specs: PromptConfigSpec[] = []
  const files = entries
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of files) {
    const raw = readFileSync(join(dir, entry.name), 'utf8')
    const parsed = /\.json$/i.test(entry.name) ? JSON.parse(raw) : parseYaml(raw, { logLevel: 'silent' })
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`prompt config file ${entry.name} must contain a single config object`)
    }
    if (typeof (parsed as { id?: unknown }).id !== 'string') {
      throw new Error(`prompt config file ${entry.name} must declare a string id`)
    }
    specs.push(parsed as PromptConfigSpec)
  }
  return specs
}

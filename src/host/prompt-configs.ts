/**
 * 提示词配置数据接口：默认提示词配置构建、通用 YAML 渲染、多源合并与目录加载。
 *
 * 这是「用户自定义注入内容 + 自定义注入层级位置」的功能层：
 *   1. settings.promptConfigs 数组（UI 设置最终消费此接口）
 *   2. 生成目录 prompt-configs/（yml/json 提示词配置文件）
 *   3. 默认四条提示词配置
 * 三者按此优先级合并，同名 id 后者覆盖，新 id 追加在默认提示词配置之后。
 * 引擎（engine/prompt-config-engine.mjs）在运行时对生成 yml 做权威校验。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYamlValue } from 'yaml'

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
  /** 消息受众：缺省（省略/null）= 公用（主会话+子代理）；main=仅主会话；subagent=仅子代理。 */
  audience?: 'main' | 'subagent' | null
  /** 条件判定的匹配对象；缺省由层决定（engine/schema.mjs 的 LAYER_DEFAULT_SUBJECT）。 */
  subject?: 'toolArgs' | 'toolResult' | 'userMessage' | 'assistantText' | 'subagentInfo'
  /** 条件判定的键集合；省略 = 无条件（旧行为）。 */
  match?: PromptConfigMatch
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

/**
 * 提示词配置 / 自定义工具 ID 的安全文件名段校验：ID 直接拼进生成文件名
 * （prompt-configs/<n>-<id>.yml / custom-tools/<n>-<id>.yml），含路径分隔符
 * 或 Windows 非法字符会越出生成目录或写盘失败，保存/物化前 fail loud 拒绝。
 * 允许 [a-zA-Z0-9._-] 与常见中文/多字节字符（ST 导入 id 含中文），
 * 仅拒绝分隔符、控制字符、点目录与 Windows 保留字符。
 */
export function assertSafeConfigId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('config id must be a non-empty string')
  }
  if (id === '.' || id === '..') {
    throw new TypeError(`config id ${JSON.stringify(id)} must not be a dot directory`)
  }
  const reserved = '/\\\0:*?"<>|'
  for (const char of reserved) {
    if (id.includes(char)) {
      throw new TypeError(`config id ${JSON.stringify(id)} contains path separators or reserved filename characters`)
    }
  }
  for (let index = 0; index < id.length; index += 1) {
    if (id.charCodeAt(index) < 0x20) {
      throw new TypeError(`config id ${JSON.stringify(id)} contains control characters`)
    }
  }
}

/** 生成文件名统一 4 位零填充前缀（0000-…），超过 10 条后字典序仍稳定。 */
export function configFileName(index: number, id: string): string {
  assertSafeConfigId(id)
  return `${String(index).padStart(4, '0')}-${id}.yml`
}
export interface PromptConfigFile {
  /** 模块文件夹内文件名（数字前缀决定引擎执行顺序）。 */
  file: string
  /** yml 文件内容。 */
  content: string
}

/**
 * 条件判定的键集合：与 `engine/anchor-match.mjs` 的匹配语义同构。
 * 键按字面文本匹配（正则元字符会被转义）；要写正则须用 `/pattern/flags` 形态或 `useRegex: true`。
 */
export interface PromptConfigMatch {
  keys?: string[]
  secondaryKeys?: string[]
  logic?: 'any' | 'all' | 'not' | 'notAny'
  caseSensitive?: boolean
  wholeWords?: boolean
  useRegex?: boolean
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

/**
 * 用户提供的字符串写成 YAML 标量：引号由 yaml 适配器决定，不手写规则。
 * 裸写会破坏往返的两类真实素材：数字/布尔/null 形状（`name: "1"` → 解析回 number，
 * 触发 `name must be a non-empty string`）与特殊起始字符（`[主控制器]全能世界书`、
 * `{{user}}档案`、`[new]剧情生成器[...]` → 解析报错），两者都会让**整个预设无法挂载**。
 * 多行值不在此函数内联处理（调用方均为单行字段），必要时退化为 JSON 双引号标量。
 */
function yamlSafeScalar(text: string): string {
  const emitted = stringifyYamlValue(text).trimEnd()
  return emitted.includes('\n') ? JSON.stringify(text) : emitted
}

/** 把任意提示词配置 spec 渲染为独立提示词配置模块 yml（全部字段开放可配置）。 */
export function renderPromptConfigYaml(spec: PromptConfigSpec): string {
  const lines: string[] = [`id: ${yamlSafeScalar(spec.id)}`]
  if (typeof spec.name === 'string' && spec.name.length > 0 && spec.name !== spec.id) lines.push(`name: ${yamlSafeScalar(spec.name)}`)
  if (spec.configKind !== undefined) lines.push(`configKind: ${yamlSafeScalar(spec.configKind)}`)
  if (spec.layer !== undefined) lines.push(`layer: ${spec.layer}`)
  if (spec.order !== undefined) lines.push(`order: ${spec.order}`)
  if (spec.role !== undefined) lines.push(`role: ${spec.role}`)
  lines.push(`enabled: ${spec.enabled !== false}`)
  lines.push(`strategy: ${spec.strategy ?? 'static'}`)
  if (spec.position !== undefined) lines.push(`position: ${spec.position}`)
  if (spec.dedupe !== undefined) lines.push(`dedupe: ${spec.dedupe}`)
  if (spec.promotion !== undefined) lines.push(`promotion: ${spec.promotion}`)
  if (spec.audience !== undefined && spec.audience !== null) lines.push(`audience: ${spec.audience}`)
  if (spec.modelScope !== undefined) lines.push(`modelScope: ${spec.modelScope}`)
  if (typeof spec.group === 'string' && spec.group.length > 0) lines.push(`group: ${yamlSafeScalar(spec.group)}`)
  if (spec.exclusive === true) lines.push('exclusive: true')
  if (typeof spec.sourceKind === 'string' && spec.sourceKind.length > 0 && spec.sourceKind !== spec.id) lines.push(`sourceKind: ${yamlSafeScalar(spec.sourceKind)}`)
  if (typeof spec.form === 'string' && spec.form.length > 0 && spec.form !== 'notice') lines.push(`form: ${yamlSafeScalar(spec.form)}`)
  if (typeof spec.summary === 'string' && spec.summary.length > 0) lines.push(yamlScalar('summary', 0, spec.summary))
  if (typeof spec.templateFile === 'string' && spec.templateFile.length > 0) lines.push(`templateFile: ${yamlSafeScalar(spec.templateFile)}`)
  if (typeof spec.fill === 'string' && spec.fill.length > 0) lines.push(`fill: ${yamlSafeScalar(spec.fill)}`)
  if (typeof spec.subject === 'string' && spec.subject.length > 0) lines.push(`subject: ${yamlSafeScalar(spec.subject)}`)
  // 条件判定：只输出有内容的键集合；空 match 会在挂载期被引擎拒绝，不落盘半成品。
  const match = spec.match
  if (match !== undefined && match !== null
    && ((Array.isArray(match.keys) && match.keys.length > 0) || (Array.isArray(match.secondaryKeys) && match.secondaryKeys.length > 0))) {
    lines.push('match:')
    if (Array.isArray(match.keys) && match.keys.length > 0) lines.push(`  keys: ${JSON.stringify(match.keys)}`)
    if (Array.isArray(match.secondaryKeys) && match.secondaryKeys.length > 0) lines.push(`  secondaryKeys: ${JSON.stringify(match.secondaryKeys)}`)
    if (typeof match.logic === 'string' && match.logic.length > 0 && match.logic !== 'any') lines.push(`  logic: ${match.logic}`)
    if (match.caseSensitive === true) lines.push('  caseSensitive: true')
    if (match.wholeWords === true) lines.push('  wholeWords: true')
    if (match.useRegex !== undefined) lines.push(`  useRegex: ${match.useRegex === true}`)
  }
  // text/texts 统一：单段输出 text（对齐官方 PromptSection.text 单字符串语义），
  // 多段保留 texts 数组（pre-step 多 content block / mergeMode=merged 拼接）。
  const texts = [
    ...(typeof spec.text === 'string' && spec.text.length > 0 ? [spec.text] : []),
    ...(Array.isArray(spec.texts) ? spec.texts : []),
  ]
  if (texts.length === 1) lines.push(yamlScalar('text', 0, texts[0]!))
  else if (texts.length > 1) lines.push(`texts: ${JSON.stringify(texts)}`)
  if (spec.mergeMode !== undefined && spec.mergeMode !== 'separate') lines.push(`mergeMode: ${spec.mergeMode}`)
  if (spec.identity !== undefined && spec.identity.value !== spec.id) {
    lines.push('identity:', `  field: ${yamlSafeScalar(spec.identity.field)}`, `  value: ${yamlSafeScalar(spec.identity.value)}`)
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
    const seen = new Set<string>()
    for (const spec of source ?? []) {
      if (spec === null || typeof spec !== 'object' || typeof spec.id !== 'string' || spec.id.length === 0) {
        throw new TypeError('every prompt config must have a non-empty string id')
      }
      // 单源数组内重复 ID：后条覆盖前条会造成静默丢卡，合并前拒绝（跨源覆盖保留）。
      if (seen.has(spec.id)) {
        throw new TypeError(`duplicate prompt config id ${JSON.stringify(spec.id)} within a single source`)
      }
      seen.add(spec.id)
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
    throw new Error(`提示词配置目录 ${JSON.stringify(dir)} 不可读: ${String((error as Error).message ?? error)}`)
  }
  const specs: PromptConfigSpec[] = []
  const files = entries
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of files) {
    // 预设级模板变量文件（writePreset 生成）：非提示词配置，UI 由「模板变量」卡片管理。
    if (entry.name === 'variables.yml') continue
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



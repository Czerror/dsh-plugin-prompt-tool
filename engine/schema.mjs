/**
 * schema — prompt-config-engine 的提示词配置加载、归一化与权威校验。
 * 只负责"配置长什么样";执行语义见 executor.mjs,内容策略见 strategies.mjs。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { parse as parseYaml } from './vendor/yaml/index.js'
import { bindResolver } from './strategies.mjs'

const name = 'prompt-config-engine'

/**
 * 内容模板加载:提示词配置可声明 templateFile,由外部 yml / json / 纯文本模板提供内容,
 * 引擎只负责读取与注入(内容与执行分离)。
 *   - .json:解析为 { text, id?, role?, content?, source? },或纯字符串;
 *   - .yml/.yaml:用 vendored yaml 完整解析(顶层对象取 text 等字段);
 *   - 其他扩展名:整个文件内容作为 text。
 */
function readTextFile(url) {
  return readFileSync(url, 'utf8')
}

function loadTemplate(file) {
  if (typeof file !== 'string' || file.length === 0) return undefined
  let raw
  try {
    raw = readTextFile(new URL(file, import.meta.url))
  } catch {
    throw new TypeError(`${name}: templateFile ${JSON.stringify(file)} is not readable`)
  }
  if (/\.json$/i.test(file)) {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'string' ? { text: parsed } : parsed
    } catch (error) {
      throw new TypeError(`${name}: templateFile ${JSON.stringify(file)} is not valid JSON: ${String(error?.message ?? error)}`)
    }
  }
  if (/\.ya?ml$/i.test(file)) {
    try {
      const parsed = parseYaml(raw)
      return typeof parsed === 'string' ? { text: parsed } : parsed
    } catch (error) {
      throw new TypeError(`${name}: templateFile ${JSON.stringify(file)} is not valid YAML: ${String(error?.message ?? error)}`)
    }
  }
  return { text: raw }
}

/**
 * 完整 YAML 解析(vendored yaml 包):提示词配置文件直接使用标准 YAML。
 * 支持缩进 map、列表、block scalar、行尾注释、引号转义等全部语法。
 */
export function parsePromptConfigYaml(raw) {
  const parsed = parseYaml(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${name}: prompt config yaml must contain a single object`)
  }
  return parsed
}

/**
 * 从提示词配置模块目录加载全部提示词配置描述:按文件名排序扫描 *.yml / *.yaml / *.json。
 * 文件名用数字前缀表达引擎执行顺序(00-…、10-…)。
 */
export function loadPromptConfigFiles(dirUrl) {
  let entries
  try {
    entries = readdirSync(dirUrl, { withFileTypes: true })
  } catch (error) {
    throw new TypeError(`${name}: configsDir ${String(dirUrl)} is not readable: ${String(error?.message ?? error)}`)
  }
  const specs = []
  const files = entries
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of files) {
    const url = new URL(entry.name, dirUrl)
    const raw = readFileSync(url, 'utf8')
    if (/\.json$/i.test(entry.name)) {
      specs.push(JSON.parse(raw))
    } else {
      specs.push(parsePromptConfigYaml(raw))
    }
  }
  return specs
}

export const KNOWN_STRATEGIES = new Set(['static', 'placeholder', 'instruction-hint', 'anchor-auto', 'guide-auto', 'anchor-fallback', 'we-fallback'])
export const KNOWN_SLOT_KINDS = new Set(['ordered', 'anchor'])
export const KNOWN_LAYERS = new Set(['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline'])
export const KNOWN_POSITIONS = new Set(['after-user', 'before-all', 'after-all'])
export const KNOWN_DEDUPES = new Set(['session', 'batch', 'none'])
export const KNOWN_PROMOTIONS = new Set(['none', 'main', 'include-subagents'])
export const KNOWN_SUBAGENT_MODES = new Set(['none', 'inherit', 'only'])
export const KNOWN_MERGE_MODES = new Set(['separate', 'merged'])
export const KNOWN_MODEL_SCOPES = new Set(['all', 'pro', 'flash'])
export const KNOWN_ROLES = new Set(['user', 'assistant'])
export const KNOWN_FILLS = new Set(['instruction-hint', 'env-facts', 'skill-catalog'])

/** 从 YAML 提示词配置描述构造运行时提示词配置。配置错误必须在挂载时暴露(fail loud)。 */
export function createPromptConfigs(specs, options = {}) {
  if (specs === undefined) return []
  if (!Array.isArray(specs)) throw new TypeError(`${name}: config.configs must be an array`)
  const configs = specs.map((spec, index) => {
    const label = `configs[${index}]`
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new TypeError(`${name}: ${label} must be an object`)
    }
    if (typeof spec.id !== 'string' || spec.id.length === 0) {
      throw new TypeError(`${name}: ${label}.id must be a non-empty string`)
    }
    const strategy = spec.strategy ?? 'static'
    if (!KNOWN_STRATEGIES.has(strategy)) {
      // 模板专属策略:声明了 strategyDir 时由 strategies.bindResolver 懒加载,
      // 否则视为未知策略 fail loud。
      if (typeof options.strategyDir !== 'string' || options.strategyDir.length === 0) {
        throw new TypeError(`${name}: ${label} unknown strategy ${JSON.stringify(strategy)}`)
      }
    }
    const configKind = spec.configKind ?? 'ordered'
    if (!KNOWN_SLOT_KINDS.has(configKind)) {
      throw new TypeError(`${name}: ${label} unknown configKind ${JSON.stringify(configKind)}`)
    }
    const layer = spec.layer ?? 'pre-step'
    if (!KNOWN_LAYERS.has(layer)) {
      throw new TypeError(`${name}: ${label} unknown layer ${JSON.stringify(layer)} — known layers: ${[...KNOWN_LAYERS].sort().join(', ')}`)
    }
    const position = spec.position ?? 'after-user'
    if (!KNOWN_POSITIONS.has(position)) {
      throw new TypeError(`${name}: ${label} unknown position ${JSON.stringify(position)}`)
    }
    const dedupe = spec.dedupe ?? 'none'
    if (!KNOWN_DEDUPES.has(dedupe)) {
      throw new TypeError(`${name}: ${label} unknown dedupe ${JSON.stringify(dedupe)}`)
    }
    const promotion = spec.promotion ?? 'none'
    if (!KNOWN_PROMOTIONS.has(promotion)) {
      throw new TypeError(`${name}: ${label} unknown promotion ${JSON.stringify(promotion)}`)
    }
    const subagents = spec.subagents ?? 'none'
    if (!KNOWN_SUBAGENT_MODES.has(subagents)) {
      throw new TypeError(`${name}: ${label} unknown subagents ${JSON.stringify(subagents)}`)
    }
    const modelScope = spec.modelScope ?? 'all'
    if (!KNOWN_MODEL_SCOPES.has(modelScope)) {
      throw new TypeError(`${name}: ${label} unknown modelScope ${JSON.stringify(modelScope)}`)
    }
    const role = spec.role ?? 'user'
    if (!KNOWN_ROLES.has(role)) {
      throw new TypeError(`${name}: ${label} unknown role ${JSON.stringify(role)}`)
    }
    const identity = spec.identity ?? { field: 'plugin', value: spec.id }
    if (identity === null || typeof identity !== 'object' || Array.isArray(identity)
      || !['plugin', 'kind'].includes(identity.field) || typeof identity.value !== 'string' || identity.value.length === 0) {
      throw new TypeError(`${name}: ${label}.identity must be { field: 'plugin'|'kind', value: string }`)
    }
    const order = spec.order ?? 0
    if (typeof order !== 'number' || !Number.isFinite(order)) {
      throw new TypeError(`${name}: ${label}.order must be a finite number`)
    }
    if (spec.group !== undefined && (typeof spec.group !== 'string' || spec.group.length === 0)) {
      throw new TypeError(`${name}: ${label}.group must be a non-empty string when present`)
    }
    if (spec.exclusive !== undefined && typeof spec.exclusive !== 'boolean') {
      throw new TypeError(`${name}: ${label}.exclusive must be a boolean when present`)
    }
    if (spec.name !== undefined && (typeof spec.name !== 'string' || spec.name.length === 0)) {
      throw new TypeError(`${name}: ${label}.name must be a non-empty string when present`)
    }
    if (spec.variables !== undefined && (spec.variables === null || typeof spec.variables !== 'object' || Array.isArray(spec.variables))) {
      throw new TypeError(`${name}: ${label}.variables must be an object when present`)
    }
    if (spec.texts !== undefined && (!Array.isArray(spec.texts) || spec.texts.some((item) => typeof item !== 'string'))) {
      throw new TypeError(`${name}: ${label}.texts must be an array of strings when present`)
    }
    if (spec.mergeGroup !== undefined && (typeof spec.mergeGroup !== 'string' || spec.mergeGroup.length === 0)) {
      throw new TypeError(`${name}: ${label}.mergeGroup must be a non-empty string when present`)
    }
    const priority = spec.priority ?? 0
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      throw new TypeError(`${name}: ${label}.priority must be a finite number`)
    }
    const mergeMode = spec.mergeMode ?? 'separate'
    if (!KNOWN_MERGE_MODES.has(mergeMode)) {
      throw new TypeError(`${name}: ${label} unknown mergeMode ${JSON.stringify(mergeMode)}`)
    }
    if (strategy === 'placeholder' && layer !== 'pre-step' && layer !== 'runtime-context') {
      throw new TypeError(`${name}: ${label} strategy=placeholder supports layer pre-step or runtime-context only, got ${JSON.stringify(layer)}`)
    }
    let fill
    if (strategy === 'placeholder') {
      fill = typeof spec.fill === 'string' && spec.fill.length > 0 ? spec.fill : undefined
      if (fill === undefined || !KNOWN_FILLS.has(fill)) {
        throw new TypeError(`${name}: ${label} strategy=placeholder requires fill in [${[...KNOWN_FILLS].sort().join(', ')}]`)
      }
    }
    const template = loadTemplate(spec.templateFile)
    const templatePatch = template !== null && typeof template === 'object'
      ? { id: template.id, role: template.role, content: template.content, source: template.source }
      : undefined
    const config = {
      id: spec.id,
      name: typeof spec.name === 'string' ? spec.name : spec.id,
      enabled: spec.enabled !== false,
      strategy,
      configKind,
      layer,
      group: typeof spec.group === 'string' ? spec.group : undefined,
      exclusive: spec.exclusive === true,
      order,
      role,
      fill,
      position,
      dedupe,
      promotion,
      subagents,
      modelScope,
      sourceKind: typeof spec.sourceKind === 'string' && spec.sourceKind.length > 0 ? spec.sourceKind : spec.id,
      form: typeof spec.form === 'string' ? spec.form : 'notice',
      summary: typeof spec.summary === 'string' ? spec.summary : '',
      identity,
      text: typeof spec.text === 'string' && spec.text.length > 0 ? spec.text : (typeof template?.text === 'string' ? template.text : ''),
      texts: Array.isArray(spec.texts) ? spec.texts.filter((item) => typeof item === 'string' && item.length > 0) : [],
      mergeMode,
      mergeGroup: typeof spec.mergeGroup === 'string' && spec.mergeGroup.length > 0 ? spec.mergeGroup : undefined,
      priority,
      variables: spec.variables !== null && typeof spec.variables === 'object' && !Array.isArray(spec.variables) ? spec.variables : {},
      templatePatch,
      params: spec.params !== null && typeof spec.params === 'object' && !Array.isArray(spec.params) ? spec.params : {},
    }
    config.resolve = bindResolver(config, options.strategyDir)
    return config
  })
  // 排序契约:anchor 提示词配置保持模块文件相对顺序(固定锚点),ordered 提示词配置按 order
  // 稳定升序排在其后。默认 order=0 时等价于文件顺序。
  return configs
    .map((config, fileOrder) => ({ config, fileOrder }))
    .sort((a, b) => {
      const aAnchor = a.config.configKind === 'anchor' ? 0 : 1
      const bAnchor = b.config.configKind === 'anchor' ? 0 : 1
      if (aAnchor !== bAnchor) return aAnchor - bAnchor
      if (aAnchor === 1 && a.config.order !== b.config.order) return a.config.order - b.config.order
      return a.fileOrder - b.fileOrder
    })
    .map(({ config }) => config)
}

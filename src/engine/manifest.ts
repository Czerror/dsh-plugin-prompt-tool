/**
 * manifest — 预设模板单一参数 YAML(preset.yml)的加载与引擎参数解析。
 *
 * 一个预设 = 一个 preset.yml:
 *   - modules/params/content/meta/settingsExtension 全部是直读参数,无模板语法;
 *   - 默认提示词配置由引擎按 params 生成(见 write-preset),promptConfigs 仅为可选覆盖;
 *   - 组合模块中的 __TOKEN__ 由引擎内部 renderEngineTokens 按 params 生成,
 *     不再暴露到参数文件。
 * 本模块负责参数归一化与引擎 token 渲染;所有 anchored 专属行为都在引擎内部。
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

export interface PresetSpec {
  id: string
  name: string
  version: string
  engineCompat: string
  meta?: Record<string, unknown>
  content?: { presetText?: string; agentsText?: string }
  /** 模块清单(参数文件决定组合内容):按序装配 engine/compositions/library/<name>.yml。 */
  modules?: string[]
  /** 兼容字段:内联组合文本或组合清单名。 */
  composition?: string
  /** 扁平参数:全部直读(true/false、数字、字符串),on/off 作为兼容写法。 */
  params?: Record<string, unknown>
  /** 宿主层默认值(唯一入口):apply 时合并进 Config,settings 仍可覆盖。 */
  hostDefaults?: Record<string, unknown>
  /** 可选:模板自定义提示词配置覆盖(纯数据,不使用模板语法)。 */
  promptConfigs?: unknown[]
  settingsExtension?: Record<string, unknown>
  legacyCleanup?: string[]
  upstream?: Record<string, unknown>
}

/** 包根 preset/ 目录(配置/模板文件夹):兼容源码运行(src/engine)与打包运行(lib/)。 */
export function packagePresetDir(): string {
  const candidates = [
    new URL('../preset/', import.meta.url),
    new URL('../../preset/', import.meta.url),
  ]
  for (const candidate of candidates) {
    const dir = fileURLToPath(candidate)
    if (existsSync(dir)) return dir
  }
  throw new Error('prompt-tool: cannot locate package preset/ directory')
}

/** 包根 engine/ 目录(插件引擎,与配置文件夹分离):兼容源码与打包运行。 */
export function packageEngineDir(): string {
  const candidates = [
    new URL('../engine/', import.meta.url),
    new URL('../../engine/', import.meta.url),
  ]
  for (const candidate of candidates) {
    const dir = fileURLToPath(candidate)
    if (existsSync(join(dir, 'prompt-config-engine.mjs'))) return dir
  }
  throw new Error('prompt-tool: cannot locate package engine/ directory')
}

/** 加载某个预设模板的单一参数文件 preset/<name>/preset.yml。 */
export function loadPresetSpec(dir: string): PresetSpec {
  const raw = readFileSync(join(dir, 'preset.yml'), 'utf8')
  const parsed = parseYaml(raw, { logLevel: 'silent' }) as Partial<PresetSpec> | null
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new Error(`preset ${join(dir, 'preset.yml')} must declare a non-empty string id`)
  }
  if (!Array.isArray(parsed.modules) && (typeof parsed.composition !== 'string' || parsed.composition.length === 0)) {
    throw new Error(`preset ${parsed.id} must declare a modules list or a composition`)
  }
  return parsed as PresetSpec
}

/** 读取预设模板内容资产(presetText / agentsText);模板缺失时静默降级。 */
export function loadPresetContent(template = 'anchored'): { presetText: string; agentsText: string } {
  try {
    const spec = loadPresetSpec(join(packagePresetDir(), template))
    return {
      presetText: typeof spec.content?.presetText === 'string' ? spec.content.presetText : '',
      agentsText: typeof spec.content?.agentsText === 'string' ? spec.content.agentsText : '',
    }
  } catch {
    return { presetText: '', agentsText: '' }
  }
}

const asString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return fallback
  return String(value)
}

/** on/off 等字面开关归一化为布尔。 */
function normalizeParam(value: unknown): unknown {
  if (value === 'on') return true
  if (value === 'off') return false
  return value
}

/** camelCase → SCREAMING_SNAKE_CASE(usePtcMode → USE_PTC_MODE)。 */
function upperKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

/** 预设 params(默认参数)与运行时 settings 合并;settings 值优先。 */
export function resolvePresetParams(spec: PresetSpec, runtime: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(spec.params ?? {})) params[key] = normalizeParam(value)
  for (const [key, value] of Object.entries(runtime)) {
    if (value !== undefined) params[key] = value
  }
  if (typeof params.promptText !== 'string' || params.promptText.length === 0) {
    params.promptText = typeof runtime.promptText === 'string' ? runtime.promptText : ''
  }
  // SCREAMING_SNAKE_CASE 别名供引擎组合模块 token 使用(引擎内部约定)。
  for (const key of Object.keys(params)) {
    params[upperKey(key)] = params[key]
  }
  return params
}

/** {{key}} 嵌套插值(块模板内引用 params)。 */
function interpolateNested(text: string, scope: Record<string, unknown>): string {
  return text.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (whole, key: string, offset: number) => {
    if (!Object.prototype.hasOwnProperty.call(scope, key)) return whole
    const value = asString(scope[key])
    if (!value.includes('\n')) return value
    const lineStart = text.lastIndexOf('\n', offset) + 1
    const prefix = text.slice(lineStart, offset)
    return value.split('\n').map((line, at) => (at === 0 ? line : (line.length > 0 ? prefix + line : ''))).join('\n')
  })
}

/**
 * 引擎内部 token 渲染:把直读参数变成组合模块里的 __TOKEN__ 值。
 * anchored 的全部组合行为(usePtcMode/bootstrapMaxTokens/subagentFlash/flashPersona)
 * 在这里完成参数化,用户参数文件不需要任何模板语法。
 */
export function renderEngineTokens(params: Record<string, unknown>): Record<string, string> {
  const flashPersona = asString(params.flashPersona)
  const provider = asString(params.subagentFlashProvider, 'deepseek-official')
  const model = asString(params.subagentFlashModel, 'deepseek-v4-flash')
  const subagentFlashBlock = params.subagentFlash === true
    ? interpolateNested(
        'agentOptions:\n  provider: {{subagentFlashProvider}}\n  model: {{subagentFlashModel}}\npersona: |-\n  {{flashPersona}}',
        { subagentFlashProvider: provider, subagentFlashModel: model, flashPersona },
      )
    : ''
  const bootstrap = typeof params.bootstrapMaxTokens === 'number' && params.bootstrapMaxTokens > 0
    ? `bootstrapMaxTokens: ${params.bootstrapMaxTokens}`
    : ''
  return {
    USE_PTC_MODE: params.usePtcMode === true ? 'true' : 'false',
    BOOTSTRAP_MAX_TOKENS: bootstrap,
    FLASH_PERSONA: JSON.stringify(flashPersona).slice(1, -1),
    SUBAGENT_FLASH: subagentFlashBlock,
  }
}

/** 预设 params + runtime → 组合 token 渲染(便捷入口)。 */
export function resolvePresetTokens(spec: PresetSpec, runtime: Record<string, unknown>): Record<string, string> {
  return renderEngineTokens(resolvePresetParams(spec, runtime))
}

/** 按参数文件的 modules 清单从引擎模块库装配组合文本。 */
function assembleModules(spec: PresetSpec, library: string): string {
  const parts: string[] = []
  for (const name of spec.modules ?? []) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`preset ${spec.id}: modules must be non-empty strings`)
    }
    try {
      parts.push(readFileSync(join(library, `${name}.yml`), 'utf8'))
    } catch (error) {
      throw new Error(`preset ${spec.id}: module ${name} not found in engine library: ${String((error as Error).message ?? error)}`)
    }
  }
  return parts.join('\n')
}

/**
 * 加载预设声明的组合:
 *   1. `modules:` 清单 → 引擎模块库按序装配(最终形态);
 *   2. 兼容 `composition:` 内联文本或组合清单名。
 */
export function loadCompositionText(spec: PresetSpec): string {
  const library = join(packageEngineDir(), 'compositions', 'library')
  if (Array.isArray(spec.modules)) return assembleModules(spec, library)
  const name = typeof spec.composition === 'string' ? spec.composition : ''
  if (name.includes('\n')) return name
  if (name.length > 0) {
    const file = join(dirname(library), `${name}.yml`)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      throw new Error(`preset ${spec.id}: engine composition ${name} not found (${file}): ${String((error as Error).message ?? error)}`)
    }
    return raw
  }
  throw new Error(`preset ${spec.id}: no modules list and no composition declared`)
}

/**
 * 文本 token 替换:
 *   - token 独立成行时,替换块按该行缩进前缀(用于 line/block);
 *   - token 内联时直接替换(用于布尔/字符串标量)。
 */
export function renderTemplateVariables(raw: string, variables: Record<string, string>): string {
  return raw.replace(/__([A-Z0-9_]+)__/g, (whole: string, key: string, offset: number): string => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) return whole
    const value = variables[key]!
    if (value === '') return ''
    const lineStart = raw.lastIndexOf('\n', offset) + 1
    const lineEndRaw = raw.indexOf('\n', offset)
    const lineEnd = lineEndRaw < 0 ? raw.length : lineEndRaw
    const prefix = raw.slice(lineStart, offset)
    const rest = raw.slice(offset + whole.length, lineEnd)
    if (prefix.trim() === '' && rest.trim() === '') {
      // token 前的缩进仍保留在原文中,首行不再叠加;后续行按该缩进对齐。
      return value.split('\n').map((line, at) => (at === 0 ? line : (line.length > 0 ? prefix + line : ''))).join('\n')
    }
    return value
  })
}

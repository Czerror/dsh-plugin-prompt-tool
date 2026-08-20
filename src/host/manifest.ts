/**
 * manifest — 预设模板单一参数 YAML(preset.yml)的加载与引擎参数解析。
 *
 * 一个预设 = 一个 preset.yml:
 *   - modules/params/content/meta 全部是直读参数,无模板语法;
 *   - 默认提示词配置由引擎按 params 生成(见 write-preset),promptConfigs 仅为可选覆盖;
 *   - 组合模块中的 __TOKEN__ 由引擎内部 renderEngineTokens 按 params 生成,
 *     不再暴露到参数文件。
 * 本模块负责参数归一化与引擎 token 渲染;所有 anchored 专属行为都在引擎内部。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pair, Scalar, parse as parseYaml, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { DEFAULT_USER_PRESETS_DIR } from './paths.ts'

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
  /** 可选:引擎组合模块行参数覆盖(行级 map config 浅合并,preset 优先)。 */
  moduleConfigs?: Record<string, Record<string, unknown>>
  legacyCleanup?: string[]
  upstream?: Record<string, unknown>
}

/** 包根 preset/ 目录(配置/模板文件夹):兼容源码运行(src/host)与打包运行(lib/)。 */
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
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`preset ${join(dir, 'preset.yml')} is not a YAML map`)
  }
  // 官方用户预设格式：preset.yml 仅元数据（name/description/order），id 回退目录名。
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    parsed.id = basename(dir)
  }
  return parsed as PresetSpec
}

/** 读取预设模板内容资产(presetText / agentsText);模板缺失时静默降级。
 *  模板目录按 resolvePresetDir 解析（用户自定义预设优先，包内模板回退）。 */
export function loadPresetContent(template = 'anchored'): { presetText: string; agentsText: string } {
  try {
    const spec = loadPresetSpec(resolvePresetDir(template))
    return {
      presetText: typeof spec.content?.presetText === 'string' ? spec.content.presetText : '',
      agentsText: typeof spec.content?.agentsText === 'string' ? spec.content.agentsText : '',
    }
  } catch {
    return { presetText: '', agentsText: '' }
  }
}

export const asString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return fallback
  return String(value)
}

/** 可用预设清单（preset/ 下含 preset.yml 的目录）：供 UI 预设切换器展示。 */
/** 用户自定义预设目录（~/.dsh/presets；导入的预设放这里，插件更新不丢失）。 */
export function userPresetsDir(): string {
  return DEFAULT_USER_PRESETS_DIR
}

/** 在指定扫描目录内按 template 定位预设目录：目录名精确匹配优先，preset.yml 的 id 匹配兜底。 */
function findPresetDir(scanDir: string, template: string): string | undefined {
  const exact = join(scanDir, template)
  if (existsSync(join(exact, 'preset.yml'))) return exact
  try {
    for (const entry of readdirSync(scanDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(scanDir, entry.name)
      try {
        if (loadPresetSpec(dir).id === template) return dir
      } catch {
        // 目录无有效 preset.yml，跳过
      }
    }
  } catch {
    // 扫描目录不可读
  }
  return undefined
}

/**
 * 解析预设模板目录：用户自定义优先，包内模板回退。
 * 目录名与 preset.yml id 双匹配（UI 切换值=目录名；旧 settings 存量值=id 也兼容）。
 */
export function resolvePresetDir(template: string): string {
  const found = findPresetDir(userPresetsDir(), template) ?? findPresetDir(packagePresetDir(), template)
  return found ?? join(packagePresetDir(), template)
}

/** 可用预设清单（包内 preset/ + 用户 ~/.dsh/presets，用户同名覆盖）。 */
export function listPresets(): Array<{ id: string; name: string }> {
  const scan = (dir: string): Array<{ id: string; name: string }> => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          try {
            const spec = loadPresetSpec(join(dir, entry.name))
            // 切换值用目录名（与 resolvePresetDir 路径一致）；name 保持 spec.name 契约。
            return [{ id: entry.name, name: spec.name }]
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }
  const byId = new Map<string, { id: string; name: string }>()
  for (const preset of scan(packagePresetDir())) byId.set(preset.id, preset)
  for (const preset of scan(userPresetsDir())) byId.set(preset.id, preset)
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** 从导入的 preset.yml 文本解析预设 id（非法/缺失回退目录名）。 */
export function parseImportedPresetId(presetYaml: string, fallback: string): string {
  try {
    const parsed = parseYaml(presetYaml, { logLevel: 'silent' }) as { id?: unknown } | null
    return typeof parsed?.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(parsed.id) ? parsed.id : fallback
  } catch {
    return fallback
  }
}

/** on/off 等字面开关归一化为布尔。 */
export function normalizeParam(value: unknown): unknown {
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
  for (const [key, value] of Object.entries(spec.params ?? {})) {
    params[key] = normalizeParam(value)
  }
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

/** 逗号分隔 / YAML flow 数组 / 空格分隔的字符串列表 → 字符串数组。 */
function parseListParam(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter((item) => item.length > 0)
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (trimmed.length === 0) return []
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
  return inner.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

/**
 * 引擎内部 token 渲染:把直读参数变成组合模块里的 __TOKEN__ 值。
 * anchored 的全部组合行为(usePtcMode/bootstrapMaxTokens/模型路由与委派完整自定义)
 * 在这里完成参数化,用户参数文件不需要任何模板语法。
 * 模型路由/委派参数统一扁平键（modelProvider/toolFilterAllow/maxDepth 等），
 * 与官方 AgentOptions{provider,model} / toolFilter{allow,deny} / maxDepth 对齐。
 */
export function renderEngineTokens(params: Record<string, unknown>): Record<string, string> {
  const fastModelPersona = asString(params.fastModelPersona)
  const provider = asString(params.modelProvider, '')
  const model = asString(params.modelName, '')
  // 模型路由与委派完整自定义（官方 tool-subagent Config 参数化，主对话与子代理通用）：
  //   modelProvider/modelName → agentOptions{provider,model}（固定模型路由）；
  //   persona → persona（per-child shadow，显式优先；固定路由时回退
  //     fastModelPersona；两者都缺省 = 不渲染，子代理继承主会话 persona，官方行为）；
  //   toolFilterAllow/Deny → toolFilter{allow,deny}（委派工具集白/黑名单）；
  //   maxDepth → maxDepth（0 禁止委派 / provider-managed / 正整数）。
  // 任一字段非空即渲染对应行，全部缺省 = 官方默认（继承主会话）。
  const subagentPersona = asString(params.persona)
    || (provider.length > 0 && model.length > 0 ? fastModelPersona : '')
  const toolFilterAllow = parseListParam(params.toolFilterAllow)
  const toolFilterDeny = parseListParam(params.toolFilterDeny)
  const rawMaxDepth = params.maxDepth
  const subagentMaxDepth = rawMaxDepth === 'provider-managed'
    ? 'provider-managed'
    : Number.isSafeInteger(rawMaxDepth) && (rawMaxDepth as number) >= 0
      ? String(rawMaxDepth)
      : ''
  const subagentLines: string[] = []
  if (provider.length > 0 && model.length > 0) {
    subagentLines.push('agentOptions:', `  provider: ${provider}`, `  model: ${model}`)
  }
  if (subagentPersona.length > 0) {
    subagentLines.push(interpolateNested('persona: |-\n  {{subagentPersona}}', { subagentPersona }))
  }
  if (toolFilterAllow.length > 0 || toolFilterDeny.length > 0) {
    subagentLines.push('toolFilter:')
    if (toolFilterAllow.length > 0) subagentLines.push(`  allow: [${toolFilterAllow.join(', ')}]`)
    if (toolFilterDeny.length > 0) subagentLines.push(`  deny: [${toolFilterDeny.join(', ')}]`)
  }
  if (subagentMaxDepth.length > 0) subagentLines.push(`maxDepth: ${subagentMaxDepth}`)
  const subagentConfigBlock = subagentLines.join('\n')
  const bootstrap = typeof params.bootstrapMaxTokens === 'number' && params.bootstrapMaxTokens > 0
    ? `bootstrapMaxTokens: ${params.bootstrapMaxTokens}`
    : ''
  // 官方 minimal 的 str-replace-editor 默认 maxOutputChars=16000；
  // params.strReplaceEditorMaxOutputChars 可调（token 默认渲染官方值）。
  const editorMaxOutputChars = typeof params.strReplaceEditorMaxOutputChars === 'number'
    && Number.isSafeInteger(params.strReplaceEditorMaxOutputChars)
    && params.strReplaceEditorMaxOutputChars > 0
    ? String(params.strReplaceEditorMaxOutputChars)
    : '16000'
  return {
    USE_PTC_MODE: params.usePtcMode === true ? 'true' : 'false',
    BOOTSTRAP_MAX_TOKENS: bootstrap,
    FAST_MODEL_PERSONA: JSON.stringify(fastModelPersona).slice(1, -1),
    SUBAGENT_CONFIG: subagentConfigBlock,
    // 引擎默认与 context-gate 的 DEFAULT_ALLOW_KINDS 一致（单一默认源）；
    // 需要放行更多 kind 的预设（anchored）在 preset.yml 显式声明 allowKinds。
    // allowKinds 未声明 = 不写行 → context-gate 走官方 pre-step 行为（不过滤）；
    // 显式声明（anchored）才启用白名单门控。兼容数组与字符串写法。
    ALLOW_KINDS: params.allowKinds === undefined
      ? ''
      : Array.isArray(params.allowKinds)
        ? `[${params.allowKinds.map((item) => String(item)).join(', ')}]`
        : asString(params.allowKinds),
    STR_REPLACE_EDITOR_MAX_OUTPUT_CHARS: editorMaxOutputChars,
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
/**
 * 行级 config 合并(moduleConfigs):仅支持 map 型 config 浅合并;
 * 数组型 config(如 compaction)与未声明模块原样保留。
 * 未声明 moduleConfigs 时返回原文(零开销);parseDocument 往返保留注释与 __TOKEN__。
 */
export function applyModuleConfigs(raw: string, configs: Record<string, Record<string, unknown>> | undefined): string {
  if (configs === undefined || Object.keys(configs).length === 0) return raw
  const doc = parseDocument(raw, { logLevel: 'silent' })
  if (!(doc.contents instanceof YAMLSeq)) return raw
  const rows = doc.contents
  let changed = false
  for (const item of rows.items) {
    if (!(item instanceof YAMLMap)) continue
    const idNode = item.get('id', true)
    const id = idNode !== null && typeof idNode === 'object' && 'value' in idNode ? String(idNode.value) : undefined
    if (id === undefined || !Object.prototype.hasOwnProperty.call(configs, id)) continue
    const existingConfig = item.get('config', true)
    let configNode: YAMLMap
    if (existingConfig instanceof YAMLMap) {
      configNode = existingConfig
    } else if (existingConfig === null || existingConfig === undefined) {
      // 行无 config 时按 moduleConfigs 声明创建（官方行如 skill-filesystem 只有 name）。
      configNode = new YAMLMap()
      // Parsed 行节点的 set 约束 key/value 为 ParsedNode；新建节点运行时合法，
      // 类型断言绕过 Parsed 泛型（构造节点无 range 元数据）。
      item.items.push(new Pair(new Scalar('config'), configNode) as never)
      changed = true
    } else {
      continue
    }
    for (const [key, value] of Object.entries(configs[id]!)) {
      configNode.set(key, value)
    }
    changed = true
  }
  return changed ? doc.toString() : raw
}

/**
 * 加载预设声明的组合(原始 token 文本,未渲染)。
 *  - `modules:` 清单 → 引擎模块库按序装配;
 *  - `composition: ./xxx.yml` → 预设模板目录内组合文件(官方预设直用);
 *  - `composition:` 内联文本或组合清单名。
 */
export function loadCompositionText(spec: PresetSpec, templateDir?: string): string {
  const library = join(packageEngineDir(), 'compositions', 'library')
  let raw: string
  if (Array.isArray(spec.modules)) raw = assembleModules(spec, library)
  else {
    const name = typeof spec.composition === 'string' ? spec.composition : ''
    if (name.includes('\n')) raw = name
    else if (name.startsWith('./')) {
      if (templateDir === undefined) {
        throw new Error(`preset ${spec.id}: composition relative path needs a templateDir (${JSON.stringify(name)})`)
      }
      try {
        raw = readFileSync(join(templateDir, name.slice(2)), 'utf8')
      } catch (error) {
        throw new Error(`preset ${spec.id}: composition file not found (${join(templateDir, name.slice(2))}): ${String((error as Error).message ?? error)}`)
      }
    }
    else if (name.length > 0) {
      const file = join(dirname(library), `${name}.yml`)
      try {
        raw = readFileSync(file, 'utf8')
      } catch (error) {
        throw new Error(`preset ${spec.id}: engine composition ${name} not found (${file}): ${String((error as Error).message ?? error)}`)
      }
    } else if (templateDir !== undefined) {
      // 官方用户预设约定：preset.yml 仅元数据时，组合文件为同目录 agent.cordis.yml。
      try {
        raw = readFileSync(join(templateDir, 'agent.cordis.yml'), 'utf8')
      } catch (error) {
        throw new Error(`preset ${spec.id}: no modules/composition and no agent.cordis.yml in template dir (${templateDir}): ${String((error as Error).message ?? error)}`)
      }
    } else {
      throw new Error(`preset ${spec.id}: no modules list and no composition declared`)
    }
  }
  return raw
}

/**
 * 预设组合渲染完整链路:token 渲染 → moduleConfigs 行级合并。
 * 合并必须发生在 token 渲染之后(独立行 token 在渲染前是非法 YAML,
 * 如 __SUBAGENT_CONFIG__ / __BOOTSTRAP_MAX_TOKENS__)。
 */
export function renderComposition(spec: PresetSpec, runtime: Record<string, unknown>, templateDir?: string): string {
  const tokens = resolvePresetTokens(spec, runtime)
  return applyModuleConfigs(renderTemplateVariables(loadCompositionText(spec, templateDir), tokens), spec.moduleConfigs)
}

/** 组合文本基础校验（模板无关）：无未解析 token，且必须是 YAML 数组。 */
export function assertCompositionArray(raw: string, spec: PresetSpec): unknown[] {
  const unresolved = raw.match(/__[A-Z0-9_]+__/g)
  if (unresolved !== null) throw new Error(`generated agent.cordis.yml has unresolved variables: ${unresolved.join(', ')}`)
  const parsed = parseYaml(raw, { logLevel: 'silent' })
  if (!Array.isArray(parsed)) throw new Error(`generated agent.cordis.yml is not a YAML array (preset ${spec.id})`)
  return parsed
}

/**
 * 文本 token 替换:
 *   - token 独立成行时,替换块按该行缩进前缀(用于 line/block);
 *   - token 内联时直接替换(用于布尔/字符串标量)。
 */
export function renderTemplateVariables(raw: string, variables: Record<string, string>): string {
  // 空值 token 独立成行（含 key: 前缀，如 `allowKinds: __ALLOW_KINDS__`）时先删除
  // 整行，避免 YAML 空值残留（allowKinds 未声明时不得产生 `allowKinds:` null）。
  let text = raw.replace(/^[ \t]*(?:[A-Za-z0-9_.-]+:[ \t]*)?__([A-Z0-9_]+)__[ \t]*\r?\n/gm, (whole: string, key: string): string =>
    Object.prototype.hasOwnProperty.call(variables, key) && variables[key] === '' ? '' : whole)
  return text.replace(/__([A-Z0-9_]+)__/g, (whole: string, key: string, offset: number): string => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) return whole
    const value = variables[key]!
    if (value === '') return ''
    // 注意：偏移量相对当前文本（空值行已删），行定位必须用同一文本。
    const lineStart = text.lastIndexOf('\n', offset) + 1
    const lineEndRaw = text.indexOf('\n', offset)
    const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw
    const prefix = text.slice(lineStart, offset)
    const rest = text.slice(offset + whole.length, lineEnd)
    if (prefix.trim() === '' && rest.trim() === '') {
      // token 前的缩进仍保留在原文中,首行不再叠加;后续行按该缩进对齐。
      return value.split('\n').map((line, at) => (at === 0 ? line : (line.length > 0 ? prefix + line : ''))).join('\n')
    }
    return value
  })
}

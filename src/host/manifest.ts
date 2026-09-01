/**
 * manifest — 预设模板单一参数 YAML(preset.yml)的加载与引擎参数解析。
 *
 * 一个预设 = 一个 preset.yml:
 *   - modules/params/content/meta 全部是直读参数,无模板语法;
 *   - 默认提示词配置由引擎按 params 生成(见 write-preset),promptConfigs 仅为可选覆盖;
 *   - 组合模块的行级 config 由参数桥 buildModuleConfigsFromParams 按 params
 *     构造对象合并（取代旧 __TOKEN__ 文本渲染，无占位符、无文本往返），
 *     params（UI/基础层）优先于 moduleConfigs 行级直写（旧作者锁定语义已移除）。
 * 本模块负责参数归一化与引擎模块配置装配;所有 anchored 专属行为都在引擎内部。
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync, writeFileSync, cpSync, renameSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pair, Scalar, parse as parseYaml, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { DEFAULT_PRESET_DIR, DSH_HOME } from './paths.ts'

export interface PresetSpec {
  id: string
  name: string
  /** 预设说明（官方用户预设格式元数据；列表展示用，可选）。 */
  description?: string
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
  /** 顶层模型段（主对话，官方 agent-default-model 同构）：provider/name/reasoningEffort/temperature/maxTokens。 */
  model?: Record<string, unknown>
  /** 顶层子代理模型段：provider/name/reasoningEffort/temperature/maxTokens。 */
  subagentModel?: Record<string, unknown>
  /** 预设级模板变量（{{key}} 插值源；与引擎行为参数 params 分离，顶层 variables 段）。 */
  variables?: Record<string, string>
  /** 自定义工具定义（tool-config-engine 渲染进 custom-tools/ 后运行时注册）。 */
  customTools?: unknown[]
  /** 内置模型工具面（character/worldBook/sessionVar 三组；缺省全开，与旧行为兼容）。 */
  builtinTools?: Record<string, unknown>
  /** 模板变量插值开关（缺省 true = 启用；false = 停用，writePreset 不生成变量文件）。 */
  variablesEnabled?: boolean
  /** 可选:模板自定义提示词配置覆盖(纯数据,不使用模板语法)。 */
  promptConfigs?: unknown[]
  /** 可选:引擎组合模块行参数直写(行级 map config 浅合并;参数桥未覆盖的键生效,参数桥优先)。 */
  moduleConfigs?: Record<string, Record<string, unknown>>
  /** 世界书（独立存储段，不进 promptConfigs）：injectMode + 条目。 */
  worldBook?: {
    injectMode?: 'full' | 'keyword'
    entries: Array<Record<string, unknown>>
  }
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

/** 内置模型工具面归一结果（三组独立开关）。 */
export interface BuiltinToolsFace {
  character: boolean
  worldBook: boolean
  sessionVar: boolean
}

/**
 * preset.yml 顶层 builtinTools 段归一：缺段/坏值回落全开（与旧版全局注册行为兼容，
 * 已物化用户预设无段时不丢工具）；显式 false 才关闭对应组。
 */
export function resolveBuiltinTools(spec: PresetSpec | undefined): BuiltinToolsFace {
  const raw = spec?.builtinTools
  const face = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  return {
    character: face.character !== false,
    worldBook: face.worldBook !== false,
    sessionVar: face.sessionVar !== false,
  }
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

/**
 * preset.yml 读缓存：按 mtime+size 签名失效。load()/describe/param-overrides 等
 * 每次请求读盘解析，加缓存后同一文件只解析一次；写盘路径（savePresetParams /
 * withPresetDoc）与外部编辑（stat 签名变化）都会正确失效。
 */
const presetSpecCache = new Map<string, { mtimeMs: number; size: number; spec: PresetSpec }>()

/** 写盘后失效缓存（调用方在写完 preset.yml 后调用；不调用也安全——stat 签名兜底）。 */
export function invalidatePresetSpec(dir: string): void {
  presetSpecCache.delete(join(dir, 'preset.yml'))
}

/** 加载某个预设模板的单一参数文件 preset/<name>/preset.yml。 */
export function loadPresetSpec(dir: string): PresetSpec {
  const file = join(dir, 'preset.yml')
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(file)
  } catch {
    // 兜底路径（resolvePresetDir 未命中时 join(packagePresetDir, template) 可能不存在）
    // 不让裸 ENOENT 冒给调用方；findPresetDir 等扫描方 catch 任意错误不受影响。
    throw new Error(`preset.yml not found in ${dir}（预设模板不存在或目录不完整）`)
  }
  const cached = presetSpecCache.get(file)
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.spec
  const raw = readFileSync(file, 'utf8')
  let parsed: Partial<PresetSpec> | null
  try {
    parsed = parseYaml(raw, { logLevel: 'silent' }) as Partial<PresetSpec> | null
  } catch (error) {
    throw new Error(`preset ${file} YAML 解析失败: ${String((error as Error).message ?? error)}`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`preset ${join(dir, 'preset.yml')} is not a YAML map`)
  }
  // 官方用户预设格式：preset.yml 仅元数据（name/description/order），id 回退目录名。
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    parsed.id = basename(dir)
  }
  // 顶层模型段（model / subagentModel，官方 agent-default-model 同构）→ 展平进
  // params 扁平键（消费方统一读 params.modelProvider 等）。双读：段优先，扁平键兜底。
  // 映射来源 = MODEL_SEGMENT_MAP（与 savePresetParams 迁移共用，单一来源）。
  const flattenModelGroup = (source: unknown, mapping: Record<string, string>): void => {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return
    if (parsed.params === null || typeof parsed.params !== 'object' || Array.isArray(parsed.params)) {
      parsed.params = {}
    }
    for (const [segmentKey, flatKey] of Object.entries(mapping)) {
      const value = (source as Record<string, unknown>)[segmentKey]
      if (value !== undefined) parsed.params[flatKey] = value
    }
  }
  const flattenMapping = (segmentName: 'model' | 'subagentModel'): Record<string, string> => {
    const mapping: Record<string, string> = {}
    for (const [flatKey, [segment, segmentKey]] of Object.entries(MODEL_SEGMENT_MAP)) {
      if (segment === segmentName) mapping[segmentKey] = flatKey
    }
    return mapping
  }
  flattenModelGroup(parsed.model, flattenMapping('model'))
  flattenModelGroup(parsed.subagentModel, flattenMapping('subagentModel'))
  presetSpecCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, spec: parsed as PresetSpec })
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

/**
 * 顶层模型段 ↔ 扁平参数键双向映射（单一来源）。
 * loadPresetSpec 展平（段 → 扁平键）与 savePresetParams 迁移（扁平键 → 段）
 * 共用本常量，杜绝两处字面量漂移。段结构 = 官方 agent-default-model 同构。
 */
export const MODEL_SEGMENT_MAP: Record<string, [string, string]> = {
  modelProvider: ['model', 'provider'],
  modelName: ['model', 'name'],
  modelReasoningEffort: ['model', 'reasoningEffort'],
  modelTemperature: ['model', 'temperature'],
  modelMaxTokens: ['model', 'maxTokens'],
  subagentModelProvider: ['subagentModel', 'provider'],
  subagentModelName: ['subagentModel', 'name'],
  subagentReasoningEffort: ['subagentModel', 'reasoningEffort'],
  subagentTemperature: ['subagentModel', 'temperature'],
  subagentMaxTokens: ['subagentModel', 'maxTokens'],
}

/** 预设根：官方 USER_PRESET_DIR（~/.dsh/.agent-presets），导入/新建/种子化的预设都放这里。 */
export function userPresetsDir(): string {
  return DEFAULT_PRESET_DIR
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

/** 预设目录是否含可渲染组合源：modules 清单 / composition 声明 / 同目录
 *  agent.cordis.yml（官方用户预设约定）三者其一。旧版种子副本可能三者皆无
 *  （仅元数据 + 本地 .mjs），物化必失败——用于回退判定与 UI 可用性探测。 */
export function isRenderablePresetDir(dir: string): boolean {
  try {
    const spec = loadPresetSpec(dir)
    if (Array.isArray(spec.modules)) return true
    if (typeof spec.composition === 'string' && spec.composition.length > 0) return true
  } catch {
    return false
  }
  return existsSync(join(dir, 'agent.cordis.yml'))
}

/**
 * 解析可渲染预设目录（writePreset 专用）：用户副本优先；用户副本不可渲染
 * 且包内存在同名可渲染模板时回退包内——修复旧版种子副本（ensurePresetSeed
 * 幂等跳过导致模板升级无法到达用户目录）遮蔽包内新版模板的死路。
 * 返回 fallback=true 表示发生了包内回退，调用方负责 warn 与参数源升级判定。
 */
export function resolveRenderablePresetDir(template: string): { dir: string; fallback: boolean } {
  const userDir = findPresetDir(userPresetsDir(), template)
  if (userDir === undefined) return { dir: resolvePresetDir(template), fallback: false }
  if (isRenderablePresetDir(userDir)) return { dir: userDir, fallback: false }
  const builtin = findPresetDir(packagePresetDir(), template)
  if (builtin !== undefined && isRenderablePresetDir(builtin)) return { dir: builtin, fallback: true }
  return { dir: userDir, fallback: false }
}

/** 可用预设清单：全部来自预设根 ~/.dsh/.agent-presets（官方预设目录，含 agent.cordis.yml
 *  即被宿主挂载；点前缀目录与无 preset.yml 的官方目录跳过，不占本插件列表）。 */
export function listPresets(): Array<{ id: string; name: string; user: boolean; renderable: boolean; description?: string; meta?: Record<string, unknown> }> {
  const scan = (dir: string): Array<{ id: string; name: string; user: boolean; renderable: boolean; description?: string; meta?: Record<string, unknown> }> => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        // 旧容器 id 兼容快照仅供历史会话 resolve，不参与普通预设选择/重建。
        .filter((entry) => entry.name !== 'prompt-tool')
        .flatMap((entry) => {
          try {
            const spec = loadPresetSpec(join(dir, entry.name))
            if (typeof spec.id !== 'string' || spec.id.length === 0) return []
            // 切换值用目录名（与 resolvePresetDir 路径一致）；name 保持 spec.name 契约。
            // 可渲染性：用户副本缺组合源时，包内同名模板可回退渲染（writePreset
            // 回退链）也算可用；两者皆无 = 真不可用，UI 灰显并给出原因。
            return [{
              id: entry.name,
              name: spec.name,
              user: true,
              renderable: isRenderablePresetDir(join(dir, entry.name))
                || isRenderablePresetDir(join(packagePresetDir(), entry.name)),
              ...(typeof spec.description === 'string' && spec.description.length > 0 ? { description: spec.description } : {}),
              ...(spec.meta !== undefined && spec.meta !== null ? { meta: spec.meta } : {}),
            }]
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }
  const byId = new Map<string, { id: string; name: string; user: boolean; renderable: boolean }>()
  for (const preset of scan(userPresetsDir())) byId.set(preset.id, preset)
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** 插件目录模板清单（「新建」选择器与首次种子化数据源；不直接出现在预设列表）。 */
export function listBuiltinTemplates(): Array<{ id: string; name: string }> {
  try {
    return readdirSync(packagePresetDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      // 自定义预设走「新建」顶部专用入口（autoSuffix），不重复出现在普通模板列表。
      .filter((entry) => entry.name !== 'custom')
      .flatMap((entry) => {
        try {
          const spec = loadPresetSpec(join(packagePresetDir(), entry.name))
          return [{ id: entry.name, name: spec.name }]
        } catch {
          return []
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    return []
  }
}

/** 插件状态文件（DSH_HOME 下，预设根之外）：与用户资产解耦，删除/备份/迁移预设根不影响状态。
 *  原子写（tmp+rename），避免半写文件。 */
export function stateFilePath(): string {
  return join(DSH_HOME, '.prompt-tool-state.json')
}

export interface PromptToolState {
  seeded?: boolean
  paramsMigrated?: boolean
  /** 旧容器 id 兼容快照已处理；删除后不再自动复活。 */
  legacyAliasHandled?: boolean
}

/** 读插件状态；文件缺失/损坏返回空对象（按未标记处理，触发首次动作）。 */
export function readPluginState(): PromptToolState {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed as PromptToolState : {}
  } catch {
    return {}
  }
}

/** 原子写插件状态（tmp+rename）。 */
export function writePluginState(state: PromptToolState): void {
  const file = stateFilePath()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 首次启动种子化：把插件目录全部内置模板复制到预设根（state.seeded 后不再自动补）。
 *  用户删除的预设不会自动复活；升级新增的模板用「新建」按需复制。
 *  兼容旧版预设根内 .pt-seeded 标记：存在即视为已种子化，并迁入状态文件后删除。 */
export function ensurePresetSeed(): { created: string[] } {
  const root = userPresetsDir()
  const legacyMark = join(root, '.pt-seeded')
  const state = readPluginState()
  // 旧标记迁移：.pt-seeded 只迁移进状态文件，不再作为「已种子化即永不补建」的闸门——
  // 用户/迁移误删某个内置预设目录后，seeded=true 会让它永久消失；补建幂等
  // （existsSync 跳过），每次都补齐缺失项无副作用。
  if (existsSync(legacyMark)) {
    try {
      writePluginState({ ...state, seeded: true })
      rmSync(legacyMark, { force: true })
    } catch {
      // 旧标记迁移失败不阻断（下次启动重试）。
    }
  }
  const created: string[] = []
  try {
    mkdirSync(root, { recursive: true })
    for (const entry of readdirSync(packagePresetDir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const target = join(root, entry.name)
      if (existsSync(target)) continue
      cpSync(join(packagePresetDir(), entry.name), target, { recursive: true })
      created.push(entry.name)
    }
    writePluginState({ ...readPluginState(), seeded: true })
  } catch {
    // 种子化失败（目录不可写等）不阻断启动，用户仍可经 UI 新建/导入。
  }
  return { created }
}

/** 从插件目录复制内置预设到预设根（新建/还原）。
 *  autoSuffix=true（自定义预设入口）时同名自动递增（custom → custom-2 → …）；否则同名拒绝。 */
export function cloneBuiltinPreset(id: string, autoSuffix = false): { ok: true; id: string } | { ok: false; message: string } {
  if (typeof id !== 'string' || id.length === 0 || id === '.' || id === '..'
    || id.includes('/') || id.includes('\\')) {
    return { ok: false, message: `非法预设 id：${id}` }
  }
  const builtin = findPresetDir(packagePresetDir(), id)
  if (builtin === undefined) {
    return { ok: false, message: `预设 ${id} 不是包内置预设` }
  }
  let targetId = id
  let target = join(userPresetsDir(), targetId)
  if (existsSync(target)) {
    if (!autoSuffix) {
      return { ok: false, message: `用户目录已存在同名预设 ${id}，请先删除再新建` }
    }
    for (let suffix = 2; ; suffix++) {
      targetId = `${id}-${suffix}`
      target = join(userPresetsDir(), targetId)
      if (!existsSync(target)) break
    }
  }
  try {
    mkdirSync(userPresetsDir(), { recursive: true })
    cpSync(builtin, target, { recursive: true, force: true })
    return { ok: true, id: targetId }
  } catch (error) {
    return { ok: false, message: `新建预设失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 复制用户预设目录为新预设（id 自动递增：<id>-copy / <id>-copy-2 / …）。
 *  复制的是用户目录完整副本（preset.yml / agent.cordis.yml / prompt-configs /
 *  内容资产 / 覆盖文件），与「从内置模板新建」互补：后者还原模板，前者备份现状。 */
export function duplicateUserPreset(id: string, presetRoot = userPresetsDir()): { ok: true; id: string } | { ok: false; message: string } {
  if (typeof id !== 'string' || id.length === 0 || id === '.' || id === '..'
    || id.includes('/') || id.includes('\\')) {
    return { ok: false, message: `非法预设 id：${id}` }
  }
  const root = resolve(presetRoot)
  const source = resolve(join(root, id))
  const rootResolved = resolve(root)
  if (source !== rootResolved && !source.startsWith(rootResolved + sep)) {
    return { ok: false, message: `预设路径越界：${id}` }
  }
  if (!existsSync(source)) {
    return { ok: false, message: `预设 ${id} 不存在` }
  }
  let targetId = `${id}-copy`
  let target = join(root, targetId)
  for (let suffix = 2; existsSync(target); suffix++) {
    targetId = `${id}-copy${suffix}`
    target = join(root, targetId)
  }
  try {
    mkdirSync(root, { recursive: true })
    cpSync(source, target, { recursive: true, force: true })
    return { ok: true, id: targetId }
  } catch (error) {
    return { ok: false, message: `复制预设失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 在系统文件管理器中打开预设目录（尽力而为：无桌面环境时打开失败也返回路径供 UI 展示）。 */
export function openPresetLocation(id: string, presetRoot = userPresetsDir()): { ok: true; path: string } | { ok: false; message: string; path: string } {
  // 普通预设 id（裸目录名）或角色卡库子路径（/.characters/<cardId>）两种形态。
  const isBareId = typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..'
    && !id.includes('/') && !id.includes('\\')
  const isCardPath = typeof id === 'string' && /^\/\.[a-zA-Z0-9_-]+\/[^/\\]+$/.test(id)
  if (!isBareId && !isCardPath) {
    return { ok: false, message: `非法预设 id：${id}`, path: '' }
  }
  const dir = resolve(join(presetRoot, id))
  const rootResolved = resolve(presetRoot)
  if (dir !== rootResolved && !dir.startsWith(rootResolved + sep)) {
    return { ok: false, message: `预设路径越界：${id}`, path: dir }
  }
  if (!existsSync(dir)) {
    return { ok: false, message: `预设 ${id} 不存在`, path: dir }
  }
  try {
    const command = process.platform === 'win32' ? 'explorer'
      : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [dir], { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, path: dir }
  } catch (error) {
    return { ok: false, message: `打开目录失败：${error instanceof Error ? error.message : String(error)}`, path: dir }
  }
}

/** 删除 yaml 两级键；父集合缺失时不触发 deleteIn 对不存在集合的异常。 */
function deleteYamlPath(doc: ReturnType<typeof parseDocument>, path: [string, string]): void {
  if (doc.hasIn(path)) doc.deleteIn(path)
}

/** 删除扁平 params 键。 */
function deleteFlatParam(doc: ReturnType<typeof parseDocument>, key: string): void {
  deleteYamlPath(doc, ['params', key])
}

/**
 * 保存预设参数：写激活预设目录 preset.yml 的 params（merge）/ promptConfigs（整体替换）。
 * parseDocument 保留注释与未知键（preset.yml 模板含大量注释）；空值键删除（'' / []，
 * 回落模板/引擎默认；0 与 false 照常写入--语义与函数内注释、docs §3 一致）。写入后删除 prompt-tool.overrides.yml（旧参数覆盖
 * 通道残留——参数已并入 preset.yml，避免旧值覆盖新值）。
 */
export function savePresetParams(
  presetRoot: string,
  templateName: string,
  params: Record<string, unknown> | undefined,
  promptConfigs: unknown[] | undefined,
  variables?: Record<string, string>,
  variablesEnabled?: boolean,
): void {
  // 模型参数写入顶层段（model / subagentModel，官方 agent-default-model 同构）：
  // params 旧扁平键同步清理（保存即迁移）。映射 = MODEL_SEGMENT_MAP（与展平共用）。
  const file = join(presetRoot, templateName, 'preset.yml')
  if (!existsSync(file)) throw new Error(`preset ${templateName} 无 preset.yml`)
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  // 空值 = 删除键（回落模板/引擎默认）：''（字符串清空）、[]（列表清空）。
  // 其余 0/false 照常写入：stagePreUnlock 的 0 是合法档位（undefined 才回落
  // 引擎默认 1），maxPromoteSteps 0 由引擎归一为默认 4。
  if (params !== undefined) {
    for (const [key, value] of Object.entries(params)) {
      // 仅跳过 undefined/null 与空 key 名；空串/空数组照常写入——
      // 「从有值改回留空」依赖空值清掉旧键（渲染层空值跳过 = 继承模板/宿主默认）。
      if (value === undefined || value === null || key.trim().length === 0) continue
      const isEmpty = value === '' || (Array.isArray(value) && value.length === 0)
      const segment = MODEL_SEGMENT_MAP[key]
      if (segment !== undefined) {
        if (isEmpty) deleteYamlPath(doc, [segment[0], segment[1]])
        else doc.setIn([segment[0], segment[1]], value)
        deleteFlatParam(doc, key)
      } else if (isEmpty) {
        deleteFlatParam(doc, key)
      } else {
        doc.setIn(['params', key], value)
      }
    }
  }
  if (promptConfigs !== undefined) {
    // 逐条清理 variables 空 key（待编辑行），避免脏数据落盘。
    const cleaned = (promptConfigs as Array<Record<string, unknown>>).map((config) => {
      if (config === null || typeof config !== 'object' || Array.isArray(config)) return config
      const vars = config.variables
      if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) return config
      const kept = Object.fromEntries(
        Object.entries(vars as Record<string, string>).filter(([key]) => key.trim().length > 0),
      )
      const next = { ...config }
      if (Object.keys(kept).length > 0) next.variables = kept
      else delete next.variables
      return next
    })
    doc.setIn(['promptConfigs'], cleaned)
  }
  if (variables !== undefined) {
    // 预设级模板变量写顶层 variables 段（与引擎行为参数 params 分离）；
    // 旧布局（变量混在 params 内容键）同名键一并清理（保存即迁移）。
    const kept = Object.fromEntries(
      Object.entries(variables).filter(([key, value]) => key.trim().length > 0 && typeof value === 'string'),
    )
    if (Object.keys(kept).length > 0) {
      doc.setIn(['variables'], kept)
    } else {
      doc.deleteIn(['variables'])
    }
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value !== 'string') continue
      deleteFlatParam(doc, key)
    }
  }
  if (variablesEnabled !== undefined) {
    // 模板变量插值开关：true = 缺省（删除键）；false = 显式停用。
    if (variablesEnabled) {
      doc.deleteIn(['variablesEnabled'])
    } else {
      doc.setIn(['variablesEnabled'], false)
    }
  }
  atomicWriteTextFile(file, doc.toString())
  invalidatePresetSpec(join(presetRoot, templateName))
  rmSync(join(presetRoot, templateName, 'prompt-tool.overrides.yml'), { force: true })
}

/** 原子写文件（tmp + rename）：preset.yml 增量写路径防截断与半写。 */
export function atomicWriteTextFile(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** 预设文件读-改-写（parseDocument 保留注释与未知键；mutate 内 setIn/deleteIn）。
 *  角色卡库（characters）与世界书工具（world-book-tools）共用此入口，避免
 *  各自实现 parseDocument 往返。写盘走原子替换，失败保留旧文件。 */
export function withPresetDoc(presetDir: string, mutate: (doc: ReturnType<typeof parseDocument>) => void): void {
  const file = join(presetDir, 'preset.yml')
  if (!existsSync(file)) throw new Error(`${presetDir} 无 preset.yml`)
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  mutate(doc)
  atomicWriteTextFile(file, doc.toString())
  invalidatePresetSpec(presetDir)
}

/** 删除预设目录（预设根/<id>；含同名导入的 .bak-* 备份目录）。
 *  仅作用于预设根（官方 USER_PRESET_DIR），包内置模板天然不受影响；路径越界与非法 id 拒绝。
 *  删除后宿主 agent-presets 目录列表自然不再出现该预设（官方 roster 即目录列表）。 */
export function removeUserPreset(id: string, presetRoot = userPresetsDir()): { ok: true } | { ok: false; message: string } {
  if (typeof id !== 'string' || id.length === 0 || id === '.' || id === '..'
    || id.includes('/') || id.includes('\\')) {
    return { ok: false, message: `非法预设 id：${id}` }
  }
  const root = presetRoot
  const target = resolve(join(root, id))
  const rootResolved = resolve(root)
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    return { ok: false, message: `预设路径越界：${id}` }
  }
  if (existsSync(target)) {
    try {
      rmSync(target, { recursive: true, force: true })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: `删除失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { ok: false, message: `预设 ${id} 不存在（预设根 ~/.dsh/.agent-presets）` }
}

/** 从导入的 preset.yml 文本解析预设 id（非法/缺失回退目录名）。 */
export function parseImportedPresetId(presetYaml: string, fallback: string): string {
  try {
    const parsed = parseYaml(presetYaml, { logLevel: 'silent' }) as { id?: unknown } | null
    return typeof parsed?.id === 'string' && /^[a-zA-Z0-9\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff-]*$/.test(parsed.id) ? parsed.id : fallback
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
  return params
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
 * 参数桥：params 扁平键 → 引擎模块行 config 对象（取代旧 __TOKEN__ 文本渲染）。
 *
 * 原则：
 *  - 未声明的键不合并（composition 行默认 / 引擎默认生效），与旧"空值删行"语义等价；
 *  - 值类型直达（布尔/数字/数组不再字符串化再解析）；
 *  - 合并优先级：参数桥（UI/基础层）> moduleConfigs（模板/ST 行级直写）> 行默认。
 * 模型路由/委派参数统一扁平键（modelProvider/subagentModelProvider/toolFilterAllow/maxDepth 等），
 * 与官方 AgentOptions{provider,model} / toolFilter{allow,deny} / maxDepth 对齐。
 */
export function buildModuleConfigsFromParams(params: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  const merge = (module: string, cfg: Record<string, unknown>): void => {
    if (Object.keys(cfg).length === 0) return
    out[module] = { ...out[module], ...cfg }
  }

  // tool-bootstrap：首轮工具目录相位（窄化/封顶/门控/压缩恢复集/人设窄化）。
  const bootstrap: Record<string, unknown> = {}
  if (typeof params.bootstrapMaxTokens === 'number' && params.bootstrapMaxTokens > 0) {
    bootstrap.bootstrapMaxTokens = params.bootstrapMaxTokens
  }
  if (params.bootstrapTools !== undefined) bootstrap.bootstrapTools = parseListParam(params.bootstrapTools)
  if (params.promoteGate !== undefined) bootstrap.promoteGate = params.promoteGate === true
  if (params.promoteAfterFirstResponse !== undefined) {
    bootstrap.promoteAfterFirstResponse = params.promoteAfterFirstResponse === true
  }
  if (params.maxPromoteSteps !== undefined && Number.isSafeInteger(params.maxPromoteSteps)) {
    bootstrap.maxPromoteSteps = params.maxPromoteSteps
  }
  if (params.compactionTools !== undefined) bootstrap.compactionTools = parseListParam(params.compactionTools)
  if (params.personaSectionsOnly !== undefined) bootstrap.personaSectionsOnly = params.personaSectionsOnly === true
  if (params.workspaceLine !== undefined) bootstrap.workspaceLine = params.workspaceLine === true
  if (typeof params.phase1FirstCallInstruction === 'string' && params.phase1FirstCallInstruction.length > 0) {
    bootstrap.phase1FirstCallInstruction = params.phase1FirstCallInstruction
  }
  // 渐进披露（stages 模式）：阶段定义/预放/推进工具/阶段文案全部参数化。
  if (params.stages !== undefined) bootstrap.stages = params.stages
  if (params.stagePreUnlock !== undefined && Number.isSafeInteger(params.stagePreUnlock)) {
    bootstrap.stagePreUnlock = params.stagePreUnlock
  }
  if (typeof params.stageAdvanceTool === 'string' && params.stageAdvanceTool.length > 0) {
    bootstrap.stageAdvanceTool = params.stageAdvanceTool
  }
  if (typeof params.stageAdvanceDescription === 'string' && params.stageAdvanceDescription.length > 0) {
    bootstrap.stageAdvanceDescription = params.stageAdvanceDescription
  }
  if (typeof params.stageSectionTemplate === 'string' && params.stageSectionTemplate.length > 0) {
    bootstrap.stageSectionTemplate = params.stageSectionTemplate
  }
  merge('tool-bootstrap', bootstrap)

  // context-gate：注入门控（kind 白名单 / 晋升后延迟注入 / instruction-hint 转换）。
  const gate: Record<string, unknown> = {}
  if (params.allowKinds !== undefined) gate.allowKinds = parseListParam(params.allowKinds)
  if (params.messageSources !== undefined) gate.messageSources = parseListParam(params.messageSources)
  if (params.deferredSources !== undefined) gate.deferredSources = parseListParam(params.deferredSources)
  if (params.deferredGraceSteps !== undefined && Number.isSafeInteger(params.deferredGraceSteps)) {
    gate.deferredGraceSteps = params.deferredGraceSteps
  }
  if (params.instructionHint !== undefined) gate.instructionHint = params.instructionHint === true
  merge('context-gate', gate)

  // code-presentation：晋升后 Code Mode (PTC) wire 呈现（独立于目录窄化）。
  const presentation: Record<string, unknown> = {}
  if (params.usePtcMode !== undefined) presentation.usePtcMode = params.usePtcMode === true
  merge('code-presentation', presentation)

  // anchor-turn：前置锚定轮（用户首条真实消息前 prepend 合成锚定轮）。
  // 默认不写键 → 行默认（enabled 未声明 = 挂载即启用）；params 显式 false 关。
  const anchorTurn: Record<string, unknown> = {}
  if (params.anchorTurn !== undefined) anchorTurn.enabled = params.anchorTurn === true
  if (typeof params.anchorTurnText === 'string' && params.anchorTurnText.length > 0) {
    anchorTurn.text = params.anchorTurnText
  }
  merge('anchor-turn', anchorTurn)

  // deliberation-gate：轨迹深度门（首工具调用前深思 < 下限 → deny 一次）。
  const gate2: Record<string, unknown> = {}
  if (params.deliberationGate !== undefined) gate2.enabled = params.deliberationGate === true
  if (typeof params.deliberationMinChars === 'number' && params.deliberationMinChars > 0) {
    gate2.minChars = params.deliberationMinChars
  }
  if (typeof params.deliberationMaxGatesPerTurn === 'number' && params.deliberationMaxGatesPerTurn > 0) {
    gate2.maxGatesPerTurn = params.deliberationMaxGatesPerTurn
  }
  merge('deliberation-gate', gate2)

  // cot-drip：深思维持节拍（每 N 次工具结果滴入 "We…" 重申）。
  const drip: Record<string, unknown> = {}
  if (params.cotDrip !== undefined) drip.enabled = params.cotDrip === true
  if (typeof params.cotDripEvery === 'number' && params.cotDripEvery > 0) {
    drip.every = params.cotDripEvery
  }
  if (typeof params.cotDripMaxPerTurn === 'number' && params.cotDripMaxPerTurn > 0) {
    drip.maxPerTurn = params.cotDripMaxPerTurn
  }
  merge('cot-drip', drip)

  // str-replace-editor：官方 minimal 行（默认官方值 16000，params 显式覆盖）。
  const editor: Record<string, unknown> = {}
  editor.maxOutputChars = typeof params.strReplaceEditorMaxOutputChars === 'number'
    && Number.isSafeInteger(params.strReplaceEditorMaxOutputChars)
    && params.strReplaceEditorMaxOutputChars > 0
    ? params.strReplaceEditorMaxOutputChars
    : 16000
  merge('str-replace-editor', editor)

  // tool-filter：主会话常驻工具掩码（空列表 = 不过滤，不写键）。
  const filter: Record<string, unknown> = {}
  const mainAllow = parseListParam(params.toolFilterAllow)
  const mainDeny = parseListParam(params.toolFilterDeny)
  if (mainAllow.length > 0) filter.allow = mainAllow
  if (mainDeny.length > 0) filter.deny = mainDeny
  if (params.toolFilterSubagents === true) filter.includeSubagents = true
  merge('tool-filter', filter)

  // delegation 组：子代理模型路由/人设/工具集/深度（spawn 与 fork 两行同配置，
  // 由 applyModuleConfigs 的嵌套合并按子行 id 落位）。
  const subagent: Record<string, unknown> = {}
  const provider = asString(params.subagentModelProvider, '')
  const model = asString(params.subagentModelName, '')
  if (provider.length > 0 && model.length > 0) subagent.agentOptions = { provider, model }
  const subAllow = parseListParam(params.toolFilterAllow)
  const subDeny = parseListParam(params.toolFilterDeny)
  if (subAllow.length > 0 || subDeny.length > 0) {
    subagent.toolFilter = {
      ...(subAllow.length > 0 ? { allow: subAllow } : {}),
      ...(subDeny.length > 0 ? { deny: subDeny } : {}),
    }
  }
  const rawMaxDepth = params.maxDepth
  if (rawMaxDepth === 'provider-managed') subagent.maxDepth = 'provider-managed'
  else if (Number.isSafeInteger(rawMaxDepth) && (rawMaxDepth as number) >= 0) subagent.maxDepth = rawMaxDepth
  if (Object.keys(subagent).length > 0) {
    out['tool-subagent'] = subagent
    out['tool-subagent-fork'] = subagent
  }
  return out
}

/** 按参数文件的 modules 清单从引擎模块库装配组合文本。 */
/** 空模块清单兜底骨架（自定义预设空白起点：模块集与 minimal 一致，参数/配置全空）。 */
const FALLBACK_MODULES = ['official-persistent-shell', 'bootstrap-filesystem',
  'context-gate', 'tool-bootstrap', 'code-presentation', 'prompt-config-engine',
  'run-code-env', 'custom-bash', 'skill-search']

function assembleModules(spec: PresetSpec, library: string): string {
  const parts: string[] = []
  for (const name of spec.modules ?? []) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`preset ${spec.id}: modules must be non-empty strings`)
    }
    // 模块名 containment：只允许裸库名（禁路径分隔符 / .. / 点目录），
    // 否则 join(library, name) 可越出引擎组合库读取任意文件。
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes('..')) {
      throw new Error(`preset ${spec.id}: module name ${JSON.stringify(name)} must be a bare library name`)
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
 * 行级 config 合并:仅支持 map 型 config 浅合并;
 * 数组型 config(如 delegation 组)按子行 id 嵌套合并;未声明模块原样保留。
 * 未声明 configs 时返回原文(零开销);parseDocument 往返保留注释。
 * 本函数是参数桥产物落位组合行的唯一机制(含 delegation 组子行嵌套),不是预设覆盖通道。
 */
export function applyModuleConfigs(raw: string, configs: Record<string, Record<string, unknown>> | undefined): string {
  if (configs === undefined || Object.keys(configs).length === 0) return raw
  const doc = parseDocument(raw, { logLevel: 'silent' })
  if (!(doc.contents instanceof YAMLSeq)) return raw
  const rows = doc.contents
  let changed = false
  /** 把 cfg 的键写入一个 config 节点（无 config 时创建）。 */
  const mergeInto = (item: YAMLMap, cfg: Record<string, unknown>): boolean => {
    const existingConfig = item.get('config', true)
    let configNode: YAMLMap
    if (existingConfig instanceof YAMLMap) {
      configNode = existingConfig
    } else if (existingConfig === null || existingConfig === undefined) {
      configNode = new YAMLMap()
      // Parsed 行节点的 set 约束 key/value 为 ParsedNode；新建节点运行时合法，
      // 类型断言绕过 Parsed 泛型（构造节点无 range 元数据）。
      item.items.push(new Pair(new Scalar('config'), configNode) as never)
    } else {
      return false
    }
    for (const [key, value] of Object.entries(cfg)) {
      configNode.set(key, value)
    }
    return true
  }
  /** 从行节点读 id（ParsedNode 值包装兼容）。 */
  const rowId = (item: YAMLMap): string | undefined => {
    const idNode = item.get('id', true)
    return idNode !== null && typeof idNode === 'object' && 'value' in idNode
      ? String((idNode as { value: unknown }).value)
      : undefined
  }
  for (const item of rows.items) {
    if (!(item instanceof YAMLMap)) continue
    const id = rowId(item)
    const existingConfig = item.get('config', true)
    if (existingConfig instanceof YAMLSeq && id !== undefined && !Object.prototype.hasOwnProperty.call(configs, id)) {
      // 数组型 config（delegation 组）：按子行 id 嵌套合并。
      for (const child of existingConfig.items) {
        if (!(child instanceof YAMLMap)) continue
        const childId = rowId(child)
        if (childId === undefined || !Object.prototype.hasOwnProperty.call(configs, childId)) continue
        if (mergeInto(child, configs[childId]!)) changed = true
      }
      continue
    }
    if (id === undefined || !Object.prototype.hasOwnProperty.call(configs, id)) continue
    if (mergeInto(item, configs[id]!)) changed = true
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
  const modules = Array.isArray(spec.modules) && spec.modules.length === 0
    ? FALLBACK_MODULES
    : spec.modules
  if (Array.isArray(modules)) raw = assembleModules({ ...spec, modules }, library)
  else {
    const name = typeof spec.composition === 'string' ? spec.composition : ''
    if (name.includes('\n')) raw = name
    else if (name.startsWith('./')) {
      if (templateDir === undefined) {
        throw new Error(`preset ${spec.id}: composition relative path needs a templateDir (${JSON.stringify(name)})`)
      }
      // containment：解析后的组合文件必须仍位于模板目录内（防 ../../ 越界读取）。
      const file = join(templateDir, name.slice(2))
      const rootResolved = resolve(templateDir)
      const fileResolved = resolve(file)
      if (fileResolved !== rootResolved && !fileResolved.startsWith(rootResolved + sep)) {
        throw new Error(`preset ${spec.id}: composition path escapes template dir (${JSON.stringify(name)})`)
      }
      try {
        raw = readFileSync(file, 'utf8')
      } catch (error) {
        throw new Error(`preset ${spec.id}: composition file not found (${file}): ${String((error as Error).message ?? error)}`)
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
 * 预设组合渲染完整链路:模块装配 → 参数桥(moduleConfigs + params)行级合并。
 * 合并优先级:参数桥(params/UI 基础层) > moduleConfigs(模板/ST 行级直写) > 行默认。
 * moduleConfigs 仅补充参数桥未覆盖的行级 config(如 ST 导入的 tool-web.fetch),
 * 不再锁定覆盖 UI 可管理参数(旧作者锁定语义已移除)。
 */
export function renderComposition(spec: PresetSpec, runtime: Record<string, unknown>, templateDir?: string): string {
  const params = resolvePresetParams(spec, runtime)
  const merged: Record<string, Record<string, unknown>> = buildModuleConfigsFromParams(params)
  for (const [id, cfg] of Object.entries(spec.moduleConfigs ?? {})) {
    // 参数桥优先：UI/运行时参数不被模板或 ST 直写覆盖。
    merged[id] = { ...cfg, ...merged[id] }
  }
  return applyModuleConfigs(loadCompositionText(spec, templateDir), merged)
}

/** 组合文本基础校验（模板无关）：无未解析 token，且必须是 YAML 数组。 */
export function assertCompositionArray(raw: string, spec: PresetSpec): unknown[] {
  const unresolved = raw.match(/__[A-Za-z0-9_]+__/g)
  if (unresolved !== null) throw new Error(`generated agent.cordis.yml has unresolved variables: ${unresolved.join(', ')}`)
  const parsed = parseYaml(raw, { logLevel: 'silent' })
  if (!Array.isArray(parsed)) throw new Error(`generated agent.cordis.yml is not a YAML array (preset ${spec.id})`)
  return parsed
}



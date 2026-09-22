/**
 * manifest — 预设模板单一参数 YAML(preset.yml)的加载与引擎参数解析。
 *
 * 一个预设 = 一个 preset.yml:
 *   - modules/layerSettings/content/meta 全部是直读参数,无模板语法;
 *   - layerSettings 展平为内部 params，供引擎生成默认提示词配置，promptConfigs 仅为可选覆盖;
 *   - 组合模块的行级 config 由参数桥 buildModuleConfigsFromParams 按 params
 *     构造对象合并（取代旧 __TOKEN__ 文本渲染，无占位符、无文本往返），
 *     params（UI/基础层）优先于 moduleConfigs 行级直写（旧作者锁定语义已移除）。
 * 本模块负责参数归一化与引擎模块配置装配;所有预设专属行为都在引擎内部。
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync, renameSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pair, Scalar, parse as parseYaml, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { DEFAULT_PRESET_DIR, DSH_HOME } from './paths.ts'
import { engineCapability, engineRecipe, impliedModulesForParams, isEngineCapabilityPresent, type ModuleSourceMode, type PresetModuleFacts } from '../shared/engine-capabilities.ts'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, buildEngineModuleParams, engineParamList, normalizeMaxDepth } from '../shared/engine-params.ts'
import { personaRowConfig, readPersonaSpec, type PersonaSpec } from '../shared/persona-section.ts'
import { DEFAULT_PRESET_ID } from '../shared/preset-ids.ts'
import { assertPresetDirectory, assertPresetId, assertPresetTree, engineModuleFileNames, presetPathExists, rewritePresetEngineReferences, setPresetDefinitionId } from './preset-install.ts'
import { engineParamPath, readLayerSettings, readPresetLayerSettings, PresetLayerSettingsError } from './preset-layer-settings.ts'
import { modelRequestConfigs } from './prompt-configs.ts'
export { MODEL_SEGMENT_MAP, PresetLayerSettingsError } from './preset-layer-settings.ts'

export interface PresetSpec {
  id: string
  name: string
  /** 预设说明（官方用户预设格式元数据；列表展示用，可选）。 */
  description?: string
  version: string
  engineCompat: string
  meta?: Record<string, unknown>
  content?: { presetText?: string; agentsText?: string }
  /** 模块清单(参数文件决定组合内容):按序装配 source/local 与 library 中的唯一模块。 */
  modules?: string[]
  /** 兼容字段:内联组合文本或组合清单名。 */
  composition?: string
  /** 内部运行时平铺适配面；磁盘上的同名段只允许未登记扩展字段。 */
  params?: Record<string, unknown>
  /** 共享引擎参数按编辑组的主归属插入点存储；规则实例仍拥有各自 params。 */
  layerSettings?: Record<string, Record<string, unknown>>
  /** 旧模型段仅保留未知字段；已登记模型字段必须显式迁移。 */
  model?: Record<string, unknown>
  /** 旧子代理模型段仅保留未知字段。 */
  subagentModel?: Record<string, unknown>
  /** 顶层人设段（官方 @deepseek-ai/dsh-persona 行同构）：prefix/suffix/complete/includeRuntimeContext。 */
  persona?: PersonaSpec
  /** 预设级模板变量（{{key}} 插值源；与 layerSettings 分离，顶层 variables 段）。 */
  variables?: Record<string, string>
  /** 自定义工具定义（tool-config-engine 渲染进 custom-tools/ 后运行时注册）。 */
  customTools?: unknown[]
  /** 子代理实例级工具策略（subagentToolPolicy 顶层领域段；缺省 = 官方 delegation 行为）。 */
  subagentToolPolicy?: Record<string, unknown>
  /** 模板变量插值开关（缺省 true = 启用；false = 停用，writePreset 不生成变量文件）。 */
  variablesEnabled?: boolean
  /**
   * @deprecated 自 2026-09-14 起不再生效：指令文件卡由独立指令来源
   * （pre-step 协调器 + `$DSH_HOME/.prompt-tool/instructions.yml` 策略）按会话现场解析，
   * 不再由 writePreset 物化。字段保留仅为兼容既有用户 preset.yml 的解析（不迁移、不删除）。
   */
  agentsHints?: boolean
  /** 可选:模板自定义提示词配置覆盖(纯数据,不使用模板语法)。 */
  promptConfigs?: unknown[]
  /** 可选:引擎组合模块行参数直写(行级 map config 浅合并;参数桥未覆盖的键生效,参数桥优先)。 */
  moduleConfigs?: Record<string, Record<string, unknown>>
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

/**
 * 从预设 preset.yml 的 modules 清单移除一个模块 id（YAML Document 保留注释
 * 与其余字段）。返回是否发生修改；文件缺失或没有该模块时返回 false。
 */
export function removePresetModule(dir: string, moduleId: string): boolean {
  const file = join(dir, 'preset.yml')
  if (!existsSync(file)) return false
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  if (doc.errors.length > 0) return false
  readPresetLayerSettings(doc.toJS())
  const modules = doc.getIn(['modules'])
  if (!(modules instanceof YAMLSeq)) return false
  const kept = modules.items.filter((item) => !(item instanceof Scalar) || item.value !== moduleId)
  if (kept.length === modules.items.length) return false
  modules.items = kept
  atomicWriteTextFile(file, doc.toString())
  invalidatePresetSpec(dir)
  return true
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
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`preset ${join(dir, 'preset.yml')} is not a YAML map`)
  }
  // 官方用户预设格式：preset.yml 仅元数据（name/description/order），id 回退目录名。
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    parsed.id = basename(dir)
  }
  const params = readPresetLayerSettings(parsed)
  if (parsed.layerSettings !== undefined || parsed.params !== undefined) parsed.params = params
  presetSpecCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, spec: parsed as PresetSpec })
  return parsed as PresetSpec
}

/** 读取预设模板内容资产(presetText / agentsText);模板缺失时静默降级。
 *  模板目录按 resolvePresetDir 解析（用户自定义预设优先，包内模板回退）。 */
export function loadPresetContent(template = DEFAULT_PRESET_ID, presetRoot = userPresetsDir()): { presetText: string; agentsText: string } {
  try {
    const spec = loadPresetSpec(resolvePresetDir(template, presetRoot))
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

/** 预设根：官方 USER_PRESET_DIR（~/.dsh/.agent-presets），导入/新建/种子化的预设都放这里。 */
export function userPresetsDir(): string {
  return DEFAULT_PRESET_DIR
}

/** 只按合法目录身份定位；现存坏身份必须报错，不能绕到同名模板。 */
function findPresetDir(scanDir: string, template: string): string | undefined {
  const exact = assertPresetDirectory(scanDir, template, true)
  return presetPathExists(exact) ? exact : undefined
}

/**
 * 解析预设模板目录：当前预设根优先，包内模板回退；不读取其他部署根的同名预设。
 * 目录名与声明的 preset.yml id 一致；不扫描其他目录的 id 别名。
 */
export function resolvePresetDir(template: string, presetRoot = userPresetsDir()): string {
  const found = findPresetDir(presetRoot, template) ?? findPresetDir(packagePresetDir(), template)
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
  } catch (error) {
    if (error instanceof PresetLayerSettingsError) throw error
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
export function resolveRenderablePresetDir(template: string, presetRoot = userPresetsDir()): { dir: string; fallback: boolean } {
  const userDir = findPresetDir(presetRoot, template)
  if (userDir === undefined) return { dir: resolvePresetDir(template, presetRoot), fallback: false }
  if (isRenderablePresetDir(userDir)) return { dir: userDir, fallback: false }
  const builtin = findPresetDir(packagePresetDir(), template)
  if (builtin !== undefined && isRenderablePresetDir(builtin)) return { dir: builtin, fallback: true }
  return { dir: userDir, fallback: false }
}

/** 可用预设清单：全部来自预设根 ~/.dsh/.agent-presets（官方预设目录，含 agent.cordis.yml
 *  即被宿主挂载；点前缀目录与无 preset.yml 的官方目录跳过，不占本插件列表）。 */
export function listPresets(presetRoot = userPresetsDir()): Array<{ id: string; name: string; user: boolean; renderable: boolean; description?: string; meta?: Record<string, unknown> }> {
  const scan = (dir: string): Array<{ id: string; name: string; user: boolean; renderable: boolean; description?: string; meta?: Record<string, unknown> }> => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name))
        // 旧容器 id 兼容快照仅供历史会话 resolve，不参与普通预设选择/重建。
        .filter((entry) => entry.name !== 'prompt-tool')
        .flatMap((entry) => {
          try {
            const spec = loadPresetSpec(assertPresetDirectory(dir, entry.name))
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
  for (const preset of scan(presetRoot)) byId.set(preset.id, preset)
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** 插件目录模板清单（「新建」选择器与首次种子化数据源；不直接出现在预设列表）。 */
export function listBuiltinTemplates(): Array<{ id: string; name: string }> {
  try {
    return readdirSync(packagePresetDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      // 自定义预设走「新建」顶部专用入口（autoSuffix），不重复出现在普通模板列表。
      .filter((entry) => entry.name !== 'pt-custom')
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

/** 按包内同名目录补建缺失预设；已有目录的定义、生成物和资源保持原样。 */
export function ensurePresetSeed(root = userPresetsDir()): { created: string[] } {
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

/** 完整复制到隐藏候选；只更新定义 ID 和已知共享引擎配置位置。 */
function copyPresetDirectory(source: string, root: string, targetId: string): void {
  assertPresetTree(source)
  loadPresetSpec(source)
  const target = assertPresetDirectory(root, targetId, true)
  if (presetPathExists(target)) throw new Error(`目标预设已存在：${targetId}`)
  mkdirSync(root, { recursive: true })
  const candidate = mkdtempSync(join(root, `.${targetId}.copy-`))
  try {
    cpSync(source, candidate, { recursive: true })
    const definition = join(candidate, 'preset.yml')
    const doc = parseDocument(readFileSync(definition, 'utf8'), { logLevel: 'silent' })
    if (doc.errors.length > 0 || !(doc.contents instanceof YAMLMap)) throw new Error('预设定义必须是合法 YAML 对象')
    const oldId = doc.get('id')
    if (oldId !== targetId) {
      setPresetDefinitionId(doc, targetId)
      writeFileSync(definition, doc.toString(), 'utf8')
    }
    const files = engineModuleFileNames(packageEngineDir())
    for (const relative of ['agent.cordis.yml', typeof doc.get('composition') === 'string' && String(doc.get('composition')).startsWith('./') ? String(doc.get('composition')) : '']) {
      if (!relative) continue
      const file = resolve(candidate, relative)
      if (!file.startsWith(resolve(candidate) + sep)) throw new Error('组合文件路径越界')
      if (presetPathExists(file)) {
        const before = readFileSync(file, 'utf8')
        const after = rewritePresetEngineReferences(before, targetId, files, candidate)
        if (after !== before) writeFileSync(file, after, 'utf8')
      }
    }
    const composition = doc.get('composition')
    if (typeof composition === 'string' && composition.includes('\n')) {
      const rewritten = rewritePresetEngineReferences(composition, targetId, files, candidate)
      if (rewritten !== composition) { doc.set('composition', rewritten); writeFileSync(definition, doc.toString(), 'utf8') }
    }
    if (presetPathExists(target)) throw new Error(`目标预设已存在：${targetId}`)
    renameSync(candidate, target)
  } finally {
    rmSync(candidate, { recursive: true, force: true })
  }
}

/** 从包内同名目录复制预设；autoSuffix=true 时递增目录名并同步定义身份。 */
export function cloneBuiltinPreset(id: string, autoSuffix = false, presetRoot = userPresetsDir()): { ok: true; id: string } | { ok: false; message: string } {
  try {
    assertPresetId(id)
    const builtin = findPresetDir(packagePresetDir(), id)
    if (builtin === undefined) {
      return { ok: false, message: `预设 ${id} 不是包内置预设` }
    }
    let targetId = id
    let target = join(presetRoot, targetId)
    if (presetPathExists(target)) {
      if (!autoSuffix) {
        return { ok: false, message: `用户目录已存在同名预设 ${targetId}，请先删除再新建` }
      }
      for (let suffix = 2; ; suffix++) {
        targetId = `${id}-${suffix}`
        target = join(presetRoot, targetId)
        if (!presetPathExists(target)) break
      }
    }
    copyPresetDirectory(builtin, presetRoot, targetId)
    return { ok: true, id: targetId }
  } catch (error) {
    return { ok: false, message: `新建预设失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 复制用户预设目录为新预设（id 自动递增：<id>-copy / <id>-copy-2 / …）。
 *  复制的是用户目录完整副本（preset.yml / agent.cordis.yml / prompt-configs /
 *  内容资产 / 覆盖文件），与「从内置模板新建」互补：后者还原模板，前者备份现状。 */
export function duplicateUserPreset(id: string, presetRoot = userPresetsDir()): { ok: true; id: string } | { ok: false; message: string } {
  try {
    assertPresetId(id)
    const root = resolve(presetRoot)
    const source = assertPresetDirectory(root, id)
    let targetId = `${id}-copy`
    let target = join(root, targetId)
    for (let suffix = 2; presetPathExists(target); suffix++) {
      targetId = `${id}-copy${suffix}`
      target = join(root, targetId)
    }
    copyPresetDirectory(source, root, targetId)
    return { ok: true, id: targetId }
  } catch (error) {
    return { ok: false, message: `复制预设失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 在系统文件管理器中打开预设目录（尽力而为：无桌面环境时打开失败也返回路径供 UI 展示）。 */
export function openPresetLocation(id: string, presetRoot = userPresetsDir()): { ok: true; path: string } | { ok: false; message: string; path: string } {
  // 普通预设 id（裸目录名）或角色卡库子路径（/.characters/<cardId>）两种形态。
  const isBareId = typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id)
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
    if (isBareId) assertPresetDirectory(presetRoot, id)
    const command = process.platform === 'win32' ? 'explorer'
      : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [dir], { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, path: dir }
  } catch (error) {
    return { ok: false, message: `打开目录失败：${error instanceof Error ? error.message : String(error)}`, path: dir }
  }
}

/** 父集合缺失时不触发 deleteIn 对不存在集合的异常。 */
function deleteYamlPath(doc: ReturnType<typeof parseDocument>, path: string[]): void {
  if (doc.hasIn(path)) doc.deleteIn(path)
}

/**
 * 保存预设参数：写 layerSettings（merge）/ promptConfigs（整体替换）。
 * parseDocument 保留注释与未知键（preset.yml 模板含大量注释）；空值键删除（'' / []，
 * 回落模板/引擎默认；0 与 false 照常写入——语义与函数内注释、docs §3 一致）。
 */
export function savePresetParams(
  presetRoot: string,
  templateName: string,
  params: Record<string, unknown> | undefined,
  promptConfigs: unknown[] | undefined,
  variables?: Record<string, string>,
  variablesEnabled?: boolean,
): void {
  const file = join(assertPresetDirectory(presetRoot, templateName), 'preset.yml')
  if (!existsSync(file)) throw new Error(`preset ${templateName} 无 preset.yml`)
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  readPresetLayerSettings(doc.toJS())
  // 空值 = 删除键（回落模板/引擎默认）：''（字符串清空）、[]（列表清空）。
  // 其余 0/false 照常写入：stagePreUnlock 的 0 是合法档位（undefined 才回落
  // 引擎默认 1），maxPromoteSteps 0 由引擎归一为默认 4。
  if (params !== undefined) {
    for (const [key, value] of Object.entries(params)) {
      // 仅跳过 undefined/null 与空 key 名；空串/空数组照常写入——
      // 「从有值改回留空」依赖空值清掉旧键（渲染层空值跳过 = 继承模板/宿主默认）。
      if (value === undefined || value === null || key.trim().length === 0) continue
      const isEmpty = value === '' || (Array.isArray(value) && value.length === 0)
      const path = engineParamPath(key)
      if (isEmpty) deleteYamlPath(doc, path)
      else doc.setIn(path, value)
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
    // 模板变量只写顶层 variables 段，不修改 layerSettings 中的同名引擎参数。
    const kept = Object.fromEntries(
      Object.entries(variables).filter(([key, value]) => key.trim().length > 0 && typeof value === 'string'),
    )
    if (Object.keys(kept).length > 0) {
      doc.setIn(['variables'], kept)
    } else {
      doc.deleteIn(['variables'])
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
}

/**
 * 保存激活预设的顶层 persona 段（官方 `@deepseek-ai/dsh-persona` 行 config 同构）。
 * null = 删除该段（回落宿主部署人设）；默认值不落键（见 personaRowConfig）。
 */
export function savePresetPersona(presetRoot: string, templateName: string, persona: PersonaSpec | null): void {
  const file = join(assertPresetDirectory(presetRoot, templateName), 'preset.yml')
  if (!existsSync(file)) throw new Error(`preset ${templateName} 无 preset.yml`)
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  readPresetLayerSettings(doc.toJS())
  if (persona === null) doc.deleteIn(['persona'])
  else doc.setIn(['persona'], personaRowConfig(persona))
  atomicWriteTextFile(file, doc.toString())
  invalidatePresetSpec(join(presetRoot, templateName))
}

/** 原子写文件（tmp + rename）：preset.yml 增量写路径防截断与半写。 */
export function atomicWriteTextFile(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/** 预设文件读-改-写（parseDocument 保留注释与未知键；mutate 内 setIn/deleteIn）。
 *  角色卡库（characters）与世界书工具（world-book-tools）共用此入口，避免
 *  各自实现 parseDocument 往返。写盘走原子替换，失败保留旧文件。 */
export function withPresetDoc(presetDir: string, mutate: (doc: ReturnType<typeof parseDocument>) => void): void {
  const file = join(presetDir, 'preset.yml')
  if (!existsSync(file)) throw new Error(`${presetDir} 无 preset.yml`)
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  readPresetLayerSettings(doc.toJS())
  mutate(doc)
  readPresetLayerSettings(doc.toJS())
  atomicWriteTextFile(file, doc.toString())
  invalidatePresetSpec(presetDir)
}

/** 向 preset.yml 的 modules 追加功能模块；空数组保持按需装配语义。 */
export function appendPresetModules(
  doc: ReturnType<typeof parseDocument>,
  additions: readonly string[],
): void {
  if (additions.length === 0) return
  const source = doc.toJS() as { modules?: unknown }
  if (!Array.isArray(source.modules)) throw new Error('当前预设缺少 modules 数组，不能自动装配工具模块')
  const current = source.modules.filter((item): item is string => typeof item === 'string' && item.length > 0)
  const modules = [...current]
  for (const module of additions) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(module)) throw new Error('非法模块名：' + module)
    if (!modules.includes(module)) modules.push(module)
  }
  doc.set('modules', modules)
}

/** 删除具有合法身份的预设目录（预设根/<id>）；隐藏备份不经公共接口删除。
 *  仅作用于预设根（官方 USER_PRESET_DIR），包内置模板天然不受影响；路径越界与非法 id 拒绝。
 *  删除后宿主 agent-presets 目录列表自然不再出现该预设（官方 roster 即目录列表）。 */
export function removeUserPreset(id: string, presetRoot = userPresetsDir()): { ok: true } | { ok: false; message: string } {
  try {
    const target = assertPresetDirectory(presetRoot, id)
    assertPresetTree(target)
    rmSync(target, { recursive: true, force: true })
    invalidatePresetSpec(target)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `删除失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 从导入的 preset.yml 读取合法 ID；仅缺失时使用同样合法的目录名。 */
export function parseImportedPresetId(presetYaml: string, fallback: string): string {
  const doc = parseDocument(presetYaml, { logLevel: 'silent' })
  if (doc.errors.length > 0 || !(doc.contents instanceof YAMLMap)) throw new Error('预设定义必须是合法 YAML 对象')
  readPresetLayerSettings(doc.toJS())
  const declared = doc.get('id')
  const id = declared === undefined ? fallback : declared
  assertPresetId(id)
  return id
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
  for (const [key, value] of Object.entries(spec.layerSettings === undefined ? spec.params ?? {} : readLayerSettings(spec.layerSettings))) {
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
const parseListParam = engineParamList

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
export function buildModuleConfigsFromParams(params: Record<string, unknown>, options: { subagentPolicyEnabled?: boolean } = {}): Record<string, Record<string, unknown>> {
  const out = buildEngineModuleParams(params)
  const merge = (module: string, cfg: Record<string, unknown>): void => {
    if (Object.keys(cfg).length === 0) return
    out[module] = { ...out[module], ...cfg }
  }

  // delegation 组：子代理模型路由/人设/工具集/深度（spawn 与 fork 两行同配置，
  // 由 applyModuleConfigs 的嵌套合并按子行 id 落位）。
  const subagent: Record<string, unknown> = {}
  const provider = asString(params.subagentModelProvider, '')
  const model = asString(params.subagentModelName, '')
  if (provider.length > 0 && model.length > 0) subagent.agentOptions = { provider, model }
  // 子代理工具权限分离（Wave 3）：策略启用后参数桥不再把主代理列表写入
  // delegation.toolFilter（子代理由 subagentToolPolicy 实例级解析授权，避免双重过滤）。
  if (options.subagentPolicyEnabled !== true) {
    const subAllow = parseListParam(params.toolFilterAllow)
    const subDeny = parseListParam(params.toolFilterDeny)
    if (subAllow.length > 0 || subDeny.length > 0) {
      subagent.toolFilter = {
        ...(subAllow.length > 0 ? { allow: subAllow } : {}),
        ...(subDeny.length > 0 ? { deny: subDeny } : {}),
      }
    }
  }
  const maxDepth = normalizeMaxDepth(params.maxDepth)
  if (maxDepth !== undefined) subagent.maxDepth = maxDepth
  if (Object.keys(subagent).length > 0) {
    out['tool-subagent'] = subagent
    out['tool-subagent-fork'] = subagent
  }
  if (options.subagentPolicyEnabled === true) {
    const policy: Record<string, unknown> = {}
    if (provider.length > 0 && model.length > 0) {
      policy.agentOptions = {
        provider,
        model,
        ...(typeof params.subagentReasoningEffort === 'string' && params.subagentReasoningEffort.length > 0
          ? { reasoningEffort: params.subagentReasoningEffort }
          : {}),
        ...((): Record<string, number> => {
          const raw = params.subagentMaxTokens
          const maxTokens = typeof raw === 'string' ? Number(raw.trim()) : raw
          return typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}
        })(),
      }
    }
    if (maxDepth !== undefined) policy.maxDepth = maxDepth
    merge('subagent-tool-policy', policy)
  }
  return out
}

/**
 * 组合模块目录分工：
 * - source/local：本项目自有模块的唯一源文件；
 * - library：由 rebuild-composition 原样生成的官方切块与官方预设变体，不含本地补丁。
 * 同名文件禁止同时存在，避免 source 与产物漂移。
 */
function compositionModuleDirs(): string[] {
  const root = join(packageEngineDir(), 'compositions')
  return [join(root, 'source', 'local'), join(root, 'library')]
}

function assertBareModuleName(name: string): void {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes('..')) {
    throw new Error(`composition module name ${JSON.stringify(name)} must be a bare library name`)
  }
}

function moduleFile(name: string): string {
  assertBareModuleName(name)
  const candidates = compositionModuleDirs().map((dir) => join(dir, `${name}.yml`))
  const existing = candidates.filter((file) => existsSync(file))
  if (existing.length > 1) {
    throw new Error(`composition module ${name} is duplicated across source/local and library: ${existing.join(', ')}`)
  }
  if (existing.length === 0) {
    throw new Error(`composition module ${name} not found in source/local or library`)
  }
  return existing[0]!
}

function assembleModules(spec: PresetSpec): string {
  const parts: string[] = []
  const seen = new Set<string>()
  for (const name of spec.modules ?? []) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`preset ${spec.id}: modules must be non-empty strings`)
    }
    if (seen.has(name)) {
      throw new Error(`preset ${spec.id}: duplicate composition module ${JSON.stringify(name)}`)
    }
    seen.add(name)
    // 模块名 containment：只允许裸库名（禁路径分隔符 / .. / 点目录）。
    try {
      parts.push(readFileSync(moduleFile(name), 'utf8'))
    } catch (error) {
      throw new Error(`preset ${spec.id}: ${String((error as Error).message ?? error)}`)
    }
  }
  return parts.length > 0 ? parts.join('\n') : '[]\n'
}

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
      if (value === undefined) configNode.delete(key)
      else configNode.set(key, value)
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
export function loadCompositionText(spec: PresetSpec, templateDir?: string, runtime: Record<string, unknown> = {}): string {
  let raw: string
  let modules = spec.modules
  if (Array.isArray(modules)) {
    const declared: string[] = modules
    // 参数在 ⇒ 装配在：显式 params/moduleConfigs 隐含的能力模块自动补齐，与顶层策略段同一规则。
    const params = resolvePresetParams(spec, runtime)
    const extra = [
      ...(spec.subagentToolPolicy !== undefined && spec.subagentToolPolicy !== null ? ['subagent-tool-policy'] : []),
      ...impliedModulesForParams(resolvePresetParams(spec, {}), spec.moduleConfigs),
      ...(Array.isArray(spec.promptConfigs) && spec.promptConfigs.length > 0 || modelRequestConfigs(params).length > 0 ? ['prompt-config-engine'] : []),
    ].filter((module) => !declared.includes(module))
    if (extra.length > 0) modules = [...declared, ...extra]
  }
  if (Array.isArray(modules)) raw = assembleModules({ ...spec, modules })
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
      try {
        raw = readFileSync(moduleFile(name), 'utf8')
      } catch (error) {
        throw new Error(`preset ${spec.id}: ${String((error as Error).message ?? error)}`)
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
 * 解析预设的模块事实，供 UI 卡片存在性和受控创建共用。
 * 显式模块与历史策略兼容装配是可编辑插件能力；官方组合 row 仅保留为运行事实。
 */
export function resolvePresetModuleFacts(
  spec: PresetSpec,
  templateDir?: string,
  editable = false,
): PresetModuleFacts {
  const declaredModules = Array.isArray(spec.modules)
    ? [...new Set(spec.modules.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
    : null
  const sourceMode: ModuleSourceMode = Array.isArray(spec.modules)
    ? 'explicit'
    : typeof spec.composition === 'string' && spec.composition.trim().length > 0
      ? 'composition'
      : templateDir !== undefined && existsSync(join(templateDir, 'agent.cordis.yml'))
        ? 'official'
        : 'unknown'
  const effectiveModules = sourceMode === 'explicit'
    ? [...(declaredModules ?? [])]
    : null
  if (sourceMode === 'unknown') {
    return { declaredModules, effectiveModules: null, rowIds: [], sourceMode, editable: false }
  }

  let raw: string
  try {
    // 事实展示对重复声明采用稳定去重；真正写入/渲染路径仍由
    // assembleModules 拒绝重复项。这样 UI 不会因旧重复清单丢失全部事实。
    const factsSpec = sourceMode === 'explicit' && declaredModules !== null
      ? { ...spec, modules: declaredModules }
      : spec
    raw = loadCompositionText(factsSpec, templateDir)
  } catch {
    return { declaredModules, effectiveModules: null, rowIds: [], sourceMode: 'unknown', editable: false }
  }
  const rowIds: string[] = []
  const seenRows = new Set<string>()
  const defaults = new Map<string, Record<string, unknown>>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string' && record.id.length > 0) {
      if (!seenRows.has(record.id)) {
        seenRows.add(record.id)
        rowIds.push(record.id)
      }
      if (record.config !== null && typeof record.config === 'object' && !Array.isArray(record.config)) {
        defaults.set(record.id, { ...(record.config as Record<string, unknown>) })
      }
    }
    for (const child of Object.values(record)) visit(child)
  }
  try {
    visit(parseYaml(raw, { logLevel: 'silent' }))
  } catch {
    return { declaredModules, effectiveModules: null, rowIds: [], sourceMode: 'unknown', editable: false }
  }
  // 隐式装配如实进入 effectiveModules（declaredModules 保持磁盘事实）：参数在 ⇒ 装配在；
  // 顶层策略段同理——两者都让编辑卡与「本层已装配的能力」展示真实运行状态。
  if (effectiveModules !== null) {
    for (const module of impliedModulesForParams(resolvePresetParams(spec, {}), spec.moduleConfigs)) {
      if (!effectiveModules.includes(module)) effectiveModules.push(module)
    }
    if (rowIds.includes('subagent-tool-policy') && !effectiveModules.includes('subagent-tool-policy')) {
      effectiveModules.push('subagent-tool-policy')
    }
    if (rowIds.includes('prompt-config-engine') && !effectiveModules.includes('prompt-config-engine')) {
      effectiveModules.push('prompt-config-engine')
    }
  }
  const effectiveConfigs: Record<string, Record<string, unknown>> = {}
  for (const [id, config] of defaults) effectiveConfigs[id] = config
  for (const [id, config] of Object.entries(spec.moduleConfigs ?? {})) {
    effectiveConfigs[id] = { ...effectiveConfigs[id], ...config }
  }
  const generated = buildModuleConfigsFromParams(resolvePresetParams(spec, {}), {
    subagentPolicyEnabled: spec.subagentToolPolicy !== undefined && spec.subagentToolPolicy !== null,
  })
  for (const [id, config] of Object.entries(generated)) {
    effectiveConfigs[id] = { ...effectiveConfigs[id], ...config }
  }
  return { declaredModules, effectiveModules, rowIds, sourceMode, editable: editable && sourceMode === 'explicit', effectiveConfigs }
}

export type EngineCapabilityCreateRequest =
  | { action: 'create'; capabilityId: string }
  | { action: 'create-recipe'; recipeId: string }

export interface EngineCapabilityCreateResult {
  changed: boolean
  addedModules: string[]
  capabilityIds: string[]
}

export interface EngineCapabilityRemoveResult {
  changed: boolean
  removedModules: string[]
  capabilityIds: string[]
}

/** 在内存候选文档中展开能力/recipe，校验成功后一次原子替换 preset.yml。 */
export function createEngineCapabilityInPreset(
  presetDir: string,
  request: EngineCapabilityCreateRequest,
): EngineCapabilityCreateResult {
  const file = join(presetDir, 'preset.yml')
  if (!existsSync(file)) throw new Error(`预设目录缺少 preset.yml：${presetDir}`)
  const original = readFileSync(file, 'utf8')
  const doc = parseDocument(original, { logLevel: 'silent' })
  const source = doc.toJS() as PresetSpec
  const sourceParams = readPresetLayerSettings(source)
  if (!Array.isArray(source.modules)) throw new Error('当前预设没有可编辑的 modules 数组；请先复制为插件用户预设')
  const capabilityIds = request.action === 'create'
    ? [request.capabilityId]
    : (engineRecipe(request.recipeId)?.capabilities ? [...engineRecipe(request.recipeId)!.capabilities] : [])
  if (capabilityIds.length === 0 || capabilityIds.some((id) => engineCapability(id) === undefined)) {
    throw new Error(`未知引擎能力或 recipe：${request.action === 'create' ? request.capabilityId : request.recipeId}`)
  }
  const currentFacts = resolvePresetModuleFacts(source, presetDir, true)
  // 创建检查磁盘声明，而不是实际装配：历史策略虽然已经运行，仍需允许补齐 modules。
  const declaredFacts = { ...currentFacts, effectiveModules: currentFacts.declaredModules }
  const additions = capabilityIds
    .filter((id) => !isEngineCapabilityPresent(id, declaredFacts))
    .flatMap((id) => engineCapability(id)?.moduleKeys.slice(0, 1) ?? [])
  const modules = source.modules.filter((item): item is string => typeof item === 'string' && item.length > 0)
  const addedModules: string[] = []
  for (const module of additions) {
    if (!modules.includes(module)) {
      modules.push(module)
      addedModules.push(module)
    }
  }
  doc.set('modules', modules)
  const recipe = request.action === 'create-recipe' ? engineRecipe(request.recipeId) : undefined
  for (const [key, value] of Object.entries(recipe?.initialParams ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(sourceParams, key)) doc.setIn(engineParamPath(key), value)
  }
  // 拥有顶层数据段的能力（如 subagent-tool-policy → subagentToolPolicy）：启用即写入可用骨架，
  // 保证"模块在 ⇒ 数据在"（否则 shadow 行会读不到物化后的 policy.yml）。
  let sectionWritten = false
  for (const id of capabilityIds) {
    const section = engineCapability(id)?.ownSection
    if (section === undefined) continue
    const existing = (source as unknown as Record<string, unknown>)[section.key]
    if (existing !== undefined && existing !== null) continue
    doc.setIn([section.key], JSON.parse(JSON.stringify(section.skeleton)))
    sectionWritten = true
  }
  const candidate = doc.toJS() as PresetSpec
  const rendered = renderComposition(candidate, {}, presetDir)
  const rows = assertCompositionArray(rendered, candidate)
  const rowPaths = new Map<string, string>()
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string' && record.id.length > 0) {
      const firstPath = rowPaths.get(record.id)
      if (firstPath !== undefined) {
        throw new Error(`预设 ${candidate.id} 的组合包含重复 row id ${JSON.stringify(record.id)}（${firstPath} 与 ${path}）`)
      }
      rowPaths.set(record.id, path)
    }
    for (const [key, child] of Object.entries(record)) visit(child, `${path}.${key}`)
  }
  visit(rows, 'rows')
  for (const id of capabilityIds) {
    const capability = engineCapability(id)!
    if (!capability.rowIds.some((rowId) => rowPaths.has(rowId))) throw new Error(`能力 ${id} 的组合缺少预期 row`)
  }
  if (addedModules.length === 0 && recipe === undefined && !sectionWritten) return { changed: false, addedModules, capabilityIds }
  if (addedModules.length === 0 && recipe !== undefined && Object.entries(recipe.initialParams ?? {}).every(([key]) => Object.prototype.hasOwnProperty.call(sourceParams, key))) {
    return { changed: false, addedModules, capabilityIds }
  }
  atomicWriteTextFile(file, doc.toString())
  invalidatePresetSpec(presetDir)
  return { changed: true, addedModules, capabilityIds }
}

/** 删除能力：模块声明、顶层数据段，以及该能力的**显式参数与行配置**一起移除。
 *  参数在 ⇒ 装配在（见 impliedModulesFromParams）：留下参数会让移除立刻被隐含装配拉回来，
 *  所以"移除能力"必须是完整移除。未登记参数、其他能力的数据与未知字段一律不动。 */
export function removeEngineCapabilityFromPreset(
  presetDir: string,
  capabilityId: string,
): EngineCapabilityRemoveResult {
  const file = join(presetDir, 'preset.yml')
  if (!existsSync(file)) throw new Error(`预设目录缺少 preset.yml：${presetDir}`)
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  const source = doc.toJS() as unknown as PresetSpec & Record<string, unknown>
  const params = readPresetLayerSettings(source)
  if (!Array.isArray(source.modules)) throw new Error('当前预设没有可编辑的 modules 数组；官方组合不支持删除插件能力')
  const capability = engineCapability(capabilityId)
  if (capability === undefined) throw new Error(`未知引擎能力：${capabilityId}`)
  const modules = source.modules.filter((item): item is string => typeof item === 'string' && item.length > 0)
  const removedModules = modules.filter((module) => capability.moduleKeys.includes(module))
  const section = capability.ownSection
  const sectionPresent = section !== undefined && source[section.key] !== undefined && source[section.key] !== null
  // 该能力的显式参数键与行配置：与模块声明同生共死。
  const paramKeys = ENGINE_PARAM_KEYS.filter((key) => ENGINE_PARAM_DEFINITIONS[key].card === capabilityId
    && Object.prototype.hasOwnProperty.call(params, key))
  const configs = (source.moduleConfigs ?? {}) as Record<string, unknown>
  const configRows = [...new Set([...capability.rowIds, ...capability.moduleKeys])]
    .filter((rowId) => Object.prototype.hasOwnProperty.call(configs, rowId))
  if (removedModules.length === 0 && !sectionPresent && paramKeys.length === 0 && configRows.length === 0) {
    return { changed: false, removedModules, capabilityIds: [capabilityId] }
  }
  if (removedModules.length > 0) doc.set('modules', modules.filter((module) => !capability.moduleKeys.includes(module)))
  if (sectionPresent) doc.deleteIn([section!.key])
  for (const key of paramKeys) doc.deleteIn(engineParamPath(key))
  for (const rowId of configRows) doc.deleteIn(['moduleConfigs', rowId])
  const candidate = doc.toJS() as PresetSpec
  assertCompositionArray(renderComposition(candidate, {}, presetDir), candidate)
  atomicWriteTextFile(file, doc.toString())
  invalidatePresetSpec(presetDir)
  return { changed: true, removedModules, capabilityIds: [capabilityId] }
}

/**
 * 预设组合渲染完整链路:模块装配 → 参数桥(moduleConfigs + params)行级合并。
 * 合并优先级:参数桥(params/UI 基础层) > moduleConfigs(模板/ST 行级直写) > 行默认。
 * moduleConfigs 仅补充参数桥未覆盖的行级 config(如 ST 导入的 tool-web.fetch),
 * 不再锁定覆盖 UI 可管理参数(旧作者锁定语义已移除)。
 */
export function renderComposition(spec: PresetSpec, runtime: Record<string, unknown>, templateDir?: string): string {
  const params = resolvePresetParams(spec, runtime)
  const merged: Record<string, Record<string, unknown>> = buildModuleConfigsFromParams(params, {
    subagentPolicyEnabled: spec.subagentToolPolicy !== undefined && spec.subagentToolPolicy !== null,
  })
  for (const [id, cfg] of Object.entries(spec.moduleConfigs ?? {})) {
    // 参数桥优先：UI/运行时参数不被模板或 ST 直写覆盖。
    merged[id] = { ...cfg, ...merged[id] }
  }
  let raw = loadCompositionText(spec, templateDir, runtime)
  // 人设由预设字段直接生成官方行，不查模块库，也不改写 modules 清单。
  // composition 文件仍自行提供该行；顶层字段只覆盖它的配置。
  const persona = readPersonaSpec(spec.persona)
  if (persona !== undefined && Array.isArray(spec.modules)) {
    const doc = parseDocument(raw, { logLevel: 'silent' })
    if (!(doc.contents instanceof YAMLSeq)) throw new Error(`preset ${spec.id}: composition must be a YAML array`)
    merged.persona = personaRowConfig(persona)
    const rows: YAMLSeq = doc.contents
    rows.items.unshift(doc.createNode({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: merged.persona }))
    raw = doc.toString()
  } else if (persona !== undefined) {
    merged.persona = {
      ...merged.persona,
      prefix: persona.prefix,
      suffix: persona.suffix ?? undefined,
      complete: persona.complete ?? undefined,
      includeRuntimeContext: persona.includeRuntimeContext ?? undefined,
    }
  }
  return applyModuleConfigs(raw, merged)
}

/** 组合文本基础校验（模板无关）：无未解析 token，且必须是 YAML 数组。 */
export function assertCompositionArray(raw: string, spec: PresetSpec): unknown[] {
  const unresolved = raw.match(/__[A-Za-z0-9_]+__/g)
  if (unresolved !== null) throw new Error(`generated agent.cordis.yml has unresolved variables: ${unresolved.join(', ')}`)
  const parsed = parseYaml(raw, { logLevel: 'silent' })
  if (!Array.isArray(parsed)) throw new Error(`generated agent.cordis.yml is not a YAML array (preset ${spec.id})`)
  return parsed
}

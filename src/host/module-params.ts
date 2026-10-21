/**
 * 引擎参数与模块事实：参数优先级唯一判定点（`resolveModuleParams`）、参数桥
 * （`buildModuleConfigsFromParams`）、组合渲染（`renderComposition`）与模块事实
 * （`resolveModuleFacts` / `readModuleFacts`）。从原 `manifest.ts` 按簇拆出。
 *
 * 原文件头总述（模块模板单一参数 YAML 的加载与引擎参数解析）随参数/装配代码落在本簇：
 * 一个模块 = 一个 module.yml:
 *   - modules/layerSettings/content/meta 全部是直读参数,无模板语法;
 *   - rules 是唯一条件→动作来源；layerSettings 只展平仍属能力的共享参数;
 *   - 组合模块的行级 config 由参数桥 buildModuleConfigsFromParams 按 params
 *     构造对象合并（取代旧 __TOKEN__ 文本渲染，无占位符、无文本往返），
 *     params（UI/基础层）优先于 moduleConfigs 行级直写（旧作者锁定语义已移除）。
 * 参数归一化与引擎模块配置装配在本簇;所有模块专属行为都在引擎内部。
 */
import { isAbsolute } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { impliedModulesForParams } from '../shared/engine-capabilities.ts'
import type { ModuleFacts, ModuleSourceMode } from '../shared/engine-capabilities.ts'
import { buildEngineModuleParams } from '../shared/engine-params.ts'
import { readPersonaSpec } from '../shared/persona-section.ts'
import { readModuleLayerSettings } from './module-layer-settings.ts'
import { isEditableModuleDir, resolveModuleDir } from './module-dirs.ts'
import { asString, loadModuleSpec } from './module-spec.ts'
import type { ModuleSpec } from './module-spec.ts'
import { applyModuleConfigs, loadCompositionText } from './module-composition.ts'

/** on/off 等字面开关归一化为布尔。 */
function normalizeParam(value: unknown): unknown {
  if (value === 'on') return true
  if (value === 'off') return false
  return value
}
/**
 * 有效引擎参数（**优先级唯一判定点**）：全局层垫底 → 模块显式键覆盖（存在即覆盖，
 * `false` / `0` 都是显式值）→ 运行时入参覆盖；三处都没有的键不出现，由引擎/行默认兜底。
 * 不从旧磁盘 `params` 段回退取值。
 */
export function resolveModuleParams(spec: ModuleSpec, runtime: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(spec.globalParams ?? {})) {
    params[key] = normalizeParam(value)
  }
  for (const [key, value] of Object.entries(readModuleLayerSettings(spec))) {
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
/**
 * 参数桥：params 扁平键 → 引擎模块行 config 对象（取代旧 __TOKEN__ 文本渲染）。
 *
 * 原则：
 *  - 未声明的键不合并（composition 行默认 / 引擎默认生效），与旧"空值删行"语义等价；
 *  - 值类型直达（布尔/数字/数组不再字符串化再解析）；
 *  - 合并优先级：参数桥（UI/基础层）> moduleConfigs（模板/ST 行级直写）> 行默认。
 * 模型路由/委派参数统一扁平键（modelProvider/subagentModelProvider 等），
 * 与官方 AgentOptions{provider,model} 对齐。
 */
export function buildModuleConfigsFromParams(params: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out = buildEngineModuleParams(params)

  // delegation 组：子代理模型路由（spawn 与 fork 两行同配置，
  // 由 applyModuleConfigs 的嵌套合并按子行 id 落位）。递归深度由宿主官方管理。
  const subagent: Record<string, unknown> = {}
  const provider = asString(params.subagentModelProvider, '')
  const model = asString(params.subagentModelName, '')
  if (provider.length > 0 && model.length > 0) subagent.agentOptions = { provider, model }
  if (Object.keys(subagent).length > 0) {
    out['tool-subagent'] = subagent
    out['tool-subagent-fork'] = subagent
  }
  return out
}
/** 组合行 disabled 的受控求值：只允许布尔和 process.platform 比较，不执行任意 JS。 */
export function rowDisabled(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false
  if (value === true) return true
  if (typeof value !== 'string') throw new TypeError(`组合行 disabled 必须是布尔或 process.platform 比较，收到 ${typeof value}`)
  const text = value.trim()
  const match = /^process\.platform\s*(===|!==)\s*['"]([^'"]+)['"]$/.exec(text)
  if (match === null) throw new TypeError(`组合行 disabled 表达式不受支持：${JSON.stringify(text)}；只支持 true/false 与 process.platform ===/!==`)
  return match[1] === '===' ? process.platform === match[2] : process.platform !== match[2]
}

/**
 * 解析模块的模块事实，供 UI 卡片存在性和受控创建共用。
 * 显式模块及当前参数/策略所需的装配是可编辑插件能力；官方组合 row 仅保留为运行事实。
 */
export function resolveModuleFacts(
  spec: ModuleSpec,
  templateDir?: string,
  editable = false,
): ModuleFacts {
  const declaredModules = Array.isArray(spec.modules)
    ? [...new Set(spec.modules.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
    : null
  const sourceMode: ModuleSourceMode = Array.isArray(spec.modules)
    ? 'explicit'
    : typeof spec.composition === 'string' && spec.composition.trim().length > 0
      ? 'composition'
      : 'unknown'
  const effectiveModules = sourceMode === 'explicit'
    ? [...(declaredModules ?? [])]
    : null
  if (sourceMode === 'unknown') {
    return { declaredModules, effectiveModules: null, rowIds: [], disabledRows: [], sourceMode, editable: false }
  }

  let raw: string
  try {
    // 事实展示对重复声明采用稳定去重；真正写入/渲染路径仍由
    // assembleModules 拒绝重复项。这样 UI 不会因旧重复清单丢失全部事实。
    const factsSpec = sourceMode === 'explicit' && declaredModules !== null
      ? { ...spec, modules: declaredModules }
      : spec
    raw = loadCompositionText(factsSpec, resolveModuleParams(factsSpec, {}), templateDir)
  } catch {
    return { declaredModules, effectiveModules: null, rowIds: [], disabledRows: [], sourceMode: 'unknown', editable: false }
  }
  const rowIds: string[] = []
  const disabledRows: string[] = []
  const disabledSet = new Set<string>()
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
      if (rowDisabled(record.disabled) && !disabledSet.has(record.id)) {
        disabledSet.add(record.id)
        disabledRows.push(record.id)
      }
      if (record.config !== null && typeof record.config === 'object' && !Array.isArray(record.config)) {
        defaults.set(record.id, { ...(record.config as Record<string, unknown>) })
      }
    }
    for (const child of Object.values(record)) visit(child)
  }
  // YAML 解析失败按「未知」软失败；disabled 求值失败必须冒出来（不静默启用平台行）。
  let parsed: unknown
  try {
    parsed = parseYaml(raw, { logLevel: 'silent' })
  } catch {
    return { declaredModules, effectiveModules: null, rowIds: [], disabledRows: [], sourceMode: 'unknown', editable: false }
  }
  visit(parsed)
  // 隐式装配如实进入 effectiveModules（declaredModules 保持磁盘事实）：参数在 ⇒ 装配在，
  // customTools 非空同样隐含 tool-config-engine；disabled 行从运行集合剔除。
  if (effectiveModules !== null) {
    for (const module of impliedModulesForParams(resolveModuleParams(spec, {}), spec.moduleConfigs)) {
      if (!effectiveModules.includes(module)) effectiveModules.push(module)
    }
    if (rowIds.includes('rule-engine') && !effectiveModules.includes('rule-engine')) {
      effectiveModules.push('rule-engine')
    }
    if (Array.isArray(spec.customTools) && spec.customTools.length > 0 && !effectiveModules.includes('tool-config-engine')) {
      effectiveModules.push('tool-config-engine')
    }
    for (const id of disabledRows) {
      const index = effectiveModules.indexOf(id)
      if (index >= 0) effectiveModules.splice(index, 1)
    }
  }
  const effectiveConfigs: Record<string, Record<string, unknown>> = {}
  for (const [id, config] of defaults) effectiveConfigs[id] = config
  for (const [id, config] of Object.entries(spec.moduleConfigs ?? {})) {
    effectiveConfigs[id] = { ...effectiveConfigs[id], ...config }
  }
  const generated = buildModuleConfigsFromParams(resolveModuleParams(spec, {}))
  for (const [id, config] of Object.entries(generated)) {
    effectiveConfigs[id] = { ...effectiveConfigs[id], ...config }
  }
  return { declaredModules, effectiveModules, rowIds, disabledRows, sourceMode, editable: editable && sourceMode === 'explicit', effectiveConfigs }
}

/**
 * 读一个模块的身份与能力事实：**目录解析 → 定义读取 → 事实计算的唯一入口**。
 *
 * 三处消费点（桥的 `/meta`、`/describe`+`/bootstrap`、装配的准备期，以及能力写入）此前各自展开
 * 这三步，且各自决定 `editable` 传什么——这里收成一处，`editable` 由目录判据自判（判据 = 目录是否
 * 在用户模块根之下，不表示「这次操作可写」）。
 *
 * 不变量：
 * - **不 catch**：错误原样上抛，由调用方决定软硬（`/meta` 全吞成键缺席；`/describe`+`/bootstrap`
 *   把层设置/规则错误重抛、其余软失败；装配直接让它冒出来）。
 * - **不缓存**：事实每次现算。`loadModuleSpec` 那层缓存（键 = `module.yml` 绝对路径）已经覆盖读盘，
 *   再按目录缓存整个 facts 会掩盖组合文件与参数派生（它们不在那份缓存签名里）。
 * - `target` 接受模块 id 或**绝对目录**：调用方手里是端点已解析的目录时直接传它。
 *
 * 需要目录本身时调用方自己调 `resolveModuleDir`（纯路径函数）——返回值刻意只给事实，不摆实现细节。
 */
export function readModuleFacts(target: string, moduleRoot?: string): ModuleFacts {
  const dir = isAbsolute(target) ? target : resolveModuleDir(target, moduleRoot)
  const spec = loadModuleSpec(dir)
  return resolveModuleFacts(spec, dir, isEditableModuleDir(dir))
}

/**
 * 模块组合渲染完整链路:模块装配 → 参数桥(moduleConfigs + params)行级合并。
 * 合并优先级:参数桥(params/UI 基础层) > moduleConfigs(模板/ST 行级直写) > 行默认。
 * moduleConfigs 仅补充参数桥未覆盖的行级 config(如 ST 导入的 tool-web.fetch),
 * 不再锁定覆盖 UI 可管理参数(旧作者锁定语义已移除)。
 */
export function renderComposition(spec: ModuleSpec, runtime: Record<string, unknown>, templateDir?: string): string {
  const params = resolveModuleParams(spec, runtime)
  const merged: Record<string, Record<string, unknown>> = buildModuleConfigsFromParams(params)
  for (const [id, cfg] of Object.entries(spec.moduleConfigs ?? {})) {
    // 参数桥优先：UI/运行时参数不被模板或 ST 直写覆盖。
    merged[id] = { ...cfg, ...merged[id] }
  }
  // 文本层按**声明**装配：runtime 覆盖只进参数桥，不改模块清单——所以这里显式给空 runtime 的
  // 解析结果（旧实现把 runtime 传进 loadCompositionText 但内部同样用空 runtime，行为不变）。
  const raw = loadCompositionText(spec, resolveModuleParams(spec, {}), templateDir)
  // 人设由注册前适配器按 Agent 配装，不再生成另一份官方 persona 行。
  readPersonaSpec(spec.persona)
  return applyModuleConfigs(raw, merged)
}
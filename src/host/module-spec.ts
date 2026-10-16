/**
 * module.yml 的加载：把单个模块定义读成 `ModuleSpec`（按 mtime+size 签名缓存），
 * 并把存储根的全局层引擎参数作为兜底输入挂上（`globalParams`）。从原 `manifest.ts` 按簇拆出。
 */
import { basename, join, resolve, sep } from 'node:path'
import { MODULE_DEFINITION_FILE } from './paths.ts'
import { readPersonaSpec } from '../shared/persona-section.ts'
import type { PersonaSpec } from '../shared/persona-section.ts'
import type { RuleDefinition } from '../shared/rules.ts'
import { enabledModuleIds, readGlobalLayerSettingsSafe } from './config-store.ts'
import { ensureModuleSlices } from './module-slices.ts'
import { readModuleLayerSettings } from './module-layer-settings.ts'
import { packageModulesDir, userModulesDir } from './module-dirs.ts'

export interface ModuleSpec {
  id: string
  name: string
  /** 官方预设列表顺序；省略时由宿主排序。 */
  order?: number
  /** 预设说明（官方用户预设格式元数据；列表展示用，可选）。 */
  description?: string
  version: string
  engineCompat: string
  meta?: Record<string, unknown>
  content?: { presetText?: string; agentsText?: string }
  /** 模块清单(参数文件决定组合内容):按序装配 source/local 与 library 中的唯一模块。 */
  modules?: string[]
  /** 手写组合：内联文本或组合清单名。 */
  composition?: string
  /** 内部运行时平铺适配面；磁盘上的同名段不参与运行参数。 */
  params?: Record<string, unknown>
  /** 共享引擎参数按编辑组的主归属插入点存储；规则实例仍拥有各自 params。 */
  layerSettings?: Record<string, Record<string, unknown>>
  /**
   * **全局层**引擎参数（存储根 `config.yml` 的 `layerSettings`，由 `loadModuleSpec` 读入）。
   *
   * 只作 `resolveModuleParams` 的兜底输入，**不并入 `params`**：`params` 是「这个模块显式写了
   * 哪些键」的事实，UI 读回与声明面判据都靠它；并进来会让「未声明」看起来像「已声明」。
   * 优先级（用户裁定 2026-10-12）：模块显式键（`false` 也算）＞ 全局键 ＞ 引擎/行默认。
   */
  globalParams?: Record<string, unknown>
  /** 独立人设卡，按主会话与子代理逐字段覆盖官方声明。 */
  persona?: PersonaSpec
  /** 模块级模板变量（{{key}} 插值源；与 layerSettings 分离，顶层 variables 段）。 */
  variables?: Record<string, string>
  /** 自定义工具定义（tool-config-engine 渲染进 custom-tools/ 后运行时注册）。 */
  customTools?: unknown[]
  /** @deprecated 旧导入形状；未注册字段按白名单过滤，不参与执行。 */
  triggers?: unknown[]
  /** 模板变量插值开关（缺省 true = 启用；false = 停用，writeModule 不生成变量文件）。 */
  variablesEnabled?: boolean
  /** 上下文激活的模块递归开关，缺省 false。 */
  contextActivationRecursive?: boolean
  /** @deprecated 旧导入形状；未注册字段按白名单过滤，不参与执行。 */
  promptConfigs?: unknown[]
  /** 配置卡的持久文件序号；跨模块UI排序只改此轻量元数据。 */
  configOrder?: Record<string, number>
  /** 模块唯一的条件→动作定义；旧 `triggers` 声明不再被读取。 */
  rules?: RuleDefinition[]
  /** 可选:引擎组合模块行参数直写(行级 map config 浅合并;参数桥未覆盖的键生效,参数桥优先)。 */
  moduleConfigs?: Record<string, Record<string, unknown>>
  upstream?: Record<string, unknown>
}
/**
 * module.yml 读缓存：按 mtime+size 签名失效。load()/describe/param-overrides 等
 * 每次请求读盘解析，加缓存后同一文件只解析一次；写盘路径（saveModuleParams /
 * withModuleDefinition）与外部编辑（stat 签名变化）都会正确失效。
 */
const moduleSpecCache = new Map<string, { revision: string; spec: ModuleSpec }>()

/** 写盘后失效缓存（调用方在写完 module.yml 后调用；不调用也安全——stat 签名兜底）。 */
export function invalidateModuleSpec(dir: string): void {
  moduleSpecCache.delete(join(dir, MODULE_DEFINITION_FILE))
}
/**
 * 把存储根的全局层挂到这个模块上（`resolveModuleParams` 的兜底输入）。
 *
 * 认两处目录：① 用户模块根下的目录；② **用户在启用表里声明过的 id**、但用户目录已被删、
 * `resolveModuleDir` 回落到包内同名模板的情形——否则「模块未声明 ⇒ 回退全局」对它静默失效。
 * 包内模板（如 `blank` 内存模板）**不继承**全局层：克隆/导入时会把全局值烘进新模块定义。
 *
 * 读是**软失败**（`readGlobalLayerSettingsSafe`）：全局层坏掉只让这个模块按「无全局层」装配，
 * 绝不因为一个笔误打掉 `prepareAssembly`；诊断由 `/meta` 的 `moduleWarnings` 给出。
 */
function withGlobalParams(spec: ModuleSpec, dir: string): ModuleSpec {
  const inUserRoot = resolve(dir).startsWith(resolve(userModulesDir()) + sep)
  if (!inUserRoot && !enabledModuleIds(userModulesDir()).includes(spec.id)) return spec
  const { params } = readGlobalLayerSettingsSafe(userModulesDir())
  if (Object.keys(params).length === 0) return spec
  return { ...spec, globalParams: params }
}

/** 加载某个模块模板的单一参数文件 modules/<name>/module.yml。 */
export function loadModuleSpec(dir: string): ModuleSpec {
  // 完整性检查先于缓存；mtime/size 不能掩盖手改切片或伪造清单。
  const snapshot = ensureModuleSlices(dir, { writable: !resolve(dir).startsWith(resolve(packageModulesDir()) + sep) })
  readPersonaSpec(snapshot.source.persona)
  const cached = moduleSpecCache.get(snapshot.file)
  if (cached?.revision === snapshot.revision) return withGlobalParams(structuredClone(cached.spec), dir)
  const parsed = { ...snapshot.source, id: snapshot.source.id ?? basename(dir), rules: snapshot.rules,
    configOrder: snapshot.configOrder, variables: snapshot.variables, variablesEnabled: snapshot.variablesEnabled } as unknown as ModuleSpec
  const params = readModuleLayerSettings(parsed)
  if (parsed.layerSettings !== undefined || parsed.params !== undefined) parsed.params = params
  // 缓存只存 module.yml 的事实：全局层每次现读，config.yml 改动不靠签名也能立即生效。
  moduleSpecCache.set(snapshot.file, { revision: snapshot.revision, spec: structuredClone(parsed) })
  return withGlobalParams(parsed, dir)
}

export const asString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return fallback
  return String(value)
}
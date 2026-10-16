/**
 * 桥运行态：一次 `registerSettingsBridge` 的共享态与共享 helper 只在这里建一次。
 *
 * 域文件（`routes/*.ts`）只写端点自己的业务判断；注册通道、descriptor 缓存、上传暂存、
 * 两条串行队列（能力 / 排序）、变量开关待发布表、change 回调，以及 meta/describe 聚合、
 * 指令作用域解析、导入参数校验这些跨域基建全从这里取，域里不自建状态。
 *
 * 两个注入域（`settings+webServer` 与 `agents+tools+webServer`）共用同一个运行时：
 * 作用域由 `attachSettingsScope`／`attachAgentScope` 在各自的 `ctx.inject` 回调里挂上，
 * **先挂作用域、再注册端点**——handler 只可能在挂上之后被调用。
 */
import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { SkillRegistry, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { PARAM_KEYS, readModulesEnabled } from '../config.ts'
import { peekModelCatalog, type ModelDetection } from './models.ts'
import type { SkillCatalogEntry, SkillPolicyChange, SkillsCatalogSnapshot } from '../shared/skills.ts'
import type { SkillsStateRead } from '../host/skills-config.ts'
import type { SkillPolicyWrite } from '../host/skills-policy.ts'
import type { SkillContentResult } from '../host/skills-content.ts'
import type { SkillActionResult } from '../host/skills-actions.ts'
import { enabledModuleIds, readGlobalLayerSettingsSafe } from '../host/config-store.ts'
import { ModuleConfigOrderError } from '../host/module-config-order.ts'
import { isEditableModuleDir, packageEngineDir, resolveModuleDir, userModulesDir } from '../host/module-dirs.ts'
import { readOfficialOrderSegments, type OfficialOrderLookup } from '../shared/official-orders.ts'
import { ModuleLayerSettingsError } from '../host/module-layer-settings.ts'
import { listBuiltinTemplates, listModules } from '../host/module-catalog.ts'
import { moduleDeclarations } from '../host/module-declarations.ts'
import { ModuleWriteError } from '../host/module-write.ts'
import { loadModuleSpec } from '../host/module-spec.ts'
import { readModuleFacts, resolveModuleParams } from '../host/module-params.ts'
import { readModuleVariables } from '../host/module-variables.ts'
import { createAssetSources } from '../host/asset-sources.ts'
import { modulePathExists } from '../host/module-install.ts'
import { storageRoot } from '../host/paths.ts'
import type { AssetFile, AssetImportRequest, ImportKind } from '../shared/asset-transfer.ts'
import { moduleParamFallbacks } from '../shared/engine-params.ts'
import { ENGINE_EDITOR_GROUP_MAP, type ModuleFacts } from '../shared/engine-capabilities.ts'
import { isModuleId } from '../shared/module-ids.ts'
import { withGlobalSkillFallback, withSkillWinners } from '../host/skills-scan.ts'
import {
  agentsFileCardSpecs,
  agentsFileId,
  detectAgentsFiles,
  readAgentsFileSnapshot,
  type AgentsFileCard,
} from '../host/agents-cards.ts'
import type { InstructionContextView, InstructionFileSnapshot, InstructionsOwnerView } from '../shared/instructions.ts'
import type { ModuleVariablesSnapshot } from '../shared/module-variables.ts'
import {
  bridgeTransaction,
  type BridgeRouteSpec,
  type BridgeTransaction,
} from './bridge-transaction.ts'
import { gateFor, type GateHandle } from './module-subject-gate.ts'
import {
  EDIT_TARGET_HEADER,
  MODULE_ACTIVATION_FAILED,
  MODULE_IDENTITY_INVALID,
  SETTINGS_BRIDGE_PREFIX,
  readSubjectHeader,
  type BridgeEndpointKey,
  type BridgeSessionExtras,
  type EngineMetaLayerContract,
} from '../shared/bridge-contract.ts'

export interface SkillsBridgeState {
  /** 用户技能根（技能实体的落点）。 */
  skillsRoot: string
  /** 用户添加的技能文件夹（只引用，不复制）。 */
  folders: string[]
  /** 技能清单：按会话工作区扫描官方六类技能根，调用策略取自各技能文件的 frontmatter。 */
  listSkills: (cwd?: string) => SkillCatalogEntry[]
  snapshot?: (options: SkillViewOptions) => Promise<SkillsCatalogSnapshot>
  /** 单端写入只提交本端意图；路径必须命中当前来源白名单。 */
  setSkillPolicy: (name: string, path: string, change: SkillPolicyChange, cwd?: string) => SkillPolicyWrite
  readSkillContent: (name: string, path: string, cwd?: string) => SkillContentResult
  writeSkillContent: (name: string, path: string, content: string, description: string, expectedRevision: string, cwd?: string) => SkillContentResult
  deleteSkill: (name: string, path: string, cwd?: string) => SkillActionResult
  /** 添加 / 移除引用的技能文件夹。 */
  patchSkillFolders: (folders: string[]) => SkillsStateRead | Promise<SkillsStateRead>
}

/** 自建 loopback settings bridge：替代 registerConfigurableProviders，避免模型设置区出现插件条目。 */
/**
 * 桥的宿主依赖面：`registerSettingsBridge` 需要宿主提供的全部能力都在这里，
 * 不再靠位置对齐（此前 11 个位置参数里 8 个可选，测试必须数逗号跳过前项）。
 *
 * 除 `ns`／`models`／`skills` 外其余都是可选的晚到能力：缺哪个就少哪一类端点的效果，
 * 不影响其余端点注册。
 */
export interface BridgeDeps {
  /** settings namespace；宿主 `settings.describe()` 按它定位本插件目录。 */
  ns: string
  /** 当前模型探测结果（/meta 与 /bootstrap 的模型能力事实）。 */
  models: () => ModelDetection
  /** 技能运行态：技能根、引用目录、清单与策略写入。 */
  skills: () => SkillsBridgeState
  /**
   * 请求声明的编辑目标（`x-module-id` 头解析而来）：`ok` 定位那个模块，未声明 = 无目标
   * （由 handler 按策略拒绝），不再由 host 回退启用表首项。编辑器因此不必依赖某个全局单选
   * ——配置卡自己的模块身份决定写哪里。
   */
  moduleDirectory?: (moduleId?: string) => string
  /** 参数写入后重建指定模块；省略身份表示启用表变化，刷新全部运行实例。 */
  overridesChanged?: (moduleId?: string) => void | Promise<void>
  /** 模块已完整安装后的刷新回调；失败返回未生效诊断，不再物化或撤销安装。 */
  moduleInstalled?: (id: string) => void | Promise<void>
  /** 能力/recipe 提交后刷新回调；失败保留已提交定义并明确报告。 */
  capabilityChanged?: (moduleId?: string) => void | Promise<void>
  /** 新建、复制或删除模块后重建当前模块。 */
  moduleListChanged?: (id: string) => void | Promise<void>
  /** 技能策略写入后的目录刷新回调。 */
  afterSkillsChange?: () => void
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 写一次响应；事务的 `tx.write` 与门内判据共用这一个形态。 */
export type BridgeWrite = (status: number, body: unknown) => void

/**
 * 解析请求体里的可选 sessionId：缺失/undefined 合法（= 无本地会话），
 * 类型错误或超长报错，避免「静默按无会话处理」把工作区读成另一份。
 */
export function readSessionIdField(body: unknown): { ok: true; sessionId?: string } | { ok: false; message: string } {
  if (body === undefined || body === null) return { ok: true }
  if (!isRecord(body)) return { ok: false, message: 'body must be an object' }
  const value = body.sessionId
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'string') return { ok: false, message: 'sessionId must be a string' }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: true }
  if (trimmed.length > 256) return { ok: false, message: 'sessionId 长度不能超过 256' }
  return { ok: true, sessionId: trimmed }
}

/** SHA-256 摘要（十六进制）：预览凭据字段的唯一合法形状。 */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/i
/** promptOrderCharacterId 上界：ST character_id 实际很短，超长一律按非法输入拒绝。 */
export const MAX_ORDER_CHARACTER_ID_LENGTH = 128

/**
 * 导入请求字段白名单：与契约**双向绑定**。
 *
 * `Record<keyof AssetImportRequest, true>` 让两个方向都在编译期受控：白名单里多一个键、
 * 或契约（含它所继承的 `ImportChoices`）新增/改名一个字段，`typecheck` 都会失败。
 * 原先是手写字面量数组，与 `AssetImportRequest` 之间只有人眼维持一致。
 */
const IMPORT_REQUEST_FIELDS: Record<keyof AssetImportRequest, true> = {
  files: true,
  sourceId: true,
  preview: true,
  expectedSourceDigest: true,
  expectedPreviewRevision: true,
  targetId: true,
  targetName: true,
  overwrite: true,
  sourceKind: true,
  promptOrderCharacterId: true,
}

/** 导入端点（模块包 / 角色卡）的入口参数。 */
export interface ImportRequestParams extends AssetImportRequest {
  /** 省略 / false = 显式提交；true = 只读预览（不落盘）。 */
  preview: boolean
  expectedSourceDigest?: string
  /** 预览返回的版本凭据：绑定文件、选组、转换器与目标身份，服务端提交时重算。 */
  expectedPreviewRevision?: string
  promptOrderCharacterId?: string
}

/**
 * 解析导入请求参数：严格区分「缺省」与「非法类型」，不做 truthy 转换。
 * 字符串 "true"、数值、null、数组、对象都是错误请求，必须在 mkdir / rename /
 * 写文件 / 备份 / rebuild 之前以 400 拒绝——预览参数不是权限凭证，也不能靠类型
 * 静默回落成"直接写入"。
 */
export function readImportRequestParams(record: Record<string, unknown>):
  | { ok: true; params: ImportRequestParams }
  | { ok: false; message: string } {
  const allowed = new Set(Object.keys(IMPORT_REQUEST_FIELDS))
  if (Object.keys(record).some((key) => !allowed.has(key))) return { ok: false, message: '导入请求包含未知字段' }
  if ((record.files === undefined) === (record.sourceId === undefined)) return { ok: false, message: 'files 与 sourceId 必须且只能提供一个' }
  if (record.sourceId !== undefined && (typeof record.sourceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.sourceId))) return { ok: false, message: 'sourceId 必须是有效上传来源标识' }
  if (record.overwrite !== undefined && typeof record.overwrite !== 'boolean') return { ok: false, message: 'overwrite 必须是布尔值' }
  if (record.targetId !== undefined && (typeof record.targetId !== 'string' || record.targetId.length > 128 || !isModuleId(record.targetId))) return { ok: false, message: 'targetId 必须是合法小写模块 ID（最多 128 字符）' }
  if (record.targetName !== undefined && (typeof record.targetName !== 'string' || record.targetName.trim().length === 0 || record.targetName.length > 256)) return { ok: false, message: 'targetName 必须是 1–256 字符的非空字符串' }
  const kinds: ImportKind[] = ['native-preset', 'native-character', 'st-preset', 'st-character', 'world-book']
  if (record.sourceKind !== undefined && !kinds.includes(record.sourceKind as ImportKind)) return { ok: false, message: 'sourceKind 不是支持的内容类型' }
  const preview = record.preview
  if (preview !== undefined && typeof preview !== 'boolean') {
    return { ok: false, message: 'preview 必须是布尔值（省略或 false = 提交，true = 只读预览）' }
  }
  const digest = record.expectedSourceDigest
  if (digest !== undefined && (typeof digest !== 'string' || !SHA256_HEX_RE.test(digest))) {
    return { ok: false, message: 'expectedSourceDigest 必须是 SHA-256 十六进制摘要' }
  }
  const characterId = record.promptOrderCharacterId
  if (characterId !== undefined
    && (typeof characterId !== 'string' || characterId.length === 0 || characterId.length > MAX_ORDER_CHARACTER_ID_LENGTH)) {
    return { ok: false, message: `promptOrderCharacterId 必须是 1–${MAX_ORDER_CHARACTER_ID_LENGTH} 字符的非空字符串` }
  }
  const revision = record.expectedPreviewRevision
  if (revision !== undefined && (typeof revision !== 'string' || !SHA256_HEX_RE.test(revision))) {
    return { ok: false, message: 'expectedPreviewRevision 必须是 SHA-256 十六进制摘要' }
  }
  return {
    ok: true,
    params: {
      preview: preview === true,
      ...(record.sourceId === undefined ? {} : { sourceId: record.sourceId as string }),
      ...(record.targetId === undefined ? {} : { targetId: record.targetId as string }),
      ...(record.targetName === undefined ? {} : { targetName: record.targetName as string }),
      ...(record.overwrite === undefined ? {} : { overwrite: record.overwrite as boolean }),
      ...(record.sourceKind === undefined ? {} : { sourceKind: record.sourceKind as ImportKind }),
      ...(digest === undefined ? {} : { expectedSourceDigest: digest as string }),
      ...(revision === undefined ? {} : { expectedPreviewRevision: revision as string }),
      ...(characterId === undefined ? {} : { promptOrderCharacterId: characterId as string }),
    },
  }
}

/** 上传条目容器：缺失 = 空；不是数组或含非对象条目一律 fail closed。 */
export function readBridgeFiles(files: unknown): AssetFile[] {
  if (!Array.isArray(files) || files.length === 0) throw new Error('files 必须是非空数组')
  const entries: AssetFile[] = []
  for (const entry of files) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.content !== 'string'
      || (entry.encoding !== undefined && entry.encoding !== 'utf8' && entry.encoding !== 'base64')
      || Object.keys(entry).some((key) => !['path', 'content', 'encoding'].includes(key))) throw new Error('files 条目必须包含字符串 path/content 及合法 encoding')
    entries.push({ path: entry.path, content: entry.content, ...(entry.encoding === undefined ? {} : { encoding: entry.encoding }) })
  }
  return entries
}

/** 存活本地 Agent 的会话 cwd；无 agents 服务 / 未知 session / 无 cwd 时返回 undefined（不猜）。 */
export function localAgentCwd(ctx: Context, sessionId: string): string | undefined {
  const agents = (ctx as Context & { get?: (name: string) => unknown }).get?.('agents') as
    | { get?: (id: string) => unknown }
    | undefined
  const agent = agents?.get?.(sessionId) as { session?: { header?: { cwd?: unknown } } } | undefined
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** 只识别插件保留的生成卡 ID（旧版 8 位 / 当前 16 位）；params.file 不是来源凭据。 */
const isFileCardSpec = (card: unknown): card is Record<string, unknown> & { params: Record<string, unknown> } => {
  if (!isRecord(card) || typeof card.id !== 'string' || !/^agents-file-(?:[0-9a-f]{8}|[0-9a-f]{16})$/.test(card.id)) return false
  const params = card.params
  return isRecord(params) && typeof params.file === 'string' && params.file.length > 0
}

/** 生成卡上的文件身份：优先 params.fileId，缺失时按路径派生（与新探测同源）。 */
const cardFileId = (card: Record<string, unknown> & { params: Record<string, unknown> }): string =>
  typeof card.params.fileId === 'string' && card.params.fileId.length > 0
    ? card.params.fileId
    : agentsFileId(card.params.file as string)

/** 文件卡视图：正文/版本/读取状态来自本次一致读取，策略字段保留生成卡上的值。 */
function withSnapshot(
  card: Record<string, unknown> & { params: Record<string, unknown> },
  file: InstructionFileSnapshot,
): Record<string, unknown> {
  return {
    ...card,
    params: {
      ...card.params,
      scope: file.scope,
      file: file.path,
      displayPath: file.displayPath,
      fileId: file.fileId,
      revision: file.revision,
      readStatus: file.status,
      ...(file.message === undefined ? {} : { readMessage: file.message }),
      text: file.text,
    },
  }
}

/**
 * 两类卡合并：模块卡原样保留，文件卡换成本次工作区的文件快照。
 * 生成目录里属于其他工作区的文件卡不再展示（写盘白名单也不含它们）；
 * 当前工作区里没有对应生成卡的文件按默认文件卡补齐。
 */
export function mergeInstructionCards(
  moduleCards: readonly unknown[],
  files: readonly InstructionFileSnapshot[],
): unknown[] {
  const byId = new Map(files.map((file) => [file.fileId, file]))
  const kept: unknown[] = []
  for (const card of moduleCards) {
    if (!isFileCardSpec(card)) {
      kept.push(card)
      continue
    }
    const file = byId.get(cardFileId(card))
    if (file !== undefined) kept.push(withSnapshot(card, file))
  }
  const present = new Set(kept.filter(isFileCardSpec).map((card) => cardFileId(card)))
  const defaults = agentsFileCardSpecs(files)
  files.forEach((file, index) => {
    if (present.has(file.fileId)) return
    const fallback = defaults[index]
    if (fallback !== undefined) kept.push(withSnapshot(fallback as unknown as Record<string, unknown> & { params: Record<string, unknown> }, file))
  })
  return kept
}

/** 本次请求的指令文件读取范围（正文真相源：探测到的工作区文件）。 */
export interface ResolvedInstructionScope {
  context: InstructionContextView
  cards: AgentsFileCard[]
  files: InstructionFileSnapshot[]
}

/**
 * 负责人事实：全仓没有写 `true` 的生产者，载荷恒为 null——「官方未装配」是插件观察不到的
 * 否定事实，不猜也不捏造 false（见 ADR-0009）。
 */
export function instructionOwner(): InstructionsOwnerView {
  return { officialInstructions: null }
}

export async function resolveInstructionScope(ctx: Context, sessionId: string | undefined): Promise<ResolvedInstructionScope> {
  // 读放宽、写不放宽：拿不到会话工作区时按官方 agent-instructions 的口径回退到
  // 部署进程 cwd，并如实标记来源；写通道白名单仍只由本次探测到的文件构成，
  // 回退不扩大可写范围。
  let sessionCwd = sessionId === undefined ? undefined : localAgentCwd(ctx, sessionId)
  if (sessionCwd === undefined && sessionId !== undefined) {
    // 浏览历史会话不会创建 Agent；只读官方元数据即可恢复它的工作区。
    const persistence = ctx.get?.('sessionPersistence') as {
      stat(id: string): Promise<{ header: { cwd?: unknown } } | undefined>
    } | undefined
    const storedCwd = (await persistence?.stat(sessionId))?.header.cwd
    if (typeof storedCwd === 'string' && storedCwd.length > 0) sessionCwd = storedCwd
  }
  const cwd = sessionCwd ?? process.cwd()
  const cards = detectAgentsFiles({ cwd })
  const contextId = createHash('sha256')
    .update([cwd, ...cards.map((card) => card.fileId)].join('\n'))
    .digest('hex')
    .slice(0, 16)
  return {
    context: { contextId, cwd, source: sessionCwd === undefined ? 'deploy-cwd' : 'session' },
    cards,
    files: cards.map(readAgentsFileSnapshot),
  }
}

const asRecord = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {}

/** 该模块目录的声明面（`module.yml` 顶层键名，与门的判据同源）。
 *  定义不可解析时返回 undefined＝**未知**：调用方照既有语义放行，绝不把「读不到」降级成「没声明」。
 *  `byModuleId` 为真时先按 id 解析目录（`listModules` 只给 id）。 */
export function declarationsOf(target: string, byModuleId = false): Set<string> | undefined {
  try {
    return moduleDeclarations(byModuleId ? resolveModuleDir(target) : target)
  } catch {
    return undefined
  }
}

/** 声明面准入：未知一律放行；明确下发时「任一节存在」即算已声明（与 `DECLARED_SECTIONS` 同口径）。 */
export const declaresAny = (declares: Set<string> | undefined, sections: readonly string[]): boolean =>
  declares === undefined || sections.some((section) => declares.has(section))

/** 下发给客户端的 5 键投影：`effectiveConfigs` 是服务端兜底输入，绝不出桥。 */
const moduleFactsView = (facts: ModuleFacts): ModuleFacts => ({
  declaredModules: facts.declaredModules,
  effectiveModules: facts.effectiveModules,
  rowIds: facts.rowIds,
  sourceMode: facts.sourceMode,
  editable: facts.editable,
})

/** 逐模块身份与能力事实：与 /bootstrap 的 `moduleFacts` 走同一条 `readModuleFacts` 链。
 *  模块损坏（定义不可解析等）或事实算不出时返回 undefined，绝不下发部分字段。 */
function moduleFactsOf(moduleId: string): ModuleFacts | undefined {
  try {
    return moduleFactsView(readModuleFacts(moduleId))
  } catch {
    return undefined
  }
}

/** 将 moduleConfigs/行默认投影为 UI 字段兜底；显式 params 永远优先。 */
function mergeModuleConfigFallbacks(params: Record<string, unknown>, facts: ModuleFacts): void {
  for (const [key, value] of Object.entries(moduleParamFallbacks(facts.effectiveConfigs ?? {}))) {
    if (!Object.hasOwn(params, key)) params[key] = value
  }
}

/** `createBridgeRuntime` 的入口参数：宿主 Context、依赖面与 settings namespace。 */
export interface BridgeRuntimeOptions {
  ctx: Context
  deps: BridgeDeps
  ns: string
}

/**
 * 串行队列：同一存储卷上的写入依次执行。两个使用者（能力提交 / 模块排序与启用）＝真 seam。
 * 链尾只吞掉自己的错误（否则一次失败会毒化后面的排队者），任务的拒绝仍原样返回给调用方。
 */
export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const started = tail.then(task)
      tail = started.then(() => undefined, () => undefined)
      return started
    },
  }
}

/** 桥运行态：域文件从这里取全部共享态与共享 helper。 */
export interface BridgeRuntime {
  /** 宿主依赖面（provider 与刷新回调）。 */
  readonly deps: BridgeDeps
  /** settings namespace（`settings.mutate` 用）。 */
  readonly ns: string
  /** settings+webServer 注入域（`attachSettingsScope` 之后有效）。 */
  readonly scope: Context
  /** agents+tools+webServer 注入域（`attachAgentScope` 之后有效），诊断端点读 agents/tools 用。 */
  readonly agentScope: Context
  /** 绑上 settings 域（在它的 `ctx.inject` 回调里调一次），建 descriptor 缓存与上传暂存；返回该域的 disposer。 */
  attachSettingsScope(scope: Context): () => void
  /** 绑上第二个注入域（在它的 `ctx.inject` 回调里调一次）。 */
  attachAgentScope(scope: Context): void
  /** 主注入域的注册点：路径 + 事务入口，返回 disposer。 */
  register(endpoint: string, spec: BridgeRouteSpec): () => void
  /** 第二个注入域的注册点：同一个事务入口，另一个作用域的 webServer；返回 disposer。 */
  registerAgentRoute(endpoint: string, spec: BridgeRouteSpec): () => void
  /** 过门：`inspect` = 读前闸（含声明面），`authorize` = 写前闸（复检）。 */
  gate(tx: BridgeTransaction, key: BridgeEndpointKey): GateHandle
  /** descriptor 缓存（30s TTL）：读、按目标投影、失效。 */
  readonly descriptor: {
    find(): SettingsDescriptor | undefined
    forTarget(descriptor: SettingsDescriptor, dir: string): SettingsDescriptor
    invalidate(): void
  }
  /** 上传暂存源（settings 域建，随该域销毁）。 */
  readonly assetSources: ReturnType<typeof createAssetSources>
  /** 能力/recipe 写入队列：同一存储卷上的变更串行。 */
  readonly capabilityQueue: SerialQueue
  /** 模块排序与启用共用的写入队列。 */
  readonly moduleOrderQueue: SerialQueue
  /** 变量开关待运行发布的模块（目录 → 上次失败原因）。 */
  readonly pendingVariableSettings: Map<string, string>
  /** 写盘已完成：等重建，失败立即返回统一错误。 */
  finishModuleChange(write: BridgeWrite, activate: () => void | Promise<void>): Promise<boolean>
  runOverridesChange(write: BridgeWrite, moduleId?: string): Promise<boolean>
  refreshModuleList(write: BridgeWrite, id: string): Promise<boolean>
  writeModuleOrderError(write: BridgeWrite, error: unknown): void
  loadEngineMeta(): Promise<Record<string, unknown> & EngineMetaLayerContract>
  collectSkills(sessionId?: string): Promise<SkillsCatalogSnapshot>
  collectDescribeExtras(activeDir: string, sessionId?: string): Promise<BridgeSessionExtras>
  readParamOverrides(dir: string): Record<string, unknown>
  variableView(dir: string): ModuleVariablesSnapshot
}

export function createBridgeRuntime(options: BridgeRuntimeOptions): BridgeRuntime {
  const { ctx, deps, ns } = options

  let scopeRef: Context | undefined
  let agentScopeRef: Context | undefined
  let uploads: ReturnType<typeof createAssetSources> | undefined
  let cachedDescriptor: SettingsDescriptor | undefined
  let cachedAt = 0
  const DESCRIPTOR_TTL_MS = 30_000
  /** 官方刻度取值失败只告警一次：本函数被 /meta 与 /bootstrap 共用，不能每次调用都刷屏。 */
  let warnedOfficialOrders = false
  // 值更新已由 owner 发布；只有开关的配装失败需要重试运行刷新。
  const pendingVariableSettings = new Map<string, string>()

  /** 作用域只在对应注入域挂上后可用；端点永远在挂上之后才注册。 */
  const attached = <T>(value: T | undefined, label: string): T => {
    if (value === undefined) throw new Error(`prompt-tool: ${label} scope is not attached`)
    return value
  }
  const settingsContext = (): Context => attached(scopeRef, 'settings')
  const agentContext = (): Context => attached(agentScopeRef, 'agents')

  const attachSettingsScope = (scope: Context): (() => void) => {
    scopeRef = scope
    // 重挂后按基线语义重查宿主：descriptor 缓存不跨作用域存活。
    cachedDescriptor = undefined
    cachedAt = 0
    // 上传暂存根归插件自己的状态目录（与 modules / config.yml 同级），不再平级散落在 DSH_HOME 下。
    const sources = createAssetSources(join(storageRoot(), 'uploads'))
    uploads = sources
    return sources.dispose
  }
  const attachAgentScope = (scope: Context): void => {
    agentScopeRef = scope
  }

  /** 写盘已完成：等待重建，失败立即返回统一错误，不覆盖持久化结果。 */
  const finishModuleChange = async (write: BridgeWrite, activate: () => void | Promise<void>): Promise<boolean> => {
    try {
      await activate()
      return true
    } catch (error) {
      write(500, { ok: false, code: MODULE_ACTIVATION_FAILED, message: `更改已保存，但模块未生效；请重试：${String(error)}` })
      return false
    }
  }
  const runOverridesChange = (write: BridgeWrite, moduleId?: string): Promise<boolean> => finishModuleChange(write, () => deps.overridesChanged?.(moduleId))
  const refreshModuleList = (write: BridgeWrite, id: string): Promise<boolean> => finishModuleChange(write, () => deps.moduleListChanged?.(id))
  const writeModuleOrderError = (write: BridgeWrite, error: unknown): void => {
    const status = error instanceof ModuleConfigOrderError ? error.status : 500
    const code = error instanceof ModuleConfigOrderError ? error.code : 'module-config-order-failed'
    write(status, { ok: false, code, message: String((error as Error)?.message ?? error) })
  }

  /**
   * 本次请求的主语头解析结果：每次调用重新解析。头**完全没有** = 未声明（无目标）；
   * 带了身份但形状非法 = `invalid`，由 `route` 显式拒绝，端点 handler 拿不到它。
   */
  const subjectHeader = (req: IncomingMessage): ReturnType<typeof readSubjectHeader> =>
    readSubjectHeader(req.headers[EDIT_TARGET_HEADER])
  /**
   * 本次请求的编辑目标目录：只按声明定位（未声明 → 空串，由 handler 决定是否拒绝），
   * 交给注入的实现解析。所有「读/写哪个模块的配置」都走这里，端点不再各自记一个全局目标。
   */
  const editDir = (req: IncomingMessage): string => {
    const subject = subjectHeader(req)
    return deps.moduleDirectory?.(subject.state === 'ok' ? subject.id : undefined) ?? ''
  }
  /**
   * 所有端点的唯一注册形态：边界（loopback/Origin、POST、32 MiB、JSON 形状）由事务统一完成，
   * `spec.handle` 只写业务判断。路径仍由各端点从 `BRIDGE_ENDPOINTS` 取。
   *
   * 主语头形状在事务边界**之后**判定：`invalid` 一律 400 并终止，与端点自身策略（required/optional/none）无关；
   * 放在 handler 内层是为了不把 403（非 loopback）/405（非 POST）挡在自守边界之前。
   */
  const route = (spec: BridgeRouteSpec): ReturnType<typeof bridgeTransaction> => bridgeTransaction({
    ...spec,
    handle: async (tx) => {
      if (subjectHeader(tx.req).state === 'invalid') {
        tx.write(400, {
          ok: false,
          code: MODULE_IDENTITY_INVALID,
          message: `请求头 ${EDIT_TARGET_HEADER} 的模块身份形状非法：只接受小写字母或数字开头、小写字母/数字/连字符组成、长度不超过 64 的模块 id`,
        })
        return
      }
      await spec.handle(tx)
    },
  }, { editDir })
  const register = (endpoint: string, spec: BridgeRouteSpec): (() => void) =>
    settingsContext().webServer.register({ kind: 'exact', path: SETTINGS_BRIDGE_PREFIX + endpoint, handler: route(spec) })
  const registerAgentRoute = (endpoint: string, spec: BridgeRouteSpec): (() => void) =>
    agentContext().webServer.register({ kind: 'exact', path: SETTINGS_BRIDGE_PREFIX + endpoint, handler: route(spec) })

  const findDescriptor = (): SettingsDescriptor | undefined => {
    const now = Date.now()
    if (cachedDescriptor !== undefined && now - cachedAt < DESCRIPTOR_TTL_MS) return cachedDescriptor
    cachedDescriptor = settingsContext().settings.describe({ redactSecrets: true })
      .find((entry) => String(entry.ns) === String(ns))
    cachedAt = now
    return cachedDescriptor
  }
  /** 已解析的编辑目标只投影到本次响应，不改宿主设置或缓存描述符。 */
  const descriptorForTarget = (descriptor: SettingsDescriptor, dir: string): SettingsDescriptor => {
    const value = { ...asRecord(descriptor.value) }
    value.modulesEnabled = readModulesEnabled(value)
    if (dir.length > 0) value.moduleId = basename(dir)
    return { ...descriptor, value }
  }
  /** mutate 成功后强制失效，下次 findDescriptor 重查宿主（响应必须带新 view）。 */
  const invalidateDescriptor = (): void => {
    cachedDescriptor = undefined
  }

  /** 引擎能力矩阵（meta 端点与 /bootstrap 共用）：动态 import 引擎 schema。
   *  `EngineMetaLayerContract` 是跨 `.mjs` 边界的断言：形状由 engine/schema.mjs 的 `getEngineMeta`
   *  保证，运行期由契约测试的字段清单与层序断言兜底（这里是唯一需要断言的地方）。 */
  const loadEngineMeta = async (): Promise<Record<string, unknown> & EngineMetaLayerContract> => {
    const engineMetaUrl = pathToFileURL(join(packageEngineDir(), 'schema.mjs'))
    const { getEngineMeta } = await import(engineMetaUrl.href) as {
      getEngineMeta: () => Record<string, unknown> & EngineMetaLayerContract
    }
    const meta = getEngineMeta() as Record<string, unknown> & EngineMetaLayerContract
    // 启用表是「参与运行时装配」的唯一事实来源；随每个模块下发，UI 的开关据此显示。
    const enabledSet = new Set(enabledModuleIds(userModulesDir()))
    // 模块的 broken 只来自本插件自己的 module.yml 解析结果（module-catalog.ts#listModules）。
    // 模块不进入官方 agentPresets 注册表，故不叠加官方 roster 的同名诊断——那会把
    // 「与某官方预设同名」误报成模块损坏，并据此禁用它的启用开关。
    // 逐模块事实与 /bootstrap 的 moduleFacts 同源：装配集合视图一次全局读即可，
    // 不必按模块逐个聚合读；算不出事实的模块 facts 缺席（broken 等），不影响整个响应。
    meta.modules = listModules().map((preset) => {
      const facts = moduleFactsOf(preset.id)
      const declares = declarationsOf(preset.id, true)
      return {
        ...preset,
        enabled: enabledSet.has(preset.id),
        ...(facts === undefined ? {} : { facts }),
        ...(declares === undefined ? {} : { declares: [...declares] }),
      }
    })
    meta.builtinTemplates = listBuiltinTemplates()
    const warnings: string[] = []
    if (modulePathExists(join(dirname(userModulesDir()), '.characters'))) {
      warnings.push('检测到旧 .characters 角色库；其内容尚未作为模块导入。请通过模块导入入口显式导入，旧目录不会自动迁移或删除。')
    }
    // 全局层（config.yml 的 layerSettings）解析失败是**可诊断软失败**：首屏与装配都照常，
    // 诊断随 /meta 与 /bootstrap 的 moduleWarnings 下发（模块页 role=alert 可见）。
    const globalLayerError = readGlobalLayerSettingsSafe(userModulesDir()).error
    if (globalLayerError !== undefined) {
      warnings.push(`全局层 layerSettings 解析失败，已按「无全局层」继续（指令卡的全局开关暂不可用）：${globalLayerError}`)
    }
    if (warnings.length > 0) meta.moduleWarnings = warnings
    // 编辑组主归属与引擎 meta 同源组合下发：layerOrder 由引擎 schema 提供（不另写层序清单），
    // editorGroups 来自共享契约。逐条挑白名单字段，避免将来给契约加字段就顺带泄漏到浏览器。
    meta.editorGroups = ENGINE_EDITOR_GROUP_MAP.map(({ id, displayLayer, relatedLayers, hook }) => ({
      id,
      displayLayer,
      ...(relatedLayers === undefined ? {} : { relatedLayers }),
      hook,
    }))
    // 官方装配刻度（B8 T4）：只下发**运行期求值**的区段边界，不抄任何数值（手抄数值正是
    // 版本漂移的来源）。任一档位取不到有限数（官方改名、方法缺失、服务降级）⇒ 整张表缺席
    // 并只告警一次；绝不下发部分区段——那样 UI 会展示一份看似完整、实则缺口的刻度。
    const systemPrompt = settingsContext().get?.('systemPrompt') as OfficialOrderLookup | undefined
    const officialOrders = systemPrompt === undefined ? undefined : readOfficialOrderSegments(systemPrompt)
    if (officialOrders === undefined) {
      if (!warnedOfficialOrders) {
        warnedOfficialOrders = true
        ctx.logger?.warn('prompt-tool: 无法读取官方装配档位（systemPrompt 服务缺失或档位名不匹配），本次不下发 order 刻度')
      }
    } else {
      meta.officialOrders = officialOrders
    }
    return meta
  }

  /** describe 运行时事实（describe 端点与 /bootstrap 共用）：检测状态、技能快照、
   *  宿主默认模型、模型目录缓存、激活模块参数。不触网（模型目录只读 10min 缓存）。 */
  const collectSkills = async (sessionId?: string): Promise<SkillsCatalogSnapshot> => {
    const cwd = sessionId === undefined ? undefined : localAgentCwd(settingsContext(), sessionId)
    const agents = settingsContext().get?.('agents') as { get?: (id: string) => { ctx?: Context } | undefined } | undefined
    const agent = sessionId === undefined ? undefined : agents?.get?.(sessionId)
    const scope = agent?.ctx === undefined ? undefined : scopeOf(agent.ctx)
    const state = deps.skills()
    try {
      if (state.snapshot !== undefined) return await state.snapshot({ cwd, scope })
      const entries = state.listSkills(cwd)
      const registry = (settingsContext().get?.('skills') ?? ctx.skills) as Pick<SkillRegistry, 'snapshot'> | undefined
      if (typeof registry?.snapshot !== 'function') return { skills: entries, complete: false }
      const view = scope === undefined
        ? await registry.snapshot({ cwd })
        : await withGlobalSkillFallback(await registry.snapshot({ cwd, scope }), () => registry.snapshot({ cwd }))
      return { skills: withSkillWinners(entries, view.skills), complete: view.complete }
    } catch (error) {
      ctx.logger?.warn(`prompt-tool: 无法读取技能注册表，暂不标注同名遮蔽：${String(error)}`)
      return { skills: withSkillWinners(state.listSkills(cwd), []), complete: false }
    }
  }
  const collectDescribeExtras = async (activeDir: string, sessionId?: string): Promise<BridgeSessionExtras> => {
    // 模块段的声明面快照：只对声明面登记的节按声明填（未声明的节不下发，客户端也就不会去读）。
    const declares = activeDir.length > 0 ? declarationsOf(activeDir) : undefined
    const detection = deps.models()
    const skillsState = deps.skills()
    const skillsSnapshot = await collectSkills(sessionId)
    // 宿主默认模型（agent-default-model settings：主对话新会话默认）：
    // 插件参数未设置（空 = 继承宿主）时回显给客户端（模型名下拉候选/状态行）。
    let hostDefaultModel: { provider?: string; model?: string; reasoningEffort?: string } | undefined
    try {
      const selection = settingsContext().settings.describe().find((entry) => String(entry.ns) === 'agent-default-model')?.value as
        { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined
      if (selection !== null && typeof selection === 'object') {
        const record = selection as Record<string, unknown>
        hostDefaultModel = {
          ...(typeof record.provider === 'string' && record.provider.length > 0 ? { provider: record.provider } : {}),
          ...(typeof record.model === 'string' && record.model.length > 0 ? { model: record.model } : {}),
          ...(typeof record.reasoningEffort === 'string' && record.reasoningEffort.length > 0
            ? { reasoningEffort: record.reasoningEffort }
            : {}),
        }
        if (Object.keys(hostDefaultModel).length === 0) hostDefaultModel = undefined
      }
    } catch {
      // 宿主未装配 agent-default-model 时忽略。
    }
    // 模型目录移出关键路径：/describe 只读缓存（未命中返回空），
    // 查询由独立 /models 端点触发（客户端惰性加载，不阻塞工作台）。
    // 目录缓存按当前 bridge Context 隔离：另一个插件实例/测试 Context 不共享结果。
    const modelCatalog = peekModelCatalog(settingsContext())
    // 引擎参数按模块存储：/describe 附带激活模块参数（settings 已不承载；
    // 客户端 fields 参数键由此合并，promptConfigs 仍以 /prompt-configs 实际配置为准）。
    // 空主语就没有模块段：不拿包内默认模块冒充当前模块，两个键整体缺席（不是空对象）。
    let moduleParams: Record<string, unknown> | undefined
    let moduleFacts: ModuleFacts | undefined
    // 当前模块模板消息批层（pre-step）配置数：UI 消息批层入口开关联动——
    // 模板无 pre-step 配置（layer 缺省即 pre-step）时开关关闭且禁编辑。
    let templatePreStepCount = 0
    if (activeDir.length > 0) {
      // 只对声明面登记的节按声明填：`moduleFacts` 是身份与引擎事实（不是 module.yml 的节），不受声明面影响。
      const paramsDeclared = declaresAny(declares, ['params', 'layerSettings'])
      if (paramsDeclared) moduleParams = {}
      try {
        // 聚合响应复用端点已解析的请求目录，与 overrides、配置卡和变量同源。
        const facts = readModuleFacts(activeDir)
        // 定义另读一次：参数解析与 pre-step 计数要的是**定义**而不是事实，且这次读走
        // `loadModuleSpec` 的缓存（键 = module.yml 绝对路径），不重复读盘。
        const spec = loadModuleSpec(activeDir)
        if (paramsDeclared) {
          moduleParams = resolveModuleParams(spec, {})
          mergeModuleConfigFallbacks(moduleParams, facts)
        }
        // effectiveConfigs 只用于服务端把已存在的 moduleConfigs 回显到已知字段；
        // 不把整份行级配置（可能含路径/未知字段）发送到浏览器。
        moduleFacts = moduleFactsView(facts)
        templatePreStepCount = (spec.rules ?? []).filter(rule => rule.layer === 'pre-step').length
      } catch (error) {
        if (error instanceof ModuleLayerSettingsError || error instanceof ModuleWriteError) throw error
        templatePreStepCount = 0
      }
    }
    return {
      moduleParams,
      moduleFacts,
      hostDefaultModel,
      templatePreStepCount,
      modelsAvailable: detection.available,
      providers: detection.providers,
      modelCatalog,
      modelsError: detection.error,
      activeSkillsDirs: [skillsState.skillsRoot],
      skillCatalog: skillsSnapshot.skills,
      skillsComplete: skillsSnapshot.complete,
      // 引用目录随 describe 下发。调用策略不再单独发一份：它已经逐条表达在 skillCatalog 的
      // modelInvocable / userInvocable 里（取自各技能文件的 frontmatter），重复下发只会制造第二个真相。
      skillFolders: skillsState.folders,
    }
  }

  /** 激活模块的引擎参数子集（/param-overrides 读取；module.yml 按 mtime 缓存）。 */
  const readParamOverrides = (dir: string): Record<string, unknown> => {
    try {
      const spec = loadModuleSpec(dir)
      const params: Record<string, unknown> = {}
      for (const key of PARAM_KEYS) {
        if (key === 'promptConfigs') continue
        if (spec.params !== null && typeof spec.params === 'object' && key in spec.params) {
          params[key] = spec.params[key]
        }
      }
      return params
    } catch (error) {
      if (error instanceof ModuleLayerSettingsError || error instanceof ModuleWriteError) throw error
      return {}
    }
  }

  const variableView = (dir: string): ModuleVariablesSnapshot => ({
    ...readModuleVariables(dir, { writable: isEditableModuleDir(dir) }),
    publicationPending: pendingVariableSettings.has(dir),
    ...(pendingVariableSettings.has(dir) ? { publicationError: pendingVariableSettings.get(dir)! } : {}),
  })

  return {
    deps,
    ns,
    get scope() { return settingsContext() },
    get agentScope() { return agentContext() },
    attachSettingsScope,
    attachAgentScope,
    register,
    registerAgentRoute,
    gate: gateFor,
    descriptor: { find: findDescriptor, forTarget: descriptorForTarget, invalidate: invalidateDescriptor },
    get assetSources() { return attached(uploads, 'settings') },
    capabilityQueue: createSerialQueue(),
    moduleOrderQueue: createSerialQueue(),
    pendingVariableSettings,
    finishModuleChange,
    runOverridesChange,
    refreshModuleList,
    writeModuleOrderError,
    loadEngineMeta,
    collectSkills,
    collectDescribeExtras,
    readParamOverrides,
    variableView,
  }
}

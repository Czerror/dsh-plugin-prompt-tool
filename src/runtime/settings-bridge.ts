/** 自建 loopback settings bridge：Web 设置页数据通道（提示词配置数组经此输出到 UI）。 */
import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { SkillRegistry, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { PARAM_KEYS } from '../config.ts'
import { invalidateModelCatalog, listAdvertisedModels, peekModelCatalog, refreshModelReasoning, type ModelDetection } from './models.ts'
import type { SkillCatalogEntry, SkillPolicyChange, SkillPolicyScope, SkillsCatalogSnapshot } from '../shared/skills.ts'
import { loadPromptConfigFiles } from '../host/prompt-configs.ts'
import { validatePromptConfigs } from './configs-validate.ts'
import { loadPromptTemplates, loadToolTemplates } from '../host/templates.ts'
import { assertImportableSource, importSkillsDirectory, importSkillsPackage } from '../host/skills-import.ts'
import { createSkill, type SkillActionResult } from '../host/skills-actions.ts'
import type { SkillPolicyWrite } from '../host/skills-policy.ts'
import {
  appendPresetModules,
  atomicWriteTextFile,
  cloneBuiltinPreset,
  createEngineCapabilityInPreset,
  duplicateUserPreset,
  listBuiltinTemplates,
  listPresets,
  loadPresetSpec,
  invalidatePresetSpec,
  openPresetLocation,
  packageEngineDir,
  removeEngineCapabilityFromPreset,
  removeUserPreset,
  resolvePresetParams,
  resolvePresetModuleFacts,
  resolvePresetDir,
  savePresetParams,
  savePresetPersona,
  userPresetsDir,
  withPresetDoc,
} from '../host/manifest.ts'
import {
  applyCharacterToPreset,
  charactersDir,
  deleteCharacterCard,
  importCharacterCard,
  listCharacterCards,
  removeCharacterFromPreset,
} from '../host/characters.ts'
import { previewCharacterCard } from '../host/characters.ts'
import { computePreviewRevision, directoryVersionOf } from '../host/preview-revision.ts'
import { createAssetSources } from '../host/asset-sources.ts'
import { expandPresetSource, exportPresetPackage, installPresetPackage, presetImportPreview } from '../host/preset-package.ts'
import { decodeAssetFile, prepareImport } from '../host/import-source.ts'
import { assertPresetDirectory, assertPresetId, canonicalPresetRoot, presetPathExists } from '../host/preset-install.ts'
import { DSH_HOME } from '../host/paths.ts'
import type { AssetFile, AssetImportRequest, ImportKind, PresetExportRequest } from '../shared/asset-transfer.ts'
import { lastWorldBookDiagnostics } from '../../engine/st-world-book.mjs'
import { BRIDGE_ENDPOINTS, MAX_BRIDGE_BODY_BYTES, SETTINGS_BRIDGE_PREFIX } from '../shared/bridge-contract.ts'
import type { ModelSyncResult } from '../shared/bridge-contract.ts'
import { moduleParamFallbacks, validateEngineParamValues } from '../shared/engine-params.ts'
import { readPersonaSpec } from '../shared/persona-section.ts'
import { SKILL_NAME_PATTERN, type SkillsStateRead } from '../host/skills-config.ts'
import { withGlobalSkillFallback, withSkillWinners } from '../host/skills-scan.ts'
import { DEFAULT_PRESET_ID } from '../shared/preset-ids.ts'
import type { PresetModuleFacts } from '../shared/engine-capabilities.ts'
import { validateCustomTools } from '../host/custom-tools.ts'
import {
  agentsFileCardSpecs,
  agentsFileId,
  detectAgentsFiles,
  readAgentsFileSnapshot,
  writeAgentsFileChecked,
  type AgentsFileCard,
} from '../host/agents-cards.ts'
import type { InstructionContextView, InstructionFileSnapshot, InstructionsOwnerView } from '../shared/instructions.ts'
import { instructionPolicyPath, readInstructionPolicy, writeInstructionPolicy } from '../host/instructions-policy.ts'
import { PRE_STEP_COORDINATOR_SERVICE } from './pre-step-coordinator.ts'


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
  deleteSkill: (name: string, path: string, cwd?: string) => SkillActionResult
  /** 添加 / 移除引用的技能文件夹。 */
  patchSkillFolders: (folders: string[]) => SkillsStateRead | Promise<SkillsStateRead>
}

/** 仅允许本机回环请求，镜像官方 settings bridge 的边界。 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    const hostname = new URL('http://' + host).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
  } catch {
    return false
  }
  // 浏览器跨站盲请求（字符串 body 的 POST 是 CORS 简单请求，text/plain 不触发预检）
  // 可绕过上面的 socket/Host 检查直接到达本桥；校验 Origin 拦截跨站来源。
  // 非浏览器客户端（curl 等）不带 Origin，放行。
  // 完整校验 scheme/host/port：Origin 必须与本桥自身的 Host 头端口一致，
  // 防「本地其他端口服务」伪造 loopback hostname 跨站（仅比 hostname 不够）。
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      const originUrl = new URL(origin)
      if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false
      const originHost = originUrl.hostname
      if (originHost !== '127.0.0.1' && originHost !== 'localhost' && originHost !== '[::1]') return false
      const originPort = originUrl.port.length > 0 ? originUrl.port : (originUrl.protocol === 'https:' ? '443' : '80')
      const hostUrl = new URL('http://' + host)
      const hostPort = hostUrl.port.length > 0 ? hostUrl.port : '80'
      if (originPort !== hostPort) return false
    } catch {
      return false
    }
  }
  return true
}

function writeBridgeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 确认名单只授权已展示的目录；不是允许覆盖任意同名目标的总开关。 */
function readSkillOverwrite(value: unknown): string[] | undefined {
  if (value === undefined) return []
  return Array.isArray(value) && value.length <= 10_000
    && value.every((name) => typeof name === 'string' && SKILL_NAME_PATTERN.test(name))
    ? [...new Set(value as string[])] : undefined
}

/**
 * 解析请求体里的可选 sessionId：缺失/undefined 合法（= 无本地会话），
 * 类型错误或超长报错，避免「静默按无会话处理」把工作区读成另一份。
 */
function readSessionIdField(body: unknown): { ok: true; sessionId?: string } | { ok: false; message: string } {
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
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i
/** promptOrderCharacterId 上界：ST character_id 实际很短，超长一律按非法输入拒绝。 */
const MAX_ORDER_CHARACTER_ID_LENGTH = 128

/** 导入端点（预设包 / 角色卡）的入口参数。 */
interface ImportRequestParams extends AssetImportRequest {
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
function readImportRequestParams(record: Record<string, unknown>):
  | { ok: true; params: ImportRequestParams }
  | { ok: false; message: string } {
  const allowed = new Set(['preview', 'files', 'sourceId', 'expectedSourceDigest', 'expectedPreviewRevision', 'promptOrderCharacterId', 'targetId', 'targetName', 'overwrite', 'sourceKind'])
  if (Object.keys(record).some((key) => !allowed.has(key))) return { ok: false, message: '导入请求包含未知字段' }
  if ((record.files === undefined) === (record.sourceId === undefined)) return { ok: false, message: 'files 与 sourceId 必须且只能提供一个' }
  if (record.sourceId !== undefined && (typeof record.sourceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.sourceId))) return { ok: false, message: 'sourceId 必须是有效上传来源标识' }
  if (record.overwrite !== undefined && typeof record.overwrite !== 'boolean') return { ok: false, message: 'overwrite 必须是布尔值' }
  if (record.targetId !== undefined && (typeof record.targetId !== 'string' || record.targetId.length > 128 || !/^[a-z0-9][a-z0-9-]*$/.test(record.targetId))) return { ok: false, message: 'targetId 必须是合法小写预设 ID（最多 128 字符）' }
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
function readBridgeFiles(files: unknown): AssetFile[] {
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
function localAgentCwd(ctx: Context, sessionId: string): string | undefined {
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
 * 两类卡合并：预设卡原样保留，文件卡换成本次工作区的文件快照。
 * 生成目录里属于其他工作区的文件卡不再展示（写盘白名单也不含它们）；
 * 当前工作区里没有对应生成卡的文件按默认文件卡补齐。
 */
export function mergeInstructionCards(
  presetCards: readonly unknown[],
  files: readonly InstructionFileSnapshot[],
): unknown[] {
  const byId = new Map(files.map((file) => [file.fileId, file]))
  const kept: unknown[] = []
  for (const card of presetCards) {
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
interface ResolvedInstructionScope {
  context: InstructionContextView
  cards: AgentsFileCard[]
  files: InstructionFileSnapshot[]
}

/**
 * 负责人事实：pre-step 协调器观察到该会话实际装配仍挂着官方指令行时返回 true。
 * 没有协调服务或还没观察过（例如会话尚未跑过 pre-step）时返回 null——不猜。
 */
function instructionOwner(ctx: Context, sessionId: string | undefined): InstructionsOwnerView {
  if (sessionId === undefined) return { officialInstructions: null }
  const service = (ctx as Context & { get?: (name: string) => unknown }).get?.(PRE_STEP_COORDINATOR_SERVICE) as
    | { officialOwnerOf?: (id: string) => boolean | undefined }
    | undefined
  const observed = service?.officialOwnerOf?.(sessionId)
  return { officialInstructions: observed ?? null }
}

function resolveInstructionScope(ctx: Context, sessionId: string | undefined): ResolvedInstructionScope {
  // 读放宽、写不放宽：拿不到会话工作区时按官方 agent-instructions 的口径回退到
  // 部署进程 cwd，并如实标记来源；写通道白名单仍只由本次探测到的文件构成，
  // 回退不扩大可写范围。
  const sessionCwd = sessionId === undefined ? undefined : localAgentCwd(ctx, sessionId)
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

type ToolSchemaLike = { name?: unknown; description?: unknown }

/** 只投影模型可见的稳定摘要；不把完整 parameters/执行实现送进浏览器。 */
function projectToolSchemas(schemas: readonly ToolSchemaLike[]): Array<{ name: string; description: string }> {
  const unique = new Map<string, { name: string; description: string }>()
  for (const schema of schemas) {
    const name = typeof schema.name === 'string' ? schema.name.trim() : ''
    if (name.length === 0 || unique.has(name)) continue
    unique.set(name, {
      name,
      description: typeof schema.description === 'string' ? schema.description : '',
    })
  }
  return [...unique.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

function isEditablePresetDir(dir: string, presetRoot = userPresetsDir()): boolean {
  const root = resolve(presetRoot)
  const target = resolve(dir)
  return target !== root && target.startsWith(root + sep)
}

function guardEditablePresetDir(dir: string, res: ServerResponse): boolean {
  if (isEditablePresetDir(dir)) return true
  writeBridgeJson(res, 403, { ok: false, code: 'preset-readonly', message: 'system preset 只读，请先复制为用户预设' })
  return false
}

/** 将 moduleConfigs/行默认投影为 UI 字段兜底；显式 params 永远优先。 */
function mergeModuleConfigFallbacks(params: Record<string, unknown>, facts: PresetModuleFacts): void {
  for (const [key, value] of Object.entries(moduleParamFallbacks(facts.effectiveConfigs ?? {}))) {
    if (!Object.hasOwn(params, key)) params[key] = value
  }
}

/** 读取 JSON bridge 请求体；所有 JSON 端点统一使用 32 MiB 内存上限。 */
async function readBridgeBody(
  req: IncomingMessage,
): Promise<{ body: unknown; tooLarge: boolean; invalidJson: boolean; receivedBytes: number }> {
  const maxBytes = MAX_BRIDGE_BODY_BYTES
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  for await (const chunk of req) {
    if (overflow) continue
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) {
      // 超限：继续消费完请求流（保持连接可用），丢弃已收内容。
      overflow = true
      chunks.length = 0
      continue
    }
    chunks.push(buffer)
  }
  if (overflow) return { body: undefined, tooLarge: true, invalidJson: false, receivedBytes: size }
  if (size === 0) return { body: undefined, tooLarge: false, invalidJson: false, receivedBytes: 0 }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, tooLarge: false, invalidJson: false, receivedBytes: size }
  } catch {
    return { body: undefined, tooLarge: false, invalidJson: true, receivedBytes: size }
  }
}

function writeBridgeBodyTooLarge(res: ServerResponse, receivedBytes: number): void {
  writeBridgeJson(res, 413, {
    ok: false,
    code: 'bridge-body-too-large',
    message: `请求载荷超过 ${Math.round(MAX_BRIDGE_BODY_BYTES / 1024 / 1024)}MB 上限（已收到 ${receivedBytes} 字节）`,
  })
}

async function readBridgeBodyForHandler(req: IncomingMessage, res: ServerResponse): Promise<{ body: unknown } | undefined> {
  const result = await readBridgeBody(req)
  if (result.tooLarge) {
    writeBridgeBodyTooLarge(res, result.receivedBytes)
    return undefined
  }
  if (result.invalidJson) {
    writeBridgeJson(res, 400, { ok: false, code: 'bridge-request-invalid', message: 'malformed JSON body' })
    return undefined
  }
  if (result.body !== undefined && !isRecord(result.body)) {
    writeBridgeJson(res, 400, { ok: false, code: 'bridge-request-invalid', message: 'request body must be an object' })
    return undefined
  }
  return { body: result.body }
}

function uploadFileName(req: IncomingMessage): string {
  const value = req.headers['x-file-name']
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) throw new Error('缺少合法 X-File-Name 上传文件名')
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new Error('上传文件名编码无效')
  }
}

/** 自定义工具声明需要的预设模块（模块缺失时保存动作自动补齐）。 */
function customToolModules(tools: unknown[]): string[] {
  const modules = new Set<string>()
  if (tools.length > 0) modules.add('tool-config-engine')
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) continue
    const execute = (tool as Record<string, unknown>).execute
    if (execute === null || typeof execute !== 'object' || Array.isArray(execute)) continue
    const executeRecord = execute as Record<string, unknown>
    if (executeRecord.kind !== 'delegate') continue
    const target = executeRecord.tool
    if (typeof target !== 'string') continue
    if (target.startsWith('character_')) modules.add('character-tools')
    else if (target.startsWith('world_book_')) modules.add('world-book-tools')
    else if (target === 'session_var') modules.add('session-var-tools')
  }
  return [...modules]
}


/** 自建 loopback settings bridge：替代 registerConfigurableProviders，避免模型设置区出现插件条目。 */
export function registerSettingsBridge(
  ctx: Context,
  ns: string,
  getModelsState: () => ModelDetection,
  getSkillsState: () => SkillsBridgeState,
  getEngineStrategyDir: () => string,
  afterSkillsChange?: () => void,
  /** 生成目录（presetDir）：读取实际生效的提示词配置（引擎加载源）。 */
  getPresetConfigsDir?: () => string,
  /** 内容导入完成回调：批量 scope 只触发一次重建（更新运行时文本并重建预设）。 */
  afterPresetImport?: (scopes: Array<'preset' | 'agents'>) => void,
  /**
   * 参数覆盖写入回调（重建预设使参数生效）。返回值若为 Promise，是宿主默认模型同步结果：
   * 只有参数覆盖端点会把结果回给客户端（预设已保存 vs 默认模型同步失败要分开表达）；
   * 其余调用点不需要该结果。
   */
  afterOverridesChange?: () => ModelSyncResult | Promise<ModelSyncResult>,
  /** 预设已完整安装后的刷新回调；失败只返回 refreshWarning，不再物化或撤销安装。 */
  afterPresetPackageImport?: (id: string) => void | Promise<void>,
  /** 能力/recipe 原子创建后重建回调；抛错时调用方恢复 preset.yml。 */
  afterCapabilityChange?: () => void,
): { invalidateDescriptor: () => void } {
  let invalidateCachedDescriptor: () => void = () => {}
  let capabilityQueue: Promise<void> = Promise.resolve()
  /**
   * 触发参数覆盖回调并等待可选的模型同步结果：端点能据此把「预设已保存」与
   * 「宿主默认模型同步失败」分开表达；不需要结果的调用方走本函数忽略返回值即可
   * （不产生未处理拒绝）。
   */
  const runOverridesChange = async (): Promise<ModelSyncResult | undefined> => {
    try {
      return await afterOverridesChange?.()
    } catch {
      // 回调失败不应让保存端点整体失败：预设参数已经落盘，回调只影响重建/同步。
      return undefined
    }
  }
  // 动态等待 webServer：webServer 由 @deepseek-ai/dsh-web-app 提供。
  // profile 首次缺少该 bundle 时，本子插件先 pending 但不阻塞启动审计；
  // ensureWebSurface 会把 bundle 补进 manifest，重启后本子插件自动激活。
  ctx.inject(['settings', 'webServer'], (sctx: Context) => {
    sctx.effect(() => {
      const assetSources = createAssetSources(join(DSH_HOME, '.prompt-tool-uploads'))
      // descriptor 缓存（30s TTL）：宿主 settings.describe 是同步全量遍历——
      // 遍历所有注册 namespace + section 读取 + structuredClone 深度克隆 + schema
      // 序列化；插件越多越慢且阻塞事件循环。每个桥端点（meta/describe/delete/export…）
      // 都调 findDescriptor，无缓存时每个请求都付全量成本。
      let cachedDescriptor: SettingsDescriptor | undefined
      let cachedAt = 0
      const DESCRIPTOR_TTL_MS = 30_000
      const findDescriptor = (): SettingsDescriptor | undefined => {
        const now = Date.now()
        if (cachedDescriptor !== undefined && now - cachedAt < DESCRIPTOR_TTL_MS) return cachedDescriptor
        cachedDescriptor = sctx.settings.describe({ redactSecrets: true })
          .find((entry) => String(entry.ns) === String(ns))
        cachedAt = now
        return cachedDescriptor
      }
      /** mutate 成功后强制失效，下次 findDescriptor 重查宿主（响应必须带新 view）。 */
      const invalidateDescriptor = (): void => {
        cachedDescriptor = undefined
      }
      invalidateCachedDescriptor = invalidateDescriptor
      const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
        if (!isLoopbackRequest(req)) {
          writeBridgeJson(res, 403, { ok: false, code: 'settings-not-exposed', message: 'loopback requests only' })
          return false
        }
        if (req.method !== 'POST') {
          writeBridgeJson(res, 405, { ok: false, code: 'settings-not-exposed', message: 'method not allowed: ' + (req.method ?? '') })
          return false
        }
        return true
      }
      const guardPresetWrite = (dir: string, res: ServerResponse): boolean =>
        guardEditablePresetDir(dir, res)
      /** 预设身份只作一致性检查，绝不用客户端 ID 构造写入路径。 */
      const guardPresetIdentity = (record: Record<string, unknown>, dir: string, res: ServerResponse): boolean => {
        const expected = record.expectedPresetId
        if (expected !== undefined && (typeof expected !== 'string' || expected.length === 0 || expected.length > 256)) {
          writeBridgeJson(res, 400, { ok: false, code: 'preset-identity-invalid', message: 'expectedPresetId 必须是非空预设 ID' })
          return false
        }
        if ((getPresetConfigsDir?.() ?? '') !== dir || (expected !== undefined && expected !== basename(dir))) {
          writeBridgeJson(res, 409, { ok: false, code: 'preset-changed', message: '当前预设已切换；旧草稿未写入，请重新读取后保存' })
          return false
        }
        return true
      }
      /** 引擎能力矩阵（meta 端点与 /bootstrap 共用）：动态 import 引擎 schema。 */
      const loadEngineMeta = async (): Promise<Record<string, unknown>> => {
        const engineMetaUrl = pathToFileURL(join(packageEngineDir(), 'schema.mjs'))
        const { getEngineMeta } = await import(engineMetaUrl.href) as {
          getEngineMeta: () => Record<string, unknown>
        }
        const meta = getEngineMeta() as Record<string, unknown>
        meta.presets = listPresets()
        meta.builtinTemplates = listBuiltinTemplates()
        return meta
      }

      /** describe 运行时事实（describe 端点与 /bootstrap 共用）：检测状态、技能快照、
       *  宿主默认模型、模型目录缓存、激活预设参数。不触网（模型目录只读 10min 缓存）。 */
      const collectSkills = async (sessionId?: string): Promise<SkillsCatalogSnapshot> => {
        const cwd = sessionId === undefined ? undefined : localAgentCwd(sctx, sessionId)
        const agents = sctx.get?.('agents') as { get?: (id: string) => { ctx?: Context } | undefined } | undefined
        const agent = sessionId === undefined ? undefined : agents?.get?.(sessionId)
        const scope = agent?.ctx === undefined ? undefined : scopeOf(agent.ctx)
        const state = getSkillsState()
        try {
          if (state.snapshot !== undefined) return await state.snapshot({ cwd, scope })
          const entries = state.listSkills(cwd)
          const registry = (sctx.get?.('skills') ?? ctx.skills) as Pick<SkillRegistry, 'snapshot'> | undefined
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
      const collectDescribeExtras = async (sessionId?: string): Promise<Record<string, unknown>> => {
        const detection = getModelsState()
        const skillsState = getSkillsState()
        const skillsSnapshot = await collectSkills(sessionId)
        // 宿主默认模型（agent-default-model settings：主对话新会话默认）：
        // 插件参数未设置（空 = 继承宿主）时回显给客户端（模型名下拉候选/状态行）。
        let hostDefaultModel: { provider?: string; model?: string; reasoningEffort?: string } | undefined
        try {
          const selection = sctx.settings.get('agent-default-model') as
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
        const modelCatalog = peekModelCatalog(sctx)
        // 引擎参数按预设存储：/describe 附带激活预设参数（settings 已不承载；
        // 客户端 fields 参数键由此合并，promptConfigs 仍以 /prompt-configs 实际配置为准）。
        let presetParams: Record<string, unknown> = {}
        let moduleFacts: PresetModuleFacts | undefined
        // 当前预设模板消息批层（pre-step）配置数：UI 消息批层入口开关联动——
        // 模板无 pre-step 配置（layer 缺省即 pre-step）时开关关闭且禁编辑。
        let templatePreStepCount = 0
        try {
          // 激活预设目录以服务端 runtime 为准（getPresetConfigsDir），而不是 descriptor
          // 缓存里的 presetTemplate——descriptor 有 30s TTL，切换预设后若缓存未失效，
          // 这里会读旧预设参数，与下方 readParamOverrides/readPromptConfigs(新目录) 不同源。
          const activeDir = getPresetConfigsDir?.() ?? ''
          const templateName = activeDir.length > 0 ? basename(activeDir) : DEFAULT_PRESET_ID
          const spec = loadPresetSpec(activeDir.length > 0 ? activeDir : resolvePresetDir(templateName))
          presetParams = resolvePresetParams(spec, {})
          const resolvedFacts = resolvePresetModuleFacts(
            spec,
            activeDir.length > 0 ? activeDir : undefined,
            isEditablePresetDir(activeDir.length > 0 ? activeDir : resolvePresetDir(templateName)),
          )
          mergeModuleConfigFallbacks(presetParams, resolvedFacts)
          // effectiveConfigs 只用于服务端把已存在的 moduleConfigs 回显到已知字段；
          // 不把整份行级配置（可能含路径/未知字段）发送到浏览器。
          moduleFacts = {
            declaredModules: resolvedFacts.declaredModules,
            effectiveModules: resolvedFacts.effectiveModules,
            rowIds: resolvedFacts.rowIds,
            sourceMode: resolvedFacts.sourceMode,
            editable: resolvedFacts.editable,
          }
          if (Array.isArray(spec.promptConfigs)) {
            presetParams.promptConfigs = spec.promptConfigs
          }
          templatePreStepCount = (spec.promptConfigs ?? []).filter((config) => {
            const layer = (config as { layer?: string }).layer
            return layer === undefined || layer === 'pre-step'
          }).length
        } catch {
          templatePreStepCount = 0
        }
        return {
          presetParams,
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

      /** 激活预设的引擎参数子集（/param-overrides 读取；preset.yml 按 mtime 缓存）。 */
      const readParamOverrides = (dir: string): Record<string, unknown> => {
        try {
          const spec = loadPresetSpec(dir)
          const params: Record<string, unknown> = {}
          for (const key of PARAM_KEYS) {
            if (key === 'promptConfigs') continue
            if (spec.params !== null && typeof spec.params === 'object' && key in spec.params) {
              params[key] = spec.params[key]
            }
          }
          return params
        } catch {
          return {}
        }
      }

      /** 预设级模板变量（/preset-variables 读取）。 */
      const readPresetVariables = (dir: string): { variables: Record<string, string>; enabled: boolean } => {
        try {
          const spec = loadPresetSpec(dir)
          const variables: Record<string, string> = {}
          for (const [key, value] of Object.entries(spec.variables ?? {})) {
            if (typeof value === 'string') variables[key] = value
          }
          return { variables, enabled: spec.variablesEnabled !== false }
        } catch {
          return { variables: {}, enabled: true }
        }
      }

      /** 生成目录实际生效配置（/prompt-configs 读取）。 */
      const readPromptConfigs = (dir: string): unknown[] => {
        try {
          return dir.length > 0 ? loadPromptConfigFiles(join(dir, 'prompt-configs')) : []
        } catch {
          return []
        }
      }

      const disposers = [
        assetSources.dispose,
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.bootstrap,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const descriptor = findDescriptor()
            if (descriptor === undefined) {
              writeBridgeJson(res, 404, { ok: false, code: 'settings-not-exposed', message: 'prompt-tool settings namespace is not registered' })
              return
            }
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const session = readSessionIdField(parsedBody.body)
            if (!session.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: session.message })
              return
            }
            // 工作台首屏/保存后刷新的聚合读取：meta + describe 事实 + 参数覆盖 +
            // 模板变量 + 实际生效配置 + 指令文件快照。此前客户端串行 5 个端点
            // （每端点独立读盘 parse preset.yml）；聚合后单请求、preset.yml 命中
            // mtime 缓存仅解析一次。文件卡正文与 /prompt-configs 走同一读取入口。
            try {
              const meta = await loadEngineMeta()
              const dir = getPresetConfigsDir?.() ?? ''
              const extras = await collectDescribeExtras(session.sessionId)
              const scope = resolveInstructionScope(sctx, session.sessionId)
              writeBridgeJson(res, 200, {
                ok: true,
                value: descriptor,
                meta: { meta },
                overrides: { overrides: dir.length > 0 ? readParamOverrides(dir) : {} },
                variables: dir.length > 0 ? readPresetVariables(dir) : { variables: {}, enabled: true },
                promptConfigs: { promptConfigs: mergeInstructionCards(readPromptConfigs(dir), scope.files) },
                instructions: { context: scope.context, files: scope.files, owner: instructionOwner(sctx, session.sessionId) },
                ...extras,
              })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 500, { ok: false, code: 'bootstrap-failed', message })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const meta = await loadEngineMeta()
            writeBridgeJson(res, 200, { ok: true, value: { meta } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.describe,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const descriptor = findDescriptor()
            if (descriptor === undefined) {
              writeBridgeJson(res, 404, { ok: false, code: 'settings-not-exposed', message: 'prompt-tool settings namespace is not registered' })
              return
            }
            writeBridgeJson(res, 200, { ok: true, value: descriptor, ...await collectDescribeExtras() })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.models,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const record = parsedBody.body as { refresh?: unknown } | undefined
            // 显式刷新（客户端重连、用户重试）越过 10 分钟 TTL：先失效再全量查询。
            // 目录查询失败不影响下一次调用，也不返回空目录冒充成功。
            if (record?.refresh === true) invalidateModelCatalog(sctx)
            const modelCatalog = await listAdvertisedModels(sctx)
            writeBridgeJson(res, 200, { ok: true, value: { modelCatalog } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.modelReasoning,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const record = parsedBody.body
            if (record === null || record === undefined || typeof record !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'reasoning-invalid-shape', message: 'model reasoning requires a JSON body' })
              return
            }
            const { provider, model } = record as { provider?: unknown; model?: unknown }
            if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'reasoning-invalid-shape', message: 'provider and model must be non-empty strings' })
              return
            }
            // 查询失败/超时返回 known:false：客户端据此保持「未查到」，不虚构档位。
            const reasoning = await refreshModelReasoning(sctx, provider, model) ?? { known: false, efforts: [] }
            writeBridgeJson(res, 200, { ok: true, value: { reasoning } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.mutate,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            if (body === null || body === undefined || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            if (!Array.isArray(record.ops)) {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request' })
              return
            }
            // 引擎参数按预设存储（激活预设 preset.yml）：settings mutate 只接受全局键。
            const paramOp = record.ops.find((op) => {
              const path = (op as { path?: unknown })?.path
              return Array.isArray(path) && path.length > 0 && typeof path[0] === 'string' && PARAM_KEYS.has(path[0])
            })
            if (paramOp !== undefined) {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: '引擎参数按预设存储：请用设置页保存（/param-overrides），settings 只接受全局开关' })
              return
            }
            const expectedRevision = typeof record.expectedRevision === 'number' ? record.expectedRevision : undefined
            try {
              await sctx.settings.mutate(ns, record.ops as SettingsPathOp[], expectedRevision)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 409, { ok: false, code: 'settings-rejected', message })
              return
            }
            // mutate 后必须重查宿主拿新 view（缓存已失效，跳过旧值）。
            invalidateDescriptor()
            const descriptor = findDescriptor()
            if (descriptor === undefined) {
              writeBridgeJson(res, 500, { ok: false, code: 'settings-rejected', message: 'prompt-tool settings namespace was disposed after mutate' })
              return
            }
            writeBridgeJson(res, 200, { ok: true, value: descriptor })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.configsValidate,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            // 校验载荷承载全量 promptConfigs（实测 129 卡 70KB），使用统一 32 MiB JSON 上限，
            // 超限由共享读取器明确返回 413，避免保存按钮收到误导性的 unreadable JSON body。
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            if (body === null || body === undefined || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            if (!Array.isArray(record.promptConfigs)) {
              writeBridgeJson(res, 400, { ok: false, code: 'prompt-configs-invalid', message: 'promptConfigs must be an array' })
              return
            }
            const result = await validatePromptConfigs(record.promptConfigs, { strategyDir: getEngineStrategyDir() })
            writeBridgeJson(res, 200, { ok: true, value: result })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.skillsList,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const session = readSessionIdField(parsedBody.body)
            if (!session.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'skills-list-rejected', message: session.message })
              return
            }
            // 项目技能按会话工作目录解析；没有存活会话时只列用户根与内置来源。
            const state = getSkillsState()
            writeBridgeJson(res, 200, {
              ok: true,
              value: {
                ...await collectSkills(session.sessionId),
                folders: state.folders,
                roots: [state.skillsRoot],
              },
            })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.skillsImport,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            if (body === null || body === undefined || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            const files = Array.isArray(record.files) ? record.files : []
            const overwrite = readSkillOverwrite(record.overwrite)
            if (overwrite === undefined) {
              writeBridgeJson(res, 400, { ok: false, code: 'skills-import-rejected', message: 'overwrite 必须是已确认的技能目录名数组' })
              return
            }
            const root = getSkillsState().skillsRoot
            const result = importSkillsPackage(root, files, overwrite)
            if (!result.ok) {
              writeBridgeJson(res, result.code === 'skills-overwrite-required' ? 409 : 400,
                { ...result, code: result.code ?? 'skills-import-rejected' })
              return
            }
            afterSkillsChange?.()
            writeBridgeJson(res, 200, { ok: true, value: result })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.skillPolicy,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const body = parsedBody.body
            const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
            const change: SkillPolicyChange | undefined = record.scope === undefined
              ? ((record.side === 'model' || record.side === 'user') && typeof record.enabled === 'boolean'
                ? { side: record.side, enabled: record.enabled } : undefined)
              : (record.side === undefined && record.enabled === undefined && typeof record.scope === 'string'
                && ['none', 'model', 'user', 'all'].includes(record.scope)
                ? { scope: record.scope as SkillPolicyScope } : undefined)
            if (typeof record.name !== 'string' || record.name.length === 0
              || typeof record.path !== 'string' || record.path.length === 0 || change === undefined) {
              writeBridgeJson(res, 400, { ok: false, code: 'skill-policy-rejected', message: 'name、path 与单端 side/enabled 或显式 scope 必填' })
              return
            }
            const session = readSessionIdField(body)
            if (!session.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'skill-policy-rejected', message: session.message })
              return
            }
            // 身份校验在与清单相同的工作区视图里做：客户端提交的 path 只有命中服务端当次扫描的
            // 同名条目才被接受，陈旧界面因此改不到被替换过的同名技能。
            const cwd = session.sessionId === undefined ? undefined : localAgentCwd(sctx, session.sessionId)
            const written = getSkillsState().setSkillPolicy(record.name, record.path, change, cwd)
            if (written.ok === false) {
              // 界面陈旧、技能无效、只读或链接目标等都在这里如实回报，不静默。
              writeBridgeJson(res, 409, { ok: false, code: 'skill-policy-rejected', message: written.message })
              return
            }
            afterSkillsChange?.()
            writeBridgeJson(res, 200, { ok: true, value: await collectSkills(session.sessionId) })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.skillsFolders,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const body = parsedBody.body
            const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
            if (!Array.isArray(record.folders) || record.folders.some((item) => typeof item !== 'string')) {
              writeBridgeJson(res, 400, { ok: false, code: 'skills-folders-rejected', message: 'folders 必须是字符串数组' })
              return
            }
            const session = readSessionIdField(body)
            if (!session.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'skills-folders-rejected', message: session.message })
              return
            }
            // 只记引用，不复制也不移动任何文件。
            const written = await getSkillsState().patchSkillFolders(record.folders as string[])
            if (written.ok === false) {
              writeBridgeJson(res, 409, { ok: false, code: 'skills-folders-rejected', message: written.message })
              return
            }
            afterSkillsChange?.()
            writeBridgeJson(res, 200, {
              ok: true,
              value: { ...await collectSkills(session.sessionId), folders: written.state.folders },
            })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.skillCreate,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const body = parsedBody.body
            const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
            const result = createSkill(getSkillsState().skillsRoot, record as { name: unknown; description: unknown; content: unknown })
            if (!result.ok) { writeBridgeJson(res, 400, { ok: false, code: 'skill-create-rejected', message: result.message }); return }
            afterSkillsChange?.()
            writeBridgeJson(res, 200, { ok: true, value: result })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.skillDelete,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const body = parsedBody.body
            const record = isRecord(body) ? body : {}
            const session = readSessionIdField(body)
            if (!session.ok || typeof record.name !== 'string' || record.name.length === 0
              || typeof record.path !== 'string' || record.path.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'skill-delete-rejected', message: session.ok ? 'name、path 必填' : session.message })
              return
            }
            const cwd = session.sessionId === undefined ? undefined : localAgentCwd(sctx, session.sessionId)
            const result = getSkillsState().deleteSkill(record.name, record.path, cwd)
            if (!result.ok) { writeBridgeJson(res, 400, { ok: false, code: 'skill-delete-rejected', message: result.message }); return }
            afterSkillsChange?.()
            writeBridgeJson(res, 200, { ok: true, value: result })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.skillsImportDirectory,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const body = parsedBody.body
            const source = body !== null && typeof body === 'object' && !Array.isArray(body) && typeof (body as Record<string, unknown>).path === 'string'
              ? (body as Record<string, unknown>).path as string : ''
            // 与实现层共用同一个校验入口：空串不能落到 resolve，否则会退化成进程工作目录。
            try {
              assertImportableSource(source)
            } catch (error) {
              writeBridgeJson(res, 400, { ok: false, code: 'skills-import-rejected', message: `技能导入失败：${error instanceof Error ? error.message : String(error)}` })
              return
            }
            const overwrite = readSkillOverwrite(isRecord(body) ? body.overwrite : undefined)
            if (overwrite === undefined) {
              writeBridgeJson(res, 400, { ok: false, code: 'skills-import-rejected', message: 'overwrite 必须是已确认的技能目录名数组' })
              return
            }
            const result = importSkillsDirectory(getSkillsState().skillsRoot, source, overwrite)
            if (!result.ok) {
              writeBridgeJson(res, result.code === 'skills-overwrite-required' ? 409 : 400,
                { ...result, code: result.code ?? 'skills-import-rejected' })
              return
            }
            afterSkillsChange?.()
            writeBridgeJson(res, 200, { ok: true, value: result })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.templates,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              const templates = loadPromptTemplates()
              const toolTemplates = loadToolTemplates()
              writeBridgeJson(res, 200, { ok: true, value: { templates, toolTemplates } })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 500, { ok: false, code: 'templates-unavailable', message })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.promptConfigs,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const session = readSessionIdField(parsedBody.body)
            if (!session.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: session.message })
              return
            }
            // 实际生效配置 = 生成目录 prompt-configs/（引擎加载源）；
            // settings.promptConfigs 仅是用户覆盖层，默认为空不代表无配置。
            const dir = getPresetConfigsDir?.() ?? ''
            // 独立文件来源：与 /bootstrap 共用同一读取入口，附正文、字节版本与读取状态。
            const scope = resolveInstructionScope(sctx, session.sessionId)
            writeBridgeJson(res, 200, {
              ok: true,
              value: {
                promptConfigs: mergeInstructionCards(readPromptConfigs(dir), scope.files),
                instructions: { context: scope.context, files: scope.files, owner: instructionOwner(sctx, session.sessionId) },
              },
            })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.agentsFile,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            if (!isRecord(body)) {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const session = readSessionIdField(body)
            if (!session.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: session.message })
              return
            }
            const record = body
            const fileId = typeof record.fileId === 'string' ? record.fileId.trim() : ''
            const contextId = typeof record.contextId === 'string' ? record.contextId.trim() : ''
            const content = record.content
            const expectedRevision = record.expectedRevision === null
              ? null
              : (typeof record.expectedRevision === 'string' && record.expectedRevision.length > 0
                ? record.expectedRevision
                : undefined)
            if (fileId === '' || contextId === '' || typeof content !== 'string' || expectedRevision === undefined) {
              writeBridgeJson(res, 400, {
                ok: false,
                code: 'settings-rejected',
                message: 'fileId/contextId 必须是非空字符串，content 必须是字符串，expectedRevision 必须是 SHA-256 或 null',
              })
              return
            }
            // 白名单与上下文都由服务端本次重新解析：客户端提交的 contextId 只用于
            // 说明「它是按哪次读取起草的」，过期工作区（切会话/外部改动上下文）一律拒绝。
            const scope = resolveInstructionScope(sctx, session.sessionId)
            if (contextId !== scope.context.contextId) {
              writeBridgeJson(res, 409, {
                ok: false,
                code: 'agents-file-context-stale',
                message: '工作区上下文已变化，未写盘；请重新读取后再保存',
              })
              return
            }
            const file = scope.cards.find((card) => card.fileId === fileId)
            if (file === undefined) {
              writeBridgeJson(res, 400, {
                ok: false,
                code: 'settings-rejected',
                message: `unknown agents file: ${fileId}`,
              })
              return
            }
            const outcome = await writeAgentsFileChecked({ file, content, expectedRevision })
            if (!outcome.ok) {
              writeBridgeJson(res, outcome.status, { ok: false, code: outcome.code, message: outcome.message })
              return
            }
            // 正文写入是文件事实，不触发预设重建：运行时下一次读取直接看新文件。
            writeBridgeJson(res, 200, { ok: true, value: { fileId: outcome.fileId, revision: outcome.revision } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.instructionsPolicy,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const body = parsedBody.body
            if (body !== undefined && body !== null && !isRecord(body)) {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = isRecord(body) ? body : {}
            const file = instructionPolicyPath()
            // 省略 policy = 读取：损坏/版本不认识时带 error 返回，客户端据此禁用保存。
            if (record.policy === undefined) {
              const snapshot = readInstructionPolicy(file)
              writeBridgeJson(res, 200, {
                ok: true,
                value: {
                  policy: snapshot.policy,
                  revision: snapshot.revision,
                  exists: snapshot.exists,
                  ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
                },
              })
              return
            }
            const expectedRevision = record.expectedRevision === null
              ? null
              : (typeof record.expectedRevision === 'string' && record.expectedRevision.length > 0
                ? record.expectedRevision
                : undefined)
            if (expectedRevision === undefined) {
              writeBridgeJson(res, 400, {
                ok: false,
                code: 'instructions-policy-invalid',
                message: 'expectedRevision 必须是 SHA-256 或 null',
              })
              return
            }
            const outcome = writeInstructionPolicy({ file, patch: record.policy, expectedRevision })
            if (!outcome.ok) {
              writeBridgeJson(res, outcome.status, { ok: false, code: outcome.code, message: outcome.message })
              return
            }
            writeBridgeJson(res, 200, { ok: true, value: { policy: outcome.policy, revision: outcome.revision, exists: true } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.presetContent,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            const scope = record.scope === 'agents' ? 'agents' : 'preset'
            try {
              // 内容资产在生成目录 preset.md / agents.md（settings 不承载大文本）。
              const dir = getPresetConfigsDir?.() ?? ''
              const content = dir.length > 0
                ? readFileSync(join(dir, scope === 'preset' ? 'preset.md' : 'agents.md'), 'utf8')
                : ''
              writeBridgeJson(res, 200, { ok: true, value: { content } })
            } catch {
              writeBridgeJson(res, 200, { ok: true, value: { content: '' } })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.importPreset,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            if (body === null || body === undefined || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            // 批量载荷 { contents: [{scope, content}] }：一次请求写多个内容资产、只触发
            // 一次重建（此前逐条请求每条各重建一次）。旧单条形状 {scope, content} 兼容保留。
            const contents: Array<{ scope: 'preset' | 'agents'; content: string }> = []
            if (Array.isArray(record.contents)) {
              for (const entry of record.contents) {
                if (entry === null || typeof entry !== 'object') continue
                const item = entry as Record<string, unknown>
                contents.push({
                  scope: item.scope === 'agents' ? 'agents' : 'preset',
                  content: typeof item.content === 'string' ? item.content : '',
                })
              }
            } else {
              contents.push({
                scope: record.scope === 'agents' ? 'agents' : 'preset',
                content: typeof record.content === 'string' ? record.content : '',
              })
            }
            if (contents.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            if (!guardPresetWrite(dir, res)) return
            try {
              if (!guardPresetIdentity(record, dir, res)) return
              mkdirSync(dir, { recursive: true })
              for (const entry of contents) {
                writeFileSync(join(dir, entry.scope === 'preset' ? 'preset.md' : 'agents.md'), entry.content, 'utf8')
              }
              afterPresetImport?.(contents.map((entry) => entry.scope))
              writeBridgeJson(res, 200, { ok: true, value: { scopes: contents.map((entry) => entry.scope) } })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 500, { ok: false, code: 'preset-import-failed', message })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.paramOverrides,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            // 阶段 2：参数按预设存储——读写激活预设 preset.yml 的 params（+ promptConfigs）。
            const presetRoot = dirname(dir)
            const templateName = basename(dir)
            // promptConfigs 全量数组随配置卡数量增长；所有 JSON bridge 端点统一使用 32 MiB
            // 内存缓冲上限，超过后由调用方收到明确 413，不再静默降级为读取分支。
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            if (!guardPresetIdentity(record, dir, res)) return
            if (record.rebuild !== undefined && typeof record.rebuild !== 'boolean') {
              writeBridgeJson(res, 400, { ok: false, code: 'overrides-invalid-shape', message: 'rebuild must be a boolean' })
              return
            }
            // 无载荷 = 读取（preset.yml params 子集，兼容旧读回）。
            if (record.overrides === undefined && record.promptConfigs === undefined) {
              if (record.rebuild !== undefined) {
                writeBridgeJson(res, 400, { ok: false, code: 'overrides-invalid-shape', message: 'rebuild requires overrides or promptConfigs' })
                return
              }
              writeBridgeJson(res, 200, { ok: true, value: { overrides: readParamOverrides(dir) } })
              return
            }
            if (record.overrides !== undefined && !isRecord(record.overrides)) {
              writeBridgeJson(res, 400, { ok: false, code: 'overrides-invalid-shape', message: 'overrides must be an object' })
              return
            }
            if (record.promptConfigs !== undefined && !Array.isArray(record.promptConfigs)) {
              writeBridgeJson(res, 400, { ok: false, code: 'prompt-configs-invalid', message: 'promptConfigs must be an array' })
              return
            }
            if (!guardPresetWrite(dir, res)) return
            const rawOverrides = record.overrides as Record<string, unknown> | undefined
            // 参数键白名单：未知键 fail loud，避免写入「读回/参数桥都不消费」的死键。
            if (rawOverrides !== undefined) {
              const unknownKeys = Object.keys(rawOverrides).filter((key) => key === 'promptConfigs' || !PARAM_KEYS.has(key))
              if (unknownKeys.length > 0) {
                writeBridgeJson(res, 400, {
                  ok: false,
                  code: 'overrides-unknown-key',
                  message: `未知引擎参数键：${unknownKeys.join(', ')}`,
                })
                return
              }
            }
            // 数值参数保存前校验（契约层同源规则）：temperature 有限数 / maxTokens 正整数。
            // 渲染层保持宽容（never-brick），保存层响亮失败直达 UI notice。
            const valueErrors = rawOverrides !== undefined ? validateEngineParamValues(rawOverrides) : []
            if (valueErrors.length > 0) {
              writeBridgeJson(res, 400, {
                ok: false,
                code: 'overrides-invalid-value',
                message: valueErrors.map((item) => item.message).join('; '),
              })
              return
            }
            try {
              // 顶层人设「独占」与提示词配置「独占」互斥（官方 complete 段一个 scope
              // 只能有一个）；promptConfigs 单独保存也走这里，故放在参数块之外。
              if (Array.isArray(record.promptConfigs)) {
                const spec = loadPresetSpec(dir)
                const conflicting = record.promptConfigs.some((config) => {
                  if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
                  const entry = config as Record<string, unknown>
                  return entry.enabled !== false && (entry.params as Record<string, unknown> | undefined)?.complete === true
                })
                if (spec.persona?.complete === true && conflicting) {
                  writeBridgeJson(res, 400, {
                    ok: false,
                    code: 'overrides-invalid-value',
                    message: '顶层人设已开启「独占」；提示词配置的「独占」与之互斥，请先关闭其一',
                  })
                  return
                }
              }
              if (rawOverrides !== undefined) {
                const spec = loadPresetSpec(dir)
                const candidateParams = { ...spec.params }
                for (const [key, value] of Object.entries(rawOverrides)) {
                  if (value === '' || (Array.isArray(value) && value.length === 0)) delete candidateParams[key]
                  else if (value !== null && value !== undefined) candidateParams[key] = value
                }
                const bootstrap = resolvePresetModuleFacts({ ...spec, params: candidateParams }, dir, true).effectiveConfigs?.['tool-bootstrap']
                if ((bootstrap?.promoteGate === true || bootstrap?.promoteAfterFirstResponse === true)
                  && bootstrap.promoteOn !== undefined && bootstrap.promoteOn !== 'either') {
                  writeBridgeJson(res, 400, { ok: false, code: 'overrides-invalid-value', message: '门控晋升与首响应晋升要求工具晋升信号为 either；请先调整同一卡片中的晋升信号' })
                  return
                }
              }
              if (!guardPresetIdentity(record, dir, res)) return
              savePresetParams(
                presetRoot,
                templateName,
                rawOverrides,
                record.promptConfigs as unknown[] | undefined,
              )
              // 预设切换前保存当前配置卡时只需落盘，不立即重建；
              // 后续 settings presetTemplate 变更会让目标预设完成唯一一次重建。
              // rebuild === false 时不做重建/同步，也不回 modelSync（没有同步事实可报）。
              const modelSync = record.rebuild === false ? undefined : await runOverridesChange()
              writeBridgeJson(res, 200, {
                ok: true,
                value: {
                  ...(record.overrides !== undefined ? { overrides: record.overrides } : {}),
                  ...(record.promptConfigs !== undefined ? { promptConfigs: record.promptConfigs } : {}),
                  ...(modelSync !== undefined ? { modelSync } : {}),
                },
              })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 500, { ok: false, code: 'overrides-write-failed', message })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.presetVariables,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            // 预设级模板变量：只读写激活预设 preset.yml
            // 顶层 variables 段；writePreset 渲染时展开进 prompt-configs/variables.yml，
            // 引擎加载合并进每条配置 variables（官方插值源）。配置卡片 variables
            // 只显示配置自身，模板变量统一在本卡片编辑。
            const presetRoot = dirname(dir)
            const templateName = basename(dir)
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            if (!guardPresetIdentity(record, dir, res)) return
            // 无载荷 = 读取（preset.yml 顶层 variables + 插值开关，不回退 params）。
            if (record.variables === undefined && record.enabled === undefined) {
              writeBridgeJson(res, 200, { ok: true, value: readPresetVariables(dir) })
              return
            }
            if (record.variables !== undefined
              && (!isRecord(record.variables) || Object.values(record.variables).some((value) => typeof value !== 'string'))) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-variables-invalid', message: 'variables must be an object with string values' })
              return
            }
            if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-variables-invalid', message: 'enabled must be a boolean' })
              return
            }
            if (!guardPresetWrite(dir, res)) return
            try {
              if (!guardPresetIdentity(record, dir, res)) return
              savePresetParams(
                presetRoot,
                templateName,
                undefined,
                undefined,
                record.variables as Record<string, string> | undefined,
                record.enabled as boolean | undefined,
              )
              void runOverridesChange()
              writeBridgeJson(res, 200, { ok: true, value: { variables: record.variables } })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 409, { ok: false, code: 'preset-variables-rejected', message: `模板变量保存失败：${message}` })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.customTools,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            if (!guardPresetIdentity(record, dir, res)) return
            // 无载荷 = 读取（preset.yml 顶层 customTools 段）。
            if (record.customTools === undefined) {
              try {
                const spec = loadPresetSpec(dir)
                const customTools = Array.isArray(spec.customTools) ? spec.customTools : []
                writeBridgeJson(res, 200, { ok: true, value: { customTools } })
              } catch {
                writeBridgeJson(res, 409, { ok: false, code: 'custom-tools-unavailable', message: '自定义工具读取失败，原文件保持不变' })
              }
              return
            }
            try {
              const customTools = record.customTools
              if (!Array.isArray(customTools)) {
                writeBridgeJson(res, 400, { ok: false, code: 'custom-tools-invalid', message: 'customTools 必须是数组' })
                return
              }
              const errors = validateCustomTools(customTools)
              if (errors.length > 0) {
                writeBridgeJson(res, 400, { ok: false, code: 'custom-tools-invalid', message: errors.join('; ') })
                return
              }
              if (!guardPresetWrite(dir, res)) return
              if (!guardPresetIdentity(record, dir, res)) return
              withPresetDoc(dir, (doc) => {
                if (customTools.length === 0) doc.deleteIn(['customTools'])
                else {
                  doc.setIn(['customTools'], customTools)
                  appendPresetModules(doc, customToolModules(customTools))
                }
              })
              void runOverridesChange()
              writeBridgeJson(res, 200, { ok: true, value: { customTools } })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 409, { ok: false, code: 'custom-tools-rejected', message: `自定义工具保存失败：${message}` })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.persona,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const record = (parsedBody.body ?? {}) as Record<string, unknown>
            if (!guardPresetIdentity(record, dir, res)) return
            // 无 persona 载荷 = 读取（preset.yml 顶层 persona 段）。
            if (record.persona === undefined) {
              try {
                writeBridgeJson(res, 200, { ok: true, value: { persona: readPersonaSpec(loadPresetSpec(dir).persona) ?? null } })
              } catch {
                writeBridgeJson(res, 200, { ok: true, value: { persona: null } })
              }
              return
            }
            if (!guardPresetWrite(dir, res)) return
            try {
              const raw = record.persona
              const persona = raw === null ? null : readPersonaSpec(raw)
              if (persona === undefined) {
                writeBridgeJson(res, 400, {
                  ok: false,
                  code: 'preset-persona-invalid',
                  message: 'persona 必须包含字符串 prefix（可选 suffix / complete / includeRuntimeContext）',
                })
                return
              }
              // 官方 complete 段一个 scope 只能有一个：顶层人设「独占」与提示词配置
              // 「独占」同时启用时装配会失败，写盘前 fail loud（与 paramOverrides 的
              // 晋升信号一致性检查同模式）。
              if (persona?.complete === true) {
                const configs = loadPresetSpec(dir).promptConfigs ?? []
                const conflicting = configs.some((config) => {
                  if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
                  const entry = config as Record<string, unknown>
                  return entry.enabled !== false && (entry.params as Record<string, unknown> | undefined)?.complete === true
                })
                if (conflicting) {
                  writeBridgeJson(res, 400, {
                    ok: false,
                    code: 'preset-persona-complete-conflict',
                    message: '提示词配置已有「独占」段；顶层人设的「独占」与之互斥，请先关闭其一',
                  })
                  return
                }
              }
              savePresetPersona(dirname(dir), basename(dir), persona)
              void runOverridesChange()
              writeBridgeJson(res, 200, { ok: true, value: { persona } })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 409, { ok: false, code: 'preset-persona-rejected', message: `人设保存失败：${message}` })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.assetUpload,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              const value = await assetSources.upload(uploadFileName(req), req)
              writeBridgeJson(res, 200, { ok: true, value })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, message.includes('64 MiB') ? 413 : 400, { ok: false, code: 'asset-upload-rejected', message })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.assetRelease,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsed = await readBridgeBodyForHandler(req, res)
            if (parsed === undefined) return
            const record = parsed.body
            if (!isRecord(record) || Object.keys(record).length !== 1 || typeof record.sourceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.sourceId)) {
              writeBridgeJson(res, 400, { ok: false, code: 'asset-release-rejected', message: 'sourceId 必须是有效上传来源标识' })
              return
            }
            try { writeBridgeJson(res, 200, { ok: true, value: { released: assetSources.release(record.sourceId) } }) }
            catch (error) { writeBridgeJson(res, 400, { ok: false, code: 'asset-release-rejected', message: String(error) }) }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.importPresetPackage,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            if (body === null || body === undefined || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            // 入口校验先于任何转换与写盘：非法 preview/摘要/顺序组类型一律 400，
            // 不静默回落到"直接写入"，也不在拒绝前创建目录或备份。
            const request = readImportRequestParams(record)
            if (!request.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-package-invalid', message: request.message })
              return
            }
            try {
              const files = await expandPresetSource(request.params.sourceId === undefined ? readBridgeFiles(record.files) : assetSources.read(request.params.sourceId))
              const preview = presetImportPreview(userPresetsDir(), files, request.params)
              if (!('prepared' in preview)) {
                if (!request.params.preview) throw new Error('请先选择内容类型或提示顺序组并重新预览')
                writeBridgeJson(res, 200, { ok: true, value: { preview: true, ...preview } })
                return
              }
              const { prepared, summary, sourceDigest, previewRevision } = preview
              if (request.params.preview) {
                writeBridgeJson(res, 200, { ok: true, value: { preview: true, state: 'ready', summary, sourceDigest, previewRevision, ...(prepared.report === undefined ? {} : { report: prepared.report }) } })
                return
              }
              const installed = await installPresetPackage(userPresetsDir(), files, request.params)
              invalidateDescriptor()
              let refreshWarning: string | undefined
              try { await afterPresetPackageImport?.(installed.id) }
              catch (error) { refreshWarning = `预设已安装，但刷新失败：${error instanceof Error ? error.message : String(error)}` }
              writeBridgeJson(res, 200, { ok: true, value: { ...installed, sourceDigest, ...(prepared.report === undefined ? {} : { report: prepared.report }), ...(refreshWarning === undefined ? {} : { refreshWarning }) } })
            } catch (error) {
              const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'preset-package-invalid'
              writeBridgeJson(res, code === 'preset-preview-stale' ? 409 : 400, { ok: false, code, message: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.exportPreset,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            try {
              const allowed = new Set(['id', 'mode', 'preview', 'expectedRevision', 'memoryChoices'])
              if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error('导出请求包含未知字段')
              assertPresetId(record.id)
              if (record.id.length > 128) throw new Error('预设 ID 过长')
              if (record.mode !== undefined && record.mode !== 'definition' && record.mode !== 'zip') throw new Error('mode 必须是 definition 或 zip')
              if (record.preview !== undefined && typeof record.preview !== 'boolean') throw new Error('preview 必须是布尔值')
              if (record.expectedRevision !== undefined && (typeof record.expectedRevision !== 'string' || !SHA256_HEX_RE.test(record.expectedRevision))) throw new Error('expectedRevision 必须是 SHA-256 摘要')
              if (record.memoryChoices !== undefined && (!isRecord(record.memoryChoices) || Object.keys(record.memoryChoices).length > 2048
                || Object.entries(record.memoryChoices).some(([key, value]) => key.length === 0 || key.length > 256 || (value !== 'include' && value !== 'exclude')))) throw new Error('memoryChoices 必须包含合法条目 ID 和 include/exclude 选择')
              const value = await exportPresetPackage(userPresetsDir(), record as unknown as PresetExportRequest)
              writeBridgeJson(res, 200, { ok: true, value })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'preset-export-failed'
              writeBridgeJson(res, code.includes('stale') ? 409 : 400, { ok: false, code, message })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.presetDelete,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id.trim() : ''
            if (id.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-delete-rejected', message: '缺少预设 id' })
              return
            }
            // 当前使用中的预设不可删除（先切换再删）。
            const descriptor = findDescriptor()
            const value = (descriptor?.value ?? {}) as Record<string, unknown>
            const base = (descriptor?.base ?? {}) as Record<string, unknown>
            const active = typeof value.presetTemplate === 'string' ? value.presetTemplate
              : typeof base.presetTemplate === 'string' ? base.presetTemplate : undefined
            if (typeof active === 'string' && active.length > 0 && active === id) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-in-use', message: `预设「${id}」正在使用中，请先切换其他预设再删除` })
              return
            }
            // 全部预设都在官方预设根（首次启动种子化）：删除 = 物理删除官方预设目录，插件目录模板保留。
            // 宿主 agent-presets roster 即目录列表，删除后自然消失。
            const result = removeUserPreset(id)
            if (!result.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-delete-rejected', message: result.message })
              return
            }
            writeBridgeJson(res, 200, { ok: true, value: { id } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.presetClone,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id.trim() : ''
            if (id.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-clone-rejected', message: '缺少预设 id' })
              return
            }
            const result = cloneBuiltinPreset(id, record.autoSuffix === true)
            if (!result.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-clone-rejected', message: result.message })
              return
            }
            writeBridgeJson(res, 200, { ok: true, value: { id: result.id } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.presetDuplicate,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id.trim() : ''
            if (id.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-duplicate-rejected', message: '缺少预设 id' })
              return
            }
            const result = duplicateUserPreset(id)
            if (!result.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-duplicate-rejected', message: result.message })
              return
            }
            writeBridgeJson(res, 200, { ok: true, value: { id: result.id } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.presetOpen,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id.trim() : ''
            if (id.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-open-rejected', message: '缺少预设 id' })
              return
            }
            const result = openPresetLocation(id)
            if (!result.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-open-rejected', message: `${result.message}（${result.path}）` })
              return
            }
            writeBridgeJson(res, 200, { ok: true, value: { path: result.path } })
          },
        }),
        // ---- 角色卡库：素材+参数独立存储，按需导入/移除当前预设 ----
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.charactersImport,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            if (body === null || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            // 与预设包同一套入口校验：非法 preview/摘要一律 400，且发生在写入之前。
            const request = readImportRequestParams(record)
            if (!request.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: request.message })
              return
            }
            if (!guardPresetWrite(dir, res)) return
            try {
              const files = await expandPresetSource(request.params.sourceId === undefined ? readBridgeFiles(record.files) : assetSources.read(request.params.sourceId))
              if (getPresetConfigsDir?.() !== dir) {
                writeBridgeJson(res, 409, { ok: false, code: 'characters-preview-stale', message: '当前预设已切换，请重新预览' })
                return
              }
              const prepared = prepareImport(files, 'character', request.params)
              if (prepared.state !== 'ready') {
                if (!request.params.preview) throw new Error('请先选择内容类型或提示顺序组并重新预览')
                writeBridgeJson(res, 200, { ok: true, value: { preview: true, ...prepared } })
                return
              }
              const root = canonicalPresetRoot(userPresetsDir())
              if (assertPresetDirectory(root, basename(dir)) !== realpathSync(dir)) throw new Error('当前预设不属于可写的官方预设根')
              const cards = canonicalPresetRoot(charactersDir(root), true)
              let targetId = request.params.targetId ?? prepared.spec.id
              if (request.params.targetId === undefined && request.params.overwrite !== true) {
                const wanted = targetId
                for (let n = 1; presetPathExists(join(cards, targetId)); n++) targetId = `${wanted}-copy${n === 1 ? '' : '-' + n}`
              }
              assertPresetId(targetId)
              const options = { ...request.params, targetId }
              const converted = previewCharacterCard(files, options)
              if (!converted.ok) throw new Error(converted.message)
              const version = directoryVersionOf(join(cards, targetId))
              const previewRevision = computePreviewRevision({
                files: [{ path: 'source', content: converted.sourceDigest }, { path: 'choices', content: JSON.stringify([targetId, request.params.targetName ?? '', request.params.overwrite === true, request.params.sourceKind ?? null]) }],
                ...(request.params.promptOrderCharacterId === undefined ? {} : { orderCharacterId: request.params.promptOrderCharacterId }),
                converter: 'asset-character/1',
                target: { kind: 'character-card', targetId, targetVersion: version, ownerPreset: JSON.stringify([root, basename(dir), directoryVersionOf(dir)]) },
              })
              if (request.params.preview) {
                const summary = { sourceName: converted.sourceName, kind: converted.kind, targetId, targetName: converted.name, exists: version !== null,
                  files: files.map((file) => ({ path: file.path, bytes: decodeAssetFile(file).length })), configCount: prepared.spec.promptConfigs?.length ?? 0, warnings: [] }
                writeBridgeJson(res, 200, { ok: true, value: { preview: true, state: 'ready', name: converted.name, summary, sourceDigest: converted.sourceDigest, previewRevision, ...(converted.report === undefined ? {} : { report: converted.report }) } })
                return
              }
              if (request.params.expectedPreviewRevision !== previewRevision || request.params.expectedSourceDigest !== converted.sourceDigest) {
                writeBridgeJson(res, 409, { ok: false, code: 'characters-preview-stale', message: '预览已过期：来源、选择或目标版本已变化，请重新预览' })
                return
              }
              if (version !== null && request.params.overwrite !== true) throw new Error('角色已存在，请明确选择更新或另存')
              const result = importCharacterCard(root, files, options)
              if (!result.ok) throw new Error(result.message)
              writeBridgeJson(res, 200, { ok: true, value: { id: result.id, name: result.name } })
            } catch (error) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.charactersImportStream,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            writeBridgeJson(res, 410, { ok: false, code: 'asset-client-upgrade-required', message: '请刷新页面：角色卡需先上传暂存并预览，再确认导入' })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.charactersList,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            const characters = listCharacterCards(dirname(dir), basename(dir))
            writeBridgeJson(res, 200, { ok: true, value: { characters } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.charactersDelete,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id.trim() : ''
            if (id.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: '缺少角色卡 id' })
              return
            }
            if (!guardPresetWrite(dir, res)) return
            const result = deleteCharacterCard(dirname(dir), id)
            if (!result.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: result.message })
              return
            }
            writeBridgeJson(res, 200, { ok: true, value: { id } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.charactersApply,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id.trim() : ''
            if (id.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: '缺少角色卡 id' })
              return
            }
            if (!guardPresetWrite(dir, res)) return
            const result = applyCharacterToPreset(dirname(dir), basename(dir), id)
            if (!result.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: result.message })
              return
            }
            void runOverridesChange()
            writeBridgeJson(res, 200, { ok: true, value: { id, count: result.count } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.charactersRemove,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id.trim() : ''
            if (id.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: '缺少角色卡 id' })
              return
            }
            if (!guardPresetWrite(dir, res)) return
            const result = removeCharacterFromPreset(dirname(dir), basename(dir), id)
            if (!result.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: result.message })
              return
            }
            void runOverridesChange()
            writeBridgeJson(res, 200, { ok: true, value: { id, count: result.count } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.subagentToolPolicy,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            if (!guardPresetIdentity(record, dir, res)) return
            // 无 policy 载荷 = 读取（preset.yml 顶层 subagentToolPolicy 段）。
            if (record.policy === undefined) {
              try {
                const spec = loadPresetSpec(dir)
                const policy = spec.subagentToolPolicy ?? null
                writeBridgeJson(res, 200, { ok: true, value: { policy } })
              } catch {
                writeBridgeJson(res, 200, { ok: true, value: { policy: null } })
              }
              return
            }
            if (!guardPresetWrite(dir, res)) return
            try {
              const policy = record.policy
              const policyUrl = pathToFileURL(join(packageEngineDir(), 'subagent-tool-policy-core.mjs'))
              const core = await import(policyUrl.href) as {
                validateSubagentToolPolicy: (raw: unknown) => string[]
              }
              const isEmpty = policy === null || (typeof policy === 'object' && !Array.isArray(policy) && Object.keys(policy as Record<string, unknown>).length === 0)
              const errors = isEmpty ? [] : core.validateSubagentToolPolicy(policy)
              if (errors.length > 0) {
                writeBridgeJson(res, 409, { ok: false, code: 'subagent-tool-policy-rejected', message: '策略校验失败：' + errors.join('; '), value: { errors } })
                return
              }
              if (!guardPresetIdentity(record, dir, res)) return
              withPresetDoc(dir, (doc) => {
                if (isEmpty) {
                  // 关闭开关：只删除策略段，**保留模块声明**——能力卡仍在，用户可再次打开；
                  // 引擎在策略文件缺失时降级为官方委派行为（见 engine/subagent-tool-policy.mjs）。
                  doc.deleteIn(['subagentToolPolicy'])
                } else {
                  doc.setIn(['subagentToolPolicy'], policy)
                  appendPresetModules(doc, ['subagent-tool-policy'])
                }
              })
              void runOverridesChange()
              writeBridgeJson(res, 200, { ok: true, value: { policy, errors } })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 409, { ok: false, code: 'subagent-tool-policy-rejected', message: '子代理工具策略保存失败：' + message })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.subagentToolPolicyPreview,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            try {
              const spec = loadPresetSpec(dir)
              if (spec.subagentToolPolicy === undefined || spec.subagentToolPolicy === null) {
                writeBridgeJson(res, 400, { ok: false, code: 'subagent-tool-policy-missing', message: '当前预设未配置 subagentToolPolicy' })
                return
              }
              const policyUrl = pathToFileURL(join(packageEngineDir(), 'subagent-tool-policy-core.mjs'))
              const core = await import(policyUrl.href) as {
                compileSubagentToolPolicy: (raw: unknown) => unknown
                resolveSubagentToolPolicy: (compiled: unknown, request: Record<string, unknown>, available: string[]) => unknown
              }
              const compiled = core.compileSubagentToolPolicy(spec.subagentToolPolicy)
              // 预览用 ceiling 工具宇宙作为可用集（策略设计视图；运行时以实际可见工具为准，
              // 统一走同一 resolveSubagentToolPolicy seam，不复制解析算法）。
              const ceilingAllow = (spec.subagentToolPolicy.ceiling as { allow?: unknown })?.allow
              const available = Array.isArray(ceilingAllow) ? ceilingAllow.map(String) : []
              const result = core.resolveSubagentToolPolicy(compiled, record as Record<string, unknown>, available)
              const tool = record.tool === 'subagent_fork' ? 'subagent_fork' : 'subagent'
              const provider = tool === 'subagent_fork' ? 'fork' : 'spawn'
              writeBridgeJson(res, 200, { ok: true, value: { result: { ...(result as Record<string, unknown>), tool, provider, providerCapability: '运行时创建前校验 toolFilter/continuable/depth/model-route' } } })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 409, { ok: false, code: 'subagent-tool-policy-preview-failed', message: '策略预览失败：' + message })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.engineCapability,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const body = asRecord(parsedBody.body)
            if (!guardPresetIdentity(body, dir, res)) return
            const action = body.action
            const id = action === 'create' || action === 'remove' ? body.capabilityId : action === 'create-recipe' ? body.recipeId : undefined
            if ((action !== 'create' && action !== 'remove' && action !== 'create-recipe') || typeof id !== 'string' || id.trim().length === 0 || id.length > 128) {
              writeBridgeJson(res, 400, { ok: false, code: 'engine-capability-invalid', message: '能力或 recipe 请求格式无效' })
              return
            }
            if (!guardPresetWrite(dir, res)) return
            const run = capabilityQueue.then(async () => {
              if (!guardPresetIdentity(body, dir, res)) return
              const file = join(dir, 'preset.yml')
              let original: string | undefined
              try {
                original = readFileSync(file, 'utf8')
                const result = action === 'remove'
                  ? removeEngineCapabilityFromPreset(dir, id.trim())
                  : createEngineCapabilityInPreset(dir, action === 'create'
                    ? { action: 'create', capabilityId: id.trim() }
                    : { action: 'create-recipe', recipeId: id.trim() })
                if (result.changed) afterCapabilityChange?.()
                writeBridgeJson(res, 200, { ok: true, value: result })
              } catch (error) {
                // 候选校验或重建失败：恢复原 preset.yml；生成目录由 writePreset 自身保留旧版。
                if (original !== undefined) {
                  try {
                    atomicWriteTextFile(file, original)
                    invalidatePresetSpec(dir)
                  } catch { /* 保留错误响应，备份由上层写盘策略处理 */ }
                }
                const message = error instanceof Error ? error.message : String(error)
                writeBridgeJson(res, 409, { ok: false, code: 'engine-capability-rejected', message: `引擎能力变更失败：${message}` })
              }
            })
            capabilityQueue = run.then(() => undefined, () => undefined)
            await run
          },
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'prompt-tool: settings bridge')
  })

  // 工具面（/tool-surface）：只读运行态端点，独立动态等待 agents+tools，
  // 不扩大 src/index.ts 静态 inject。只返回存活本地 Agent 实际可见工具
  // 的 name/description 摘要，不挂载/激活其他预设，也不静态估算。
  ctx.inject(['agents', 'tools', 'webServer'], (stx: Context) => {
    stx.effect(() => {
      const disposers: Array<() => void> = []
      const register = (endpoint: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): void => {
        disposers.push(stx.webServer.register({ kind: 'exact', path: SETTINGS_BRIDGE_PREFIX + endpoint, handler }))
      }
      register(BRIDGE_ENDPOINTS.toolSurface, async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeBridgeJson(res, 403, { ok: false, code: 'settings-not-exposed', message: 'loopback requests only' })
          return
        }
        if (req.method !== 'POST') {
          writeBridgeJson(res, 405, { ok: false, code: 'settings-not-exposed', message: 'method not allowed: ' + (req.method ?? '') })
          return
        }
        const parsedBody = await readBridgeBodyForHandler(req, res)
        if (parsedBody === undefined) return
        const { body } = parsedBody
        const record = (body ?? {}) as Record<string, unknown>
        const hasSessionId = Object.prototype.hasOwnProperty.call(record, 'sessionId')
        const hasPresetId = Object.prototype.hasOwnProperty.call(record, 'presetId')
        const sessionId = hasSessionId && typeof record.sessionId === 'string' ? record.sessionId.trim() : undefined
        const presetId = hasPresetId && typeof record.presetId === 'string' ? record.presetId.trim() : undefined
        if ((hasSessionId && sessionId === undefined) || (hasPresetId && presetId === undefined)
          || (sessionId === '' || presetId === '')) {
          writeBridgeJson(res, 400, { ok: false, code: 'tool-surface-invalid', message: 'sessionId/presetId 必须是非空字符串' })
          return
        }
        if ((sessionId === undefined) === (presetId === undefined)) {
          writeBridgeJson(res, 400, { ok: false, code: 'tool-surface-invalid', message: 'sessionId 与 presetId 必须且只能提供一个非空字符串' })
          return
        }
        if ((sessionId ?? presetId ?? '').length > 256) {
          writeBridgeJson(res, 400, { ok: false, code: 'tool-surface-invalid', message: 'sessionId/presetId 长度不能超过 256' })
          return
        }
        if (sessionId !== undefined) {
          const agent = stx.agents.get(sessionId as never)
          if (agent === undefined) {
            writeBridgeJson(res, 404, { ok: false, code: 'tool-surface-unknown-session', message: '当前没有存活的本地 Agent 对应此 sessionId（冷态/远程子代理不支持）' })
            return
          }
          try {
            const tools = projectToolSchemas(stx.tools.schemas(agent))
            writeBridgeJson(res, 200, { ok: true, value: { source: 'session', sessionId, tools } })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            writeBridgeJson(res, 409, { ok: false, code: 'tool-surface-failed', message })
          }
          return
        }
        type AgentPresetsLike = {
          list: () => Promise<readonly { id?: unknown }[]>
          standingKeyFor: (id: string) => Promise<unknown>
        }
        // agentPresets 不在本端点的 inject 列表内：ctx.agentPresets 属性访问会被 Cordis
        // 拒绝（cannot get property "agentPresets" without inject），整条请求以 400 空响应
        // 结束；与官方 plugin-inventory/session-controller 一致，用 ctx.get 解析可选服务。
        const agentPresets = (stx as Context & { get?: (name: string) => unknown }).get?.('agentPresets') as AgentPresetsLike | undefined
        if (agentPresets === undefined) {
          writeBridgeJson(res, 503, { ok: false, code: 'tool-surface-unavailable', message: 'agentPresets 服务尚未就绪' })
          return
        }
        let roster: readonly { id?: unknown }[]
        try {
          roster = await agentPresets.list()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeBridgeJson(res, 503, { ok: false, code: 'tool-surface-unavailable', message: `官方预设 roster 读取失败：${message}` })
          return
        }
        if (!roster.some((preset) => preset.id === presetId)) {
          writeBridgeJson(res, 404, { ok: false, code: 'tool-surface-unknown-preset', message: `未知官方预设：${presetId}` })
          return
        }
        try {
          const scope = await agentPresets.standingKeyFor(presetId!)
          const tools = projectToolSchemas(stx.tools.schemas(scope as object))
          writeBridgeJson(res, 200, { ok: true, value: { source: 'preset', presetId, tools } })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeBridgeJson(res, 409, { ok: false, code: 'tool-surface-preset-failed', message })
        }
      })
      // 世界书诊断（只读）：返回当前会话最近一次选择的观测记录；读取不触发求值、抽样或时间窗推进。
      register(BRIDGE_ENDPOINTS.worldBookDiagnostics, async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeBridgeJson(res, 403, { ok: false, code: 'settings-not-exposed', message: 'loopback requests only' })
          return
        }
        if (req.method !== 'POST') {
          writeBridgeJson(res, 405, { ok: false, code: 'settings-not-exposed', message: 'method not allowed: ' + (req.method ?? '') })
          return
        }
        const parsedBody = await readBridgeBodyForHandler(req, res)
        if (parsedBody === undefined) return
        const session = readSessionIdField(parsedBody.body)
        if (!session.ok) {
          writeBridgeJson(res, 400, { ok: false, code: 'world-book-diagnostics-invalid', message: session.message })
          return
        }
        const empty = { records: [], truncated: false, step: 0, evaluated: false }
        const agent = session.sessionId === undefined ? undefined : stx.agents.get(session.sessionId as never) as { session?: unknown } | undefined
        const snapshot = agent?.session === undefined ? empty : lastWorldBookDiagnostics(agent.session)
        writeBridgeJson(res, 200, {
          ok: true,
          value: {
            records: Array.isArray(snapshot.records) ? snapshot.records.slice(0, 200) : [],
            truncated: snapshot.truncated === true,
            step: typeof snapshot.step === 'number' ? snapshot.step : 0,
            evaluated: snapshot.evaluated === true,
          },
        })
      })
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'prompt-tool: tool surface')
  })
  return { invalidateDescriptor: () => invalidateCachedDescriptor() }
}

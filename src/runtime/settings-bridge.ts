/** 自建 loopback settings bridge：Web 设置页数据通道（提示词配置数组经此输出到 UI）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { PARAM_KEYS } from '../config.ts'
import { listAdvertisedModels, peekModelCatalog, type ModelDetection } from './models.ts'
import type { SkillCatalogEntry } from '../config.ts'
import { loadPromptConfigFiles } from '../host/prompt-configs.ts'
import { validatePromptConfigs } from './configs-validate.ts'
import { loadPromptTemplates, loadToolTemplates } from '../host/templates.ts'
import { fixSkillEntry } from './skill-fix.ts'
import {
  assertCompositionArray,
  cloneBuiltinPreset,
  duplicateUserPreset,
  listBuiltinTemplates,
  listPresets,
  loadPresetSpec,
  openPresetLocation,
  parseImportedPresetId,
  removeUserPreset,
  renderComposition,
  resolvePresetParams,
  resolvePresetDir,
  savePresetParams,
  userPresetsDir,
  withPresetDoc,
} from '../host/manifest.ts'
import type { PresetSpec } from '../host/manifest.ts'
import {
  applyCharacterToPreset,
  deleteCharacterCard,
  importCharacterCard,
  importCharacterCardFile,
  listCharacterCards,
  removeCharacterFromPreset,
} from '../host/characters.ts'
import { convertStToPreset, mergeStPresets } from '../host/sillytavern.ts'
import { BRIDGE_ENDPOINTS, MAX_BRIDGE_BODY_BYTES, MAX_CHARACTER_CARD_STREAM_BYTES, SETTINGS_BRIDGE_PREFIX } from '../shared/bridge-contract.ts'
import { validateEngineParamValues } from '../shared/engine-params.ts'
import { DEFAULT_PRESET_DIR } from '../host/paths.ts'


export interface SkillsBridgeState {
  activeSkillsDirs: string[]
  skillCatalog: SkillCatalogEntry[]
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

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** 读取 JSON bridge 请求体；所有 JSON 端点统一使用 32 MiB 内存上限。 */
async function readBridgeBody(
  req: IncomingMessage,
): Promise<{ body: unknown; tooLarge: boolean; receivedBytes: number }> {
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
  if (overflow) return { body: undefined, tooLarge: true, receivedBytes: size }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, tooLarge: false, receivedBytes: size }
  } catch {
    return { body: undefined, tooLarge: false, receivedBytes: size }
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
  return { body: result.body }
}

class StreamBodyTooLargeError extends Error {
  constructor(
    readonly receivedBytes: number,
    readonly maxBytes: number,
  ) {
    super(`stream body exceeds ${maxBytes} bytes`)
    this.name = 'StreamBodyTooLargeError'
  }
}

async function writeStreamBody(
  req: IncomingMessage,
  filePath: string,
  maxBytes: number,
): Promise<number> {
  let receivedBytes = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      receivedBytes += buffer.length
      if (receivedBytes > maxBytes) {
        callback(new StreamBodyTooLargeError(receivedBytes, maxBytes))
        return
      }
      callback(null, buffer)
    },
  })
  await pipeline(req, limiter, createWriteStream(filePath, { flags: 'wx' }))
  return receivedBytes
}

function uploadFileName(req: IncomingMessage): string {
  const value = req.headers['x-file-name']
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || raw.length === 0) return 'character-card.bin'
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 预设导入失败回滚：删除新目录并恢复同名预设备份（如有）。 */
function restorePresetImport(targetDir: string, backupDir: string | undefined): void {
  try {
    rmSync(targetDir, { recursive: true, force: true })
  } catch {
    // 删除失败不阻断恢复
  }
  if (backupDir !== undefined) {
    try {
      renameSync(backupDir, targetDir)
    } catch {
      // 恢复失败保留备份目录供人工处理
    }
  }
}

/** 自建 loopback settings bridge：替代 registerConfigurableProviders，避免模型设置区出现插件条目。 */
export function registerSettingsBridge(
  ctx: Context,
  ns: string,
  getModelsState: () => ModelDetection,
  getSkillsState: () => SkillsBridgeState,
  getEngineStrategyDir: () => string,
  afterSkillFix?: () => void,
  /** 生成目录（presetDir）：读取实际生效的提示词配置（引擎加载源）。 */
  getPresetConfigsDir?: () => string,
  /** 内容导入完成回调：批量 scope 只触发一次重建（更新运行时文本并重建预设）。 */
  afterPresetImport?: (scopes: Array<'preset' | 'agents'>) => void,
  /** 参数覆盖写入回调（重建预设使参数生效）。 */
  afterOverridesChange?: () => void,
  /** 预设包导入完成回调（物化导入预设：组合/配置目录/共享引擎落盘，宿主 discovery 可见）。 */
  afterPresetPackageImport?: (id: string) => void,
): { invalidateDescriptor: () => void } {
  let invalidateCachedDescriptor: () => void = () => {}
  // 动态等待 webServer：webServer 由 @deepseek-ai/dsh-web-app 提供。
  // profile 首次缺少该 bundle 时，本子插件先 pending 但不阻塞启动审计；
  // ensureWebSurface 会把 bundle 补进 manifest，重启后本子插件自动激活。
  ctx.inject(['settings', 'webServer'], (sctx: Context) => {
    sctx.effect(() => {
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
      /** 引擎能力矩阵（meta 端点与 /bootstrap 共用）：动态 import 引擎 schema。 */
      const loadEngineMeta = async (): Promise<Record<string, unknown>> => {
        const engineMetaUrl = new URL('../engine/schema.mjs', import.meta.url)
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
      const collectDescribeExtras = (): Record<string, unknown> => {
        const detection = getModelsState()
        const skillsState = getSkillsState()
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
        const modelCatalog = peekModelCatalog()
        // 引擎参数按预设存储：/describe 附带激活预设参数（settings 已不承载；
        // 客户端 fields 参数键由此合并，promptConfigs 仍以 /prompt-configs 实际配置为准）。
        let presetParams: Record<string, unknown> = {}
        // 当前预设模板消息批层（pre-step）配置数：UI 消息批层入口开关联动——
        // 模板无 pre-step 配置（layer 缺省即 pre-step）时开关关闭且禁编辑。
        let templatePreStepCount = 0
        try {
          // 激活预设目录以服务端 runtime 为准（getPresetConfigsDir），而不是 descriptor
          // 缓存里的 presetTemplate——descriptor 有 30s TTL，切换预设后若缓存未失效，
          // 这里会读旧预设参数，与下方 readParamOverrides/readPromptConfigs(新目录) 不同源。
          const activeDir = getPresetConfigsDir?.() ?? ''
          const templateName = activeDir.length > 0 ? basename(activeDir) : 'anchored'
          const spec = loadPresetSpec(activeDir.length > 0 ? activeDir : resolvePresetDir(templateName))
          presetParams = resolvePresetParams(spec, {})
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
          hostDefaultModel,
          templatePreStepCount,
          modelsAvailable: detection.available,
          providers: detection.providers,
          modelCatalog,
          modelsError: detection.error,
          activeSkillsDirs: skillsState.activeSkillsDirs,
          skillsDirExists: Object.fromEntries(skillsState.activeSkillsDirs.map((dir) => [dir, existsSync(dir)])),
          skillCatalog: skillsState.skillCatalog,
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
          for (const [key, value] of Object.entries(spec.params ?? {})) {
            if (!PARAM_KEYS.has(key) && typeof value === 'string') variables[key] = value
          }
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
            // 工作台首屏/保存后刷新的聚合读取：meta + describe 事实 + 参数覆盖 +
            // 模板变量 + 实际生效配置。此前客户端串行 5 个端点（每端点独立读盘
            // parse preset.yml）；聚合后单请求、preset.yml 命中 mtime 缓存仅解析一次。
            try {
              const meta = await loadEngineMeta()
              const dir = getPresetConfigsDir?.() ?? ''
              const extras = collectDescribeExtras()
              writeBridgeJson(res, 200, {
                ok: true,
                value: descriptor,
                meta: { meta },
                overrides: { overrides: dir.length > 0 ? readParamOverrides(dir) : {} },
                variables: dir.length > 0 ? readPresetVariables(dir) : { variables: {}, enabled: true },
                promptConfigs: { promptConfigs: readPromptConfigs(dir) },
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
            writeBridgeJson(res, 200, { ok: true, value: descriptor, ...collectDescribeExtras() })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.models,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const modelCatalog = await listAdvertisedModels(sctx)
            writeBridgeJson(res, 200, { ok: true, value: { modelCatalog } })
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
            const result = await validatePromptConfigs(record.promptConfigs, { strategyDir: getEngineStrategyDir() })
            writeBridgeJson(res, 200, { ok: true, value: result })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.skillFix,
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
            const folder = typeof record.folder === 'string' ? record.folder : ''
            // 多目录：优先按条目来源目录修复；目录不存在/条目缺失时回退第一个目录。
            const state = getSkillsState()
            const sourceDir = state.skillCatalog.find((entry) => entry.folder === folder)?.dir
              ?? state.activeSkillsDirs[0]
            const result = fixSkillEntry(sourceDir ?? '', folder)
            if (!result.fixed) {
              writeBridgeJson(res, 400, { ok: false, code: 'skill-fix-failed', message: result.error ?? '修复失败' })
              return
            }
            // 目录重命名后同步 settings 里的 skillSwitches / skillOrder 键。
            const descriptor = findDescriptor()
            if (descriptor !== undefined && result.folder !== result.fixedFolder) {
              const value = asRecord(descriptor.value)
              const base = asRecord(descriptor.base)
              const switches = asRecord(value.skillSwitches !== undefined ? value.skillSwitches : base.skillSwitches)
              const orderValue = value.skillOrder !== undefined ? value.skillOrder : base.skillOrder
              const order = Array.isArray(orderValue) ? orderValue.filter((item): item is string => typeof item === 'string') : []
              const ops: SettingsPathOp[] = []
              if (Object.prototype.hasOwnProperty.call(switches, result.folder)) {
                ops.push({ op: 'set', path: ['skillSwitches', result.fixedFolder], value: switches[result.folder] })
                ops.push({ op: 'unset', path: ['skillSwitches', result.folder] })
              }
              if (order.includes(result.folder)) {
                ops.push({ op: 'set', path: ['skillOrder'], value: order.map((item) => item === result.folder ? result.fixedFolder : item) })
              }
              if (ops.length > 0) {
                try {
                  await sctx.settings.mutate(ns, ops)
                  invalidateDescriptor()
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error)
                  writeBridgeJson(res, 409, { ok: false, code: 'settings-rejected', message: `技能文件已修复，但 settings 键迁移失败：${message}` })
                  return
                }
              }
            }
            afterSkillFix?.()
            writeBridgeJson(res, 200, {
              ok: true,
              value: {
                folder: result.folder,
                fixedFolder: result.fixedFolder,
                name: result.name,
                actions: result.actions,
                skillCatalog: getSkillsState().skillCatalog,
              },
            })
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
            // 实际生效配置 = 生成目录 prompt-configs/（引擎加载源）；
            // settings.promptConfigs 仅是用户覆盖层，默认为空不代表无配置。
            const dir = getPresetConfigsDir?.() ?? ''
            writeBridgeJson(res, 200, { ok: true, value: { promptConfigs: readPromptConfigs(dir) } })
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
            try {
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
            // 无载荷 = 读取（preset.yml params 子集，兼容旧读回）。
            if (record.overrides === undefined && record.promptConfigs === undefined) {
              writeBridgeJson(res, 200, { ok: true, value: { overrides: readParamOverrides(dir) } })
              return
            }
            const rawOverrides = record.overrides !== null && typeof record.overrides === 'object' && !Array.isArray(record.overrides)
              ? record.overrides as Record<string, unknown>
              : undefined
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
              savePresetParams(
                presetRoot,
                templateName,
                rawOverrides,
                Array.isArray(record.promptConfigs) ? record.promptConfigs as unknown[] : undefined,
              )
              // 预设切换前保存当前配置卡时只需落盘，不立即重建；
              // 后续 settings presetTemplate 变更会让目标预设完成唯一一次重建。
              if (record.rebuild !== false) afterOverridesChange?.()
              writeBridgeJson(res, 200, {
                ok: true,
                value: {
                  ...(record.overrides !== undefined ? { overrides: record.overrides } : {}),
                  ...(record.promptConfigs !== undefined ? { promptConfigs: record.promptConfigs } : {}),
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
            // 预设级模板变量（非 PARAM_KEYS 的内容变量）：写激活预设 preset.yml
            // 顶层 variables 段；writePreset 渲染时展开进 prompt-configs/variables.yml，
            // 引擎加载合并进每条配置 variables（官方插值源）。配置卡片 variables
            // 只显示配置自身，模板变量统一在本卡片编辑。
            const presetRoot = dirname(dir)
            const templateName = basename(dir)
            const parsedBody = await readBridgeBodyForHandler(req, res)
            if (parsedBody === undefined) return
            const { body } = parsedBody
            const record = (body ?? {}) as Record<string, unknown>
            // 无载荷 = 读取（preset.yml 顶层 variables + 插值开关）。
            if (record.variables === undefined && record.enabled === undefined) {
              writeBridgeJson(res, 200, { ok: true, value: readPresetVariables(dir) })
              return
            }
            try {
              savePresetParams(
                presetRoot,
                templateName,
                undefined,
                undefined,
                record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
                  ? record.variables as Record<string, string>
                  : undefined,
                typeof record.enabled === 'boolean' ? record.enabled : undefined,
              )
              afterOverridesChange?.()
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
            // 无载荷 = 读取（preset.yml 顶层 customTools 段）。
            if (record.customTools === undefined) {
              try {
                const spec = loadPresetSpec(dir)
                const customTools = Array.isArray(spec.customTools) ? spec.customTools : []
                writeBridgeJson(res, 200, { ok: true, value: { customTools } })
              } catch {
                writeBridgeJson(res, 200, { ok: true, value: { customTools: [] } })
              }
              return
            }
            try {
              const customTools = record.customTools
              if (!Array.isArray(customTools)) {
                writeBridgeJson(res, 400, { ok: false, code: 'custom-tools-invalid', message: 'customTools 必须是数组' })
                return
              }
              withPresetDoc(dir, (doc) => {
                if (customTools.length === 0) doc.deleteIn(['customTools'])
                else doc.setIn(['customTools'], customTools)
              })
              afterOverridesChange?.()
              writeBridgeJson(res, 200, { ok: true, value: { customTools } })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 409, { ok: false, code: 'custom-tools-rejected', message: `自定义工具保存失败：${message}` })
            }
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
            const files = Array.isArray(record.files) ? record.files : []
            let normalized = files.flatMap((entry) => {
              if (entry === null || typeof entry !== 'object') return []
              const f = entry as { path?: unknown; name?: unknown; content?: unknown }
              const path = typeof f.path === 'string' && f.path.length > 0 ? f.path : (typeof f.name === 'string' ? f.name : '')
              const content = typeof f.content === 'string' ? f.content : ''
              if (path.length === 0) return []
              // 路径穿越防护：仅允许扁平相对路径（不含 .. 与盘符）。
              if (path.includes('..') || /^[a-zA-Z]:/.test(path) || path.startsWith('/') || path.startsWith('\\')) return []
              return [{ path, content }]
            })
            // 预设定义文件：顶层 preset.yml 优先；缺失时用顶层任意 *.yml/*.yaml
            // （排除 agent.cordis.yml 组合文件），支持自定义定义文件名导入。
            const topRel = (path: string): string => {
              const slash = path.indexOf('/')
              return slash > 0 ? path.slice(slash + 1) : path
            }
            const isDefinition = (entry: { path: string }): boolean => {
              const rel = topRel(entry.path)
              return /\.ya?ml$/i.test(rel) && rel !== 'agent.cordis.yml'
            }
            let presetYaml = normalized.find((entry) => topRel(entry.path) === 'preset.yml')
            if (presetYaml === undefined) presetYaml = normalized.find(isDefinition)
            // SillyTavern JSON 预设：无定义文件时把所有 .json 交给转换引擎
            // （角色卡 × 响应预设多文件 → 合并为单个预设），转换消费的 json 不再落盘。
            if (presetYaml === undefined) {
              const stJsons = normalized.filter((entry) => /\.json$/i.test(topRel(entry.path)))
              if (stJsons.length > 0) {
                try {
                  const converted = stJsons.map((entry) => {
                    const baseName = topRel(entry.path).replace(/\.json$/i, '') || 'sillytavern'
                    return convertStToPreset(JSON.parse(entry.content), baseName)
                  })
                  const merged = converted.length > 1 ? mergeStPresets(converted) : converted[0]!
                  presetYaml = { path: 'preset.yml', content: stringifyYaml(merged, { lineWidth: 0 }) }
                  normalized = [
                    ...normalized.filter((entry) => !/\.json$/i.test(topRel(entry.path))),
                    presetYaml,
                  ]
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error)
                  writeBridgeJson(res, 400, { ok: false, code: 'preset-package-invalid', message: `SillyTavern JSON 转换失败：${message}` })
                  return
                }
              }
            }
            if (presetYaml === undefined) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-package-invalid', message: '导入包缺少预设定义文件（preset.yml / 任意 *.yml/*.yaml / SillyTavern *.json）' })
              return
            }
            if (presetYaml.content.trim().length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-package-invalid', message: 'preset.yml 内容为空' })
              return
            }
            // 导入前校验：preset.yml 必须可解析为 YAML 映射（fail loud，避免坏包导入后静默消失）。
            let parsedSpec: Record<string, unknown>
            try {
              const parsed = parseYaml(presetYaml.content, { logLevel: 'silent' })
              if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('preset.yml 不是 YAML 映射')
              }
              parsedSpec = parsed as Record<string, unknown>
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 400, { ok: false, code: 'preset-package-invalid', message: `preset.yml 解析失败：${message}` })
              return
            }
            // 预设 id 取自 preset.yml；缺失时用 preset.yml 所在目录名（单文件导入无目录段 → imported-preset）。
            const slashIdx = presetYaml.path.lastIndexOf('/')
            const topDir = slashIdx >= 0 ? presetYaml.path.slice(0, slashIdx) : ''
            const fallback = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(topDir) ? topDir : 'imported-preset'
            const id = parseImportedPresetId(presetYaml.content, fallback)
            const targetDir = join(userPresetsDir(), id)
            // 同名预设已存在 → 先备份（导入失败时恢复，成功后保留备份供回退）。
            let backupDir: string | undefined
            if (existsSync(targetDir)) {
              backupDir = join(userPresetsDir(), `.${id}.bak-${Date.now().toString(36)}`)
              renameSync(targetDir, backupDir)
            }
            try {
              mkdirSync(targetDir, { recursive: true })
              for (const entry of normalized) {
                // 唯一剥离点：去掉顶层目录段（文件夹导入时 webkitRelativePath 的顶层）；
                // preset.yml 在顶层或单文件导入时无目录段。客户端不再剥离，防止双重剥层。
                const slash = entry.path.indexOf('/')
                const rel = slash > 0 ? entry.path.slice(slash + 1) : entry.path
                if (rel.length === 0) continue
                // 被选中的定义文件统一落盘为 preset.yml（自定义文件名导入后按项目约定归一）。
                const dest = join(targetDir, entry === presetYaml ? 'preset.yml' : rel)
                // 子目录（如 engine/、agent.cordis.yml 同层）逐级创建。
                mkdirSync(dirname(dest), { recursive: true })
                // 角色卡 PNG（客户端已转 base64 上传）解码落盘为头像资产 avatar.png。
                if (/\.png$/i.test(rel)) {
                  writeFileSync(dest, Buffer.from(entry.content, 'base64'))
                } else {
                  writeFileSync(dest, entry.content, 'utf8')
                }
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              restorePresetImport(targetDir, backupDir)
              writeBridgeJson(res, 500, { ok: false, code: 'preset-import-failed', message: `预设写入失败：${message}` })
              return
            }
            // 组合路径可解析校验（modules 存在性 / composition / agent.cordis.yml 回退）。
            try {
              const spec = { ...parsedSpec, id } as PresetSpec
              const composition = renderComposition(spec, {}, targetDir)
              assertCompositionArray(composition, spec)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              restorePresetImport(targetDir, backupDir)
              writeBridgeJson(res, 400, { ok: false, code: 'preset-package-invalid', message: `预设组合校验失败：${message}` })
              return
            }
            // 物化导入预设：仅写 preset.yml 时宿主 discovery 不可见（缺 agent.cordis.yml
            // 组合本体 / prompt-configs / 共享引擎），导入成功即触发宿主重建该预设。
            afterPresetPackageImport?.(id)
            writeBridgeJson(res, 200, {
              ok: true,
              value: { id, ...(backupDir !== undefined ? { backupPath: backupDir } : {}) },
            })
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
            const id = typeof record.id === 'string' && record.id.trim().length > 0 ? record.id.trim() : 'anchored'
            try {
              const dir = resolvePresetDir(id)
              const file = join(dir, 'preset.yml')
              if (!existsSync(file)) throw new Error(`模板 ${id} 无 preset.yml`)
              const content = readFileSync(file, 'utf8')
              const spec = parseYaml(content, { logLevel: 'silent' }) as { id?: unknown; name?: unknown } | null
              writeBridgeJson(res, 200, {
                ok: true,
                value: {
                  id: typeof spec?.id === 'string' ? spec.id : id,
                  name: typeof spec?.name === 'string' ? spec.name : id,
                  content,
                },
              })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 500, { ok: false, code: 'preset-export-failed', message })
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
            // 全部预设都在预设根（首次启动种子化）：删除 = 物理删除官方预设目录，插件目录模板保留。
            // 宿主 agent-presets roster 即目录列表，删除后自然消失。
            const presetDir = typeof value.presetDir === 'string' && value.presetDir.trim().length > 0
              ? value.presetDir
              : typeof base.presetDir === 'string' && base.presetDir.trim().length > 0 ? base.presetDir
                : DEFAULT_PRESET_DIR
            const result = removeUserPreset(id, presetDir)
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
            const descriptor = findDescriptor()
            const value = (descriptor?.value ?? {}) as Record<string, unknown>
            const base = (descriptor?.base ?? {}) as Record<string, unknown>
            const presetDir = typeof value.presetDir === 'string' && value.presetDir.trim().length > 0
              ? value.presetDir
              : typeof base.presetDir === 'string' && base.presetDir.trim().length > 0 ? base.presetDir
                : DEFAULT_PRESET_DIR
            const result = duplicateUserPreset(id, presetDir)
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
            const descriptor = findDescriptor()
            const value = (descriptor?.value ?? {}) as Record<string, unknown>
            const base = (descriptor?.base ?? {}) as Record<string, unknown>
            const presetDir = typeof value.presetDir === 'string' && value.presetDir.trim().length > 0
              ? value.presetDir
              : typeof base.presetDir === 'string' && base.presetDir.trim().length > 0 ? base.presetDir
                : DEFAULT_PRESET_DIR
            const result = openPresetLocation(id, presetDir)
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
            const files = Array.isArray(record.files) ? record.files : []
            const normalized = files.flatMap((entry) => {
              if (entry === null || typeof entry !== 'object') return []
              const f = entry as { path?: unknown; content?: unknown }
              const path = typeof f.path === 'string' && f.path.length > 0 ? f.path : ''
              const content = typeof f.content === 'string' ? f.content : ''
              if (path.length === 0) return []
              // 逐段校验防穿越：拒绝 .. 路径段与绝对路径；合法文件名含 '..'（如 a..b.json）不误伤。
              if (/^[a-zA-Z]:/.test(path) || path.startsWith('/') || path.startsWith('\\')) return []
              if (path.split(/[\\/]/).some((segment) => segment === '..')) return []
              return [{ path, content }]
            })
            if (normalized.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: '未收到角色卡文件' })
              return
            }
            const result = importCharacterCard(dirname(dir), normalized)
            if (!result.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: result.message })
              return
            }
            writeBridgeJson(res, 200, { ok: true, value: { id: result.id, name: result.name } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.charactersImportStream,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            const presetRoot = dirname(dir)
            mkdirSync(presetRoot, { recursive: true })
            const tempRoot = mkdtempSync(join(presetRoot, '.characters-upload-'))
            const tempFile = join(tempRoot, 'upload.bin')
            try {
              let receivedBytes = 0
              try {
                receivedBytes = await writeStreamBody(req, tempFile, MAX_CHARACTER_CARD_STREAM_BYTES)
              } catch (error) {
                if (error instanceof StreamBodyTooLargeError) {
                  writeBridgeJson(res, 413, {
                    ok: false,
                    code: 'character-stream-too-large',
                    message: `角色卡文件超过 ${Math.round(error.maxBytes / 1024 / 1024)}MB 流式上限（已收到 ${error.receivedBytes} 字节）`,
                  })
                  return
                }
                throw error
              }
              const result = importCharacterCardFile(presetRoot, tempFile, uploadFileName(req))
              if (!result.ok) {
                writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: result.message })
                return
              }
              writeBridgeJson(res, 200, {
                ok: true,
                value: { id: result.id, name: result.name, receivedBytes },
              })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 500, { ok: false, code: 'characters-stream-failed', message: `角色卡流式导入失败：${message}` })
            } finally {
              rmSync(tempRoot, { recursive: true, force: true })
            }
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
            const result = applyCharacterToPreset(dirname(dir), basename(dir), id)
            if (!result.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: result.message })
              return
            }
            afterOverridesChange?.()
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
            const result = removeCharacterFromPreset(dirname(dir), basename(dir), id)
            if (!result.ok) {
              writeBridgeJson(res, 400, { ok: false, code: 'characters-rejected', message: result.message })
              return
            }
            afterOverridesChange?.()
            writeBridgeJson(res, 200, { ok: true, value: { id, count: result.count } })
          },
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'prompt-tool: settings bridge')
  })
  return { invalidateDescriptor: () => invalidateCachedDescriptor() }
}


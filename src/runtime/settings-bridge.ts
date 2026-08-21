/** 自建 loopback settings bridge：Web 设置页数据通道（提示词配置数组经此输出到 UI）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { SettingsDescriptor, SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { listAdvertisedModels, type ModelDetection } from './models.ts'
import type { SkillCatalogEntry } from '../config.ts'
import { loadPromptConfigFiles } from '../host/prompt-configs.ts'
import { validatePromptConfigs } from './configs-validate.ts'
import { loadPromptTemplates } from '../host/templates.ts'
import { fixSkillEntry } from './skill-fix.ts'
import {
  assertCompositionArray,
  cloneBuiltinPreset,
  listBuiltinTemplates,
  listPresets,
  loadPresetSpec,
  parseImportedPresetId,
  removeUserPreset,
  renderComposition,
  resolvePresetDir,
  userPresetsDir,
} from '../host/manifest.ts'
import type { PresetSpec } from '../host/manifest.ts'
import { convertStToPreset } from '../host/sillytavern.ts'
import { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } from '../shared/bridge-contract.ts'
import { DEFAULT_PRESET_DIR } from '../host/paths.ts'

const MAX_SETTINGS_BRIDGE_BODY = 64 * 1024
/** 预设包导入独立上限（含 .mjs 模块的官方预设可远超 64KB 设置桥上限；8MB 足够）。 */
const PRESET_PACKAGE_MAX_BYTES = 8 * 1024 * 1024

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
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      const originHost = new URL(origin).hostname
      if (originHost !== '127.0.0.1' && originHost !== 'localhost' && originHost !== '[::1]') return false
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

/** 读取桥请求体；超限时返回 tooLarge 标记（由调用方决定状态码与错误信息）。 */
async function readBridgeBody(
  req: IncomingMessage,
  maxBytes = MAX_SETTINGS_BRIDGE_BODY,
): Promise<{ body: unknown; tooLarge: boolean }> {
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
  if (overflow) return { body: undefined, tooLarge: true }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, tooLarge: false }
  } catch {
    return { body: undefined, tooLarge: false }
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
  ns: SettingsNamespace,
  getModelsState: () => ModelDetection,
  getSkillsState: () => SkillsBridgeState,
  getEngineStrategyDir: () => string,
  ensureRegistered: (sctx: Context) => boolean,
  afterSkillFix?: () => void,
  /** 生成目录（presetDir）：读取实际生效的提示词配置（引擎加载源）。 */
  getPresetConfigsDir?: () => string,
  /** 内容导入完成回调（更新运行时文本并重建预设）。 */
  afterPresetImport?: (scope: 'preset' | 'agents') => void,
  /** 参数覆盖写入回调（重建预设使参数生效）。 */
  afterOverridesChange?: () => void,
): void {
  // 动态等待 webServer：webServer 由 @deepseek-ai/dsh-web-app 提供。
  // profile 首次缺少该 bundle 时，本子插件先 pending 但不阻塞启动审计；
  // ensureWebSurface 会把 bundle 补进 manifest，重启后本子插件自动激活。
  ctx.inject(['settings', 'webServer'], (sctx: Context) => {
    sctx.effect(() => {
      const findDescriptor = (): SettingsDescriptor | undefined =>
        sctx.settings.describe({ redactSecrets: true }).find((entry) => String(entry.ns) === String(ns))
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
      const disposers = [
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.meta,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const engineMetaUrl = new URL('../engine/schema.mjs', import.meta.url)
            const { getEngineMeta } = await import(engineMetaUrl.href) as {
              getEngineMeta: () => Record<string, unknown>
            }
            const meta = getEngineMeta() as Record<string, unknown>
            meta.presets = listPresets()
            meta.builtinTemplates = listBuiltinTemplates()
            writeBridgeJson(res, 200, { ok: true, value: { meta } })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.describe,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            ensureRegistered(sctx)
            const descriptor = findDescriptor()
            if (descriptor === undefined) {
              writeBridgeJson(res, 404, { ok: false, code: 'settings-not-exposed', message: 'prompt-tool settings namespace is not registered' })
              return
            }
            const detection = getModelsState()
            const skillsState = getSkillsState()
            const modelCatalog = await listAdvertisedModels(sctx)
            // 当前预设模板消息批层（pre-step）配置数：UI 消息批层入口开关联动——
            // 模板无 pre-step 配置（layer 缺省即 pre-step）时开关关闭且禁编辑。
            let templatePreStepCount = 0
            try {
              const settingsValue = descriptor.value !== null && typeof descriptor.value === 'object'
                ? descriptor.value as Record<string, unknown>
                : {}
              const templateName = typeof settingsValue.presetTemplate === 'string' && (settingsValue.presetTemplate as string).length > 0
                ? settingsValue.presetTemplate as string
                : 'anchored'
              const spec = loadPresetSpec(resolvePresetDir(templateName))
              templatePreStepCount = (spec.promptConfigs ?? []).filter((config) => {
                const layer = (config as { layer?: string }).layer
                return layer === undefined || layer === 'pre-step'
              }).length
            } catch {
              templatePreStepCount = 0
            }
            writeBridgeJson(res, 200, {
              ok: true,
              value: descriptor,
              templatePreStepCount,
              modelsAvailable: detection.available,
              providers: detection.providers,
              modelCatalog,
              modelsError: detection.error,
              activeSkillsDirs: skillsState.activeSkillsDirs,
              skillsDirExists: Object.fromEntries(skillsState.activeSkillsDirs.map((dir) => [dir, existsSync(dir)])),
              skillCatalog: skillsState.skillCatalog,
            })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.mutate,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            ensureRegistered(sctx)
            const { body } = await readBridgeBody(req)
            if (body === null || body === undefined || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            if (!Array.isArray(record.ops)) {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request' })
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
            const { body } = await readBridgeBody(req)
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
            ensureRegistered(sctx)
            const { body } = await readBridgeBody(req)
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
              writeBridgeJson(res, 200, { ok: true, value: { templates } })
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
            try {
              // 实际生效配置 = 生成目录 prompt-configs/（引擎加载源）；
              // settings.promptConfigs 仅是用户覆盖层，默认为空不代表无配置。
              const dir = join(getPresetConfigsDir?.() ?? '', 'prompt-configs')
              const promptConfigs = dir.length > 0 ? loadPromptConfigFiles(dir) : []
              writeBridgeJson(res, 200, { ok: true, value: { promptConfigs } })
            } catch {
              // 生成目录缺失/未生成时降级为空（settings 覆盖层仍可编辑）。
              writeBridgeJson(res, 200, { ok: true, value: { promptConfigs: [] } })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.presetContent,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const { body } = await readBridgeBody(req)
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
            const { body } = await readBridgeBody(req)
            if (body === null || body === undefined || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            const scope = record.scope === 'agents' ? 'agents' : 'preset'
            const content = typeof record.content === 'string' ? record.content : ''
            const dir = getPresetConfigsDir?.() ?? ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'preset-dir-unavailable', message: 'presetDir 未配置' })
              return
            }
            try {
              mkdirSync(dir, { recursive: true })
              writeFileSync(join(dir, scope === 'preset' ? 'preset.md' : 'agents.md'), content, 'utf8')
              afterPresetImport?.(scope)
              writeBridgeJson(res, 200, { ok: true, value: { scope } })
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
            const file = join(dir, 'prompt-tool.overrides.yml')
            const { body } = await readBridgeBody(req)
            const record = (body ?? {}) as Record<string, unknown>
            // 无 overrides 载荷 = 读取；带载荷 = 写入。
            if (record.overrides === undefined) {
              try {
                const raw = readFileSync(file, 'utf8')
                const parsed = parseYaml(raw, { logLevel: 'silent' })
                writeBridgeJson(res, 200, {
                  ok: true,
                  value: { overrides: parsed !== null && typeof parsed === 'object' ? parsed : {} },
                })
              } catch {
                writeBridgeJson(res, 200, { ok: true, value: { overrides: {} } })
              }
              return
            }
            try {
              mkdirSync(dir, { recursive: true })
              writeFileSync(file, stringifyYaml(record.overrides), 'utf8')
              afterOverridesChange?.()
              writeBridgeJson(res, 200, { ok: true, value: { overrides: record.overrides } })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 500, { ok: false, code: 'overrides-write-failed', message })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.importPresetPackage,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const { body, tooLarge } = await readBridgeBody(req, PRESET_PACKAGE_MAX_BYTES)
            if (tooLarge) {
              writeBridgeJson(res, 413, {
                ok: false,
                code: 'preset-package-too-large',
                message: `预设包超过 ${Math.round(PRESET_PACKAGE_MAX_BYTES / 1024 / 1024)}MB 上限`,
              })
              return
            }
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
            // SillyTavern JSON 预设：无定义文件时若含单个 .json → 调用转换引擎生成定义。
            if (presetYaml === undefined) {
              const stJson = normalized.find((entry) => /\.json$/i.test(topRel(entry.path)))
              if (stJson !== undefined) {
                try {
                  const baseName = topRel(stJson.path).replace(/\.json$/i, '') || 'sillytavern'
                  const converted = convertStToPreset(JSON.parse(stJson.content), baseName)
                  presetYaml = { path: 'preset.yml', content: stringifyYaml(converted, { lineWidth: 0 }) }
                  normalized = [...normalized, presetYaml]
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
                writeFileSync(dest, entry.content, 'utf8')
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
            const { body } = await readBridgeBody(req)
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
            ensureRegistered(sctx)
            const { body } = await readBridgeBody(req)
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
            // 全部预设都在用户目录（首次启动种子化）：删除 = 物理删除用户目录副本，插件目录模板保留。
            // 生成目录同名子预设一并清理（宿主 agent-presets 不残留）。
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
            ensureRegistered(sctx)
            const { body } = await readBridgeBody(req)
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

      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'prompt-tool: settings bridge')
  })
}

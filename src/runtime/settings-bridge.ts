/** 自建 loopback settings bridge：Web 设置页数据通道（提示词配置数组经此输出到 UI）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { SettingsDescriptor, SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { DeepseekDetection } from './deepseek.ts'
import type { SkillCatalogEntry } from '../config.ts'
import type { PromptConfigSpec } from '../host/prompt-configs.ts'
import { loadPromptConfigFiles, mergePromptConfigs } from '../host/prompt-configs.ts'
import { validatePromptConfigs } from './configs-validate.ts'
import { loadPromptTemplates } from '../host/templates.ts'
import { fixSkillEntry } from './skill-fix.ts'
import { listPresets } from '../host/manifest.ts'
import { BRIDGE_ENDPOINTS, SETTINGS_BRIDGE_PREFIX } from '../shared/bridge-contract.ts'

const MAX_SETTINGS_BRIDGE_BODY = 64 * 1024

export interface SkillsBridgeState {
  activeSkillsDir: string
  skillCatalog: SkillCatalogEntry[]
}

export interface ProjectOriginals {
  presetText: string
  agentsText: string
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

/** 读取当前 settings 中生效的 promptConfigs（user 层优先，其次 base）。 */
function readPromptConfigs(descriptor: SettingsDescriptor | undefined): PromptConfigSpec[] {
  const value = asRecord(descriptor?.value)
  const base = asRecord(descriptor?.base)
  const current = value.promptConfigs !== undefined ? value.promptConfigs : base.promptConfigs
  return Array.isArray(current) ? current as PromptConfigSpec[] : []
}

async function readBridgeBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  for await (const chunk of req) {
    if (overflow) continue
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_SETTINGS_BRIDGE_BODY) {
      // 超限：继续消费完请求流（保持连接可用），丢弃已收内容。
      overflow = true
      chunks.length = 0
      continue
    }
    chunks.push(buffer)
  }
  if (overflow) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/** 自建 loopback settings bridge：替代 registerConfigurableProviders，避免模型设置区出现插件条目。 */
export function registerSettingsBridge(
  ctx: Context,
  ns: SettingsNamespace,
  getDeepseekAvailable: () => boolean,
  getDeepseekState: () => DeepseekDetection,
  getSkillsState: () => SkillsBridgeState,
  readOriginals: () => ProjectOriginals,
  getEngineStrategyDir: () => string,
  ensureRegistered: (sctx: Context) => boolean,
  afterSkillFix?: () => void,
  /** 生成目录（presetDir）：读取实际生效的提示词配置（引擎加载源）。 */
  getPresetConfigsDir?: () => string,
  /** 内容导入完成回调（更新运行时文本并重建预设）。 */
  afterPresetImport?: (scope: 'preset' | 'agents') => void,
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
            const detection = getDeepseekState()
            const skillsState = getSkillsState()
            writeBridgeJson(res, 200, {
              ok: true,
              value: descriptor,
              deepseekAvailable: detection.available,
              deepseekProviders: detection.providers,
              deepseekError: detection.error,
              activeSkillsDir: skillsState.activeSkillsDir,
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
            const body = await readBridgeBody(req)
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
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.restoreOriginals,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            ensureRegistered(sctx)
            const body = await readBridgeBody(req)
            if (body === null || body === undefined || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            const scope = record.scope === 'preset' || record.scope === 'agents' || record.scope === 'all'
              ? record.scope
              : 'all'
            const originals = readOriginals()
            const ops: SettingsPathOp[] = []
            if (scope === 'preset' || scope === 'all') ops.push({ op: 'set', path: ['promptText'], value: originals.presetText })
            if (scope === 'agents' || scope === 'all') ops.push({ op: 'set', path: ['agentsText'], value: originals.agentsText })
            const expectedRevision = typeof record.expectedRevision === 'number' ? record.expectedRevision : undefined
            try {
              await sctx.settings.mutate(ns, ops, expectedRevision)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 409, { ok: false, code: 'settings-rejected', message })
              return
            }
            const descriptor = findDescriptor()
            if (descriptor === undefined) {
              writeBridgeJson(res, 500, { ok: false, code: 'settings-rejected', message: 'prompt-tool settings namespace was disposed after restore' })
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
            const body = await readBridgeBody(req)
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
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.importDirectory,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            ensureRegistered(sctx)
            const body = await readBridgeBody(req)
            if (body === null || body === undefined || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            const dir = typeof record.dir === 'string' ? record.dir.trim() : ''
            if (dir.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'import directory is required' })
              return
            }
            let imported: PromptConfigSpec[]
            try {
              imported = loadPromptConfigFiles(dir)
            } catch (error) {
              writeBridgeJson(res, 400, { ok: false, code: 'import-invalid', message: error instanceof Error ? error.message : String(error) })
              return
            }
            if (imported.length === 0) {
              writeBridgeJson(res, 400, { ok: false, code: 'import-empty', message: `目录 ${JSON.stringify(dir)} 中没有可导入的 *.yml / *.yaml / *.json 提示词配置` })
              return
            }
            const validation = await validatePromptConfigs(imported, { strategyDir: getEngineStrategyDir() })
            if (!validation.valid) {
              writeBridgeJson(res, 400, { ok: false, code: 'import-invalid', message: '导入目录中的提示词配置未通过权威校验', errors: validation.errors })
              return
            }
            const descriptor = findDescriptor()
            if (descriptor === undefined) {
              writeBridgeJson(res, 404, { ok: false, code: 'settings-not-exposed', message: 'prompt-tool settings namespace is not registered' })
              return
            }
            // 与引擎三源合并同构：同名 id 被导入文件覆盖，新 id 追加在现有配置之后。
            const merged = mergePromptConfigs(readPromptConfigs(descriptor), imported)
            const expectedRevision = typeof record.expectedRevision === 'number' ? record.expectedRevision : undefined
            try {
              await sctx.settings.mutate(ns, [{ op: 'set', path: ['promptConfigs'], value: merged }], expectedRevision)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 409, { ok: false, code: 'settings-rejected', message })
              return
            }
            const next = findDescriptor()
            if (next === undefined) {
              writeBridgeJson(res, 500, { ok: false, code: 'settings-rejected', message: 'prompt-tool settings namespace was disposed after import' })
              return
            }
            writeBridgeJson(res, 200, { ok: true, value: next, importedCount: imported.length, mergedCount: merged.length })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + BRIDGE_ENDPOINTS.skillFix,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            ensureRegistered(sctx)
            const body = await readBridgeBody(req)
            if (body === null || body === undefined || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            const folder = typeof record.folder === 'string' ? record.folder : ''
            const result = fixSkillEntry(getSkillsState().activeSkillsDir, folder)
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
            const body = await readBridgeBody(req)
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
            const body = await readBridgeBody(req)
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

      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'prompt-tool: settings bridge')
  })
}

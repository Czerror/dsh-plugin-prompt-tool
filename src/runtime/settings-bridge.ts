/** 自建 loopback settings bridge：Web 设置页数据通道（提示词配置数组经此输出到 UI）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SettingsDescriptor, SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { DeepseekDetection } from './deepseek.ts'
import type { SkillCatalogEntry } from '../config.ts'
import type { PromptConfigSpec } from '../prompt-configs.ts'
import { loadPromptConfigFiles, mergePromptConfigs } from '../prompt-configs.ts'
import { validatePromptConfigs } from './configs-validate.ts'
import { loadPromptTemplates } from './templates.ts'

export const SETTINGS_BRIDGE_PREFIX = '/api/prompt-tool/settings'
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
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    return false
  }
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
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_SETTINGS_BRIDGE_BODY) return undefined
    chunks.push(buffer)
  }
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
          path: SETTINGS_BRIDGE_PREFIX + '/describe',
          handler: async (req, res) => {
            if (!guard(req, res)) return
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
          path: SETTINGS_BRIDGE_PREFIX + '/mutate',
          handler: async (req, res) => {
            if (!guard(req, res)) return
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
          path: SETTINGS_BRIDGE_PREFIX + '/restore-originals',
          handler: async (req, res) => {
            if (!guard(req, res)) return
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
          path: SETTINGS_BRIDGE_PREFIX + '/configs-validate',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            const body = await readBridgeBody(req)
            if (body === null || body === undefined || typeof body !== 'object') {
              writeBridgeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
              return
            }
            const record = body as Record<string, unknown>
            const result = await validatePromptConfigs(record.promptConfigs)
            writeBridgeJson(res, 200, { ok: true, ...result })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: SETTINGS_BRIDGE_PREFIX + '/import-directory',
          handler: async (req, res) => {
            if (!guard(req, res)) return
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
            const validation = await validatePromptConfigs(imported)
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
          path: SETTINGS_BRIDGE_PREFIX + '/templates',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              const templates = loadPromptTemplates()
              writeBridgeJson(res, 200, { ok: true, templates })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              writeBridgeJson(res, 500, { ok: false, code: 'templates-unavailable', message })
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

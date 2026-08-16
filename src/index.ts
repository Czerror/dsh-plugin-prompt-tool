import z from '@deepseek-ai/schemastery'
import { settingsNamespace, installSettingsSection } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { buildCordis, parseFrontmatter } from './preset-core.ts'

export const name = 'prompt-tool'
// 内容走 user 层（AGENTS.md 常驻层 + skill 按需层），
// 不再注册 system prompt section（否则会被 persona 的 complete:true 整个清零）。
export const inject = ['skills', 'webServer', 'commands', 'llm', 'subagents']

const PRESET_FILE_URL = new URL('../preset.md', import.meta.url)
const PRESET_FILE_PATH = fileURLToPath(PRESET_FILE_URL)
const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url))
const AGENTS_URL = new URL('../AGENTS.md', import.meta.url)
const AGENTS_FILE_PATH = fileURLToPath(AGENTS_URL)
const NS = settingsNamespace('prompt-tool')

// 部署路径默认值；凡是不同部署可能需要不同值的参数都通过 Config 暴露，
// cordis.yml 可以覆盖，无需改代码。
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DEFAULT_RESIDENT_AGENTS_PATH = join(DSH_HOME, 'AGENTS.md')
const DEFAULT_PRESET_DIR = join(DSH_HOME, '.agent-presets', 'prompt-tool')
const DEFAULT_SKILLS_DIR = SKILLS_DIR
const DEFAULT_PRESET_ORDER = 5
const DEFAULT_SKILL_RANK_BASE = 250

// preset 模板文件（本项目自有快照；上游 agent.cordis.yml 与全部 *.mjs 直引 vendor 子模块）。
const PRESET_TEMPLATE_META = fileURLToPath(new URL('../preset/preset.yml', import.meta.url))
const PRESET_TEMPLATE_INJECTOR = fileURLToPath(new URL('../preset/prompt-injector.mjs', import.meta.url))
const PRESET_TEMPLATE_ANCHOR = fileURLToPath(new URL('../preset/near-anchor.mjs', import.meta.url))
const PRESET_TEMPLATE_ROUTER = fileURLToPath(new URL('../preset/router-first-turn.mjs', import.meta.url))
const VENDOR_PRESET_DIR = fileURLToPath(new URL('../upstream/dsh-anchored-standard/preset', import.meta.url))

export interface Config {
  /** 可选：覆盖 preset.md 文本（默认读文件）。 */
  text: string
  /** 可选：覆盖 AGENTS.md 文本（默认读文件）。 */
  agentsText: string
  /** 是否用 AGENTS.md 内容替换上游 instruction-hint 提示文本（默认关闭，本地安全测试用）。 */
  injectAgentsPrompt: boolean
  /** 是否写 ~/.dsh/AGENTS.md（默认 true）。 */
  writeAgents: boolean
  /** 是否生成锚定注入 preset（默认 true）。 */
  writePreset: boolean
  /** 锚定层：we 锚定确认后是否注入 preset.md（默认 true）。 */
  injectPrompt: boolean
  /** 以技能目录名为键的逐技能开关，缺省视为 true。 */
  skillSwitches: Record<string, boolean>
  /** 首轮近距离锚定开关（默认关闭）。 */
  anchorFirstTurn: boolean
  /** 自定义锚点文本；anchorCustom=true 时固定使用。 */
  anchorText: string
  /** 自定义锚点开关：true 固定使用 anchorText；false 按任务自动选择。 */
  anchorCustom: boolean
  /** 子代理固定 Flash 模型：开启时给 subagent/subagent_fork 行加固定 Flash 路由；关闭时子代理继承主会话路由，目录全量放行。 */
  subagentFlash: boolean
  /** 子代理 Flash 路由 provider（默认 deepseek-official）。 */
  subagentFlashProvider: string
  /** 子代理 Flash 模型名（默认 deepseek-v4-flash）。 */
  subagentFlashModel: string
  /** Windows custom-bash 可执行名或路径；默认 bash.exe（PATH 查找）。 */
  customBashPath: string
  /** 技能目录（默认包内 skills/，可指向本地测试目录）。 */
  skillsDir: string
  /** 技能候选排序基数，技能目录内按下标递增。 */
  skillRankBase: number
  /** 常驻规则文件目标路径。 */
  residentAgentsPath: string
  /** 生成的 agent preset 目录。 */
  presetDir: string
  /** 生成 preset 的显示顺序。 */
  presetOrder: number
  /** preset.md 缺失或不可读时使用的文本。 */
  fallbackText: string
}

// 官方插件配置范式：同名 interface Config 与 Schemastery schema 成对导出，
// 框架在插件加载时校验并填充默认值。
export const Config: z<Config> = z.object({
  text: z.string().default(''),
  agentsText: z.string().default(''),
  injectAgentsPrompt: z.boolean().default(false),
  writeAgents: z.boolean().default(true),
  writePreset: z.boolean().default(true),
  injectPrompt: z.boolean().default(true),
  skillSwitches: z.dict(z.boolean()).default({}),
  anchorFirstTurn: z.boolean().default(false),
  anchorText: z.string().default(''),
  anchorCustom: z.boolean().default(false),
  subagentFlash: z.boolean().default(false),
  subagentFlashProvider: z.string().default('deepseek-official'),
  subagentFlashModel: z.string().default('deepseek-v4-flash'),
  customBashPath: z.string().default('bash.exe'),
  skillsDir: z.string().default(DEFAULT_SKILLS_DIR),
  skillRankBase: z.natural().default(DEFAULT_SKILL_RANK_BASE),
  residentAgentsPath: z.string().default(DEFAULT_RESIDENT_AGENTS_PATH),
  presetDir: z.string().default(DEFAULT_PRESET_DIR),
  presetOrder: z.natural().default(DEFAULT_PRESET_ORDER),
  fallbackText: z.string().default(''),
})

interface SkillEntry {
  folder: string
  file: string
  name: string
  description: string
  whenToUse?: string
  metadata?: Record<string, unknown>
  body: string
}

interface SkillCatalogEntry {
  folder: string
  name: string
  description: string
}

export interface PromptSettings {
  promptText: string
  promptPath: string
  agentsText: string
  agentsPath: string
  injectAgentsPrompt: boolean
  anchorFirstTurn: boolean
  anchorText: string
  anchorCustom: boolean
  subagentFlash: boolean
  /** 运行时检测：是否注册了 DeepSeek 模型路由（不写入 settings）。 */
  deepseekAvailable: boolean
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  skillCatalog: SkillCatalogEntry[]
  writeAgents: boolean
  writePreset: boolean
}

const PromptSettingsSchema: z<PromptSettings> = z.object({
  promptText: z.string().default(''),
  promptPath: z.string().default(''),
  agentsText: z.string().default(''),
  agentsPath: z.string().default(''),
  injectAgentsPrompt: z.boolean().default(false),
  anchorFirstTurn: z.boolean().default(false),
  anchorText: z.string().default(''),
  anchorCustom: z.boolean().default(false),
  subagentFlash: z.boolean().default(false),
  deepseekAvailable: z.boolean().default(true),
  injectPrompt: z.boolean().default(true),
  skillSwitches: z.dict(z.boolean()).default({}),
  skillCatalog: z.array(z.object({
    folder: z.string(),
    name: z.string(),
    description: z.string().default(''),
  })).default([]),
  writeAgents: z.boolean().default(true),
  writePreset: z.boolean().default(true),
})

interface RuntimeOptions {
  writeAgents: boolean
  writePreset: boolean
  injectAgentsPrompt: boolean
  injectPrompt: boolean
  skillSwitches: Record<string, boolean>
  anchorFirstTurn: boolean
  anchorText: string
  anchorCustom: boolean
  subagentFlash: boolean
}

function readPromptFile(fallbackText: string): string {
  try {
    return readFileSync(PRESET_FILE_URL, 'utf8')
  } catch {
    return fallbackText
  }
}

function listSkillFolders(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function readSkills(skillsDir: string): SkillEntry[] {
  return listSkillFolders(skillsDir).flatMap((folder) => {
    const file = join(skillsDir, folder, 'SKILL.md')
    try {
      const raw = readFileSync(file, 'utf8')
      const { data, body } = parseFrontmatter(raw)
      return [{
        folder,
        file,
        name: typeof data.name === 'string' && data.name.length > 0 ? data.name : folder,
        description: typeof data.description === 'string' ? data.description : '',
        ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
        ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
        body: body.trim(),
      }]
    } catch {
      return []
    }
  })
}

function readAgents(): string {
  try {
    return readFileSync(AGENTS_URL, 'utf8')
  } catch {
    return ''
  }
}

interface ProjectOriginals {
  presetText: string
  agentsText: string
}

/** 直接读取项目根目录的 preset.md 与 AGENTS.md；宿主不再回写这两个文件。 */
function readProjectOriginals(): ProjectOriginals {
  return { presetText: readPromptFile(''), agentsText: readAgents() }
}

/** 首次安装时，把项目文件内容作为 user 层种子写入 settings.yaml；已有字段不覆盖。 */
function seedSettingsOnce(ctx: Context, originals: ProjectOriginals): void {
  ctx.inject(['settings'], (sctx: Context) => {
    void (async () => {
      try {
        const descriptor = sctx.settings.describe({ redactSecrets: true })
          .find((entry) => String(entry.ns) === String(NS))
        if (descriptor === undefined) return
        const user = descriptor.user !== null && typeof descriptor.user === 'object'
          ? descriptor.user as Record<string, unknown>
          : {}
        const ops: SettingsPathOp[] = []
        if (typeof user.promptText !== 'string') ops.push({ op: 'set', path: ['promptText'], value: originals.presetText })
        if (typeof user.agentsText !== 'string') ops.push({ op: 'set', path: ['agentsText'], value: originals.agentsText })
        if (ops.length === 0) return
        await sctx.settings.mutate(NS, ops)
      } catch (error) {
        warn(ctx, `prompt-tool: failed to seed settings from project files: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  })
}

const RESIDENT_AGENTS_BEGIN = '# === prompt-tool managed block begin ==='
const RESIDENT_AGENTS_END = '# === prompt-tool managed block end ==='

interface ManagedBlockEdit {
  /** 去掉受管块之后的原文（保持原换行风格）。 */
  body: string
  /** 是否确实删除了一个完整的受管块。 */
  found: boolean
}

/** 从正文中删除成对的受管标记块；标记不成对时保持原样，避免误删。 */
function stripManagedBlock(source: string): ManagedBlockEdit {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const normalized = source.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const start = lines.findIndex((line) => line.trim() === RESIDENT_AGENTS_BEGIN)
  if (start < 0) return { body: source, found: false }
  const end = lines.findIndex((line, index) => index > start && line.trim() === RESIDENT_AGENTS_END)
  if (end < 0) return { body: source, found: false }
  lines.splice(start, end - start + 1)
  return { body: lines.join(eol), found: true }
}

/** 生成要放到文件头部的受管块。 */
function buildManagedBlock(text: string, eol: '\n' | '\r\n'): string {
  const content = text.replace(/\r\n/g, '\n').trim()
  return [RESIDENT_AGENTS_BEGIN, content, RESIDENT_AGENTS_END].join(eol)
}

/** 把 AGENTS.md 内容作为受管块写到目标文件头部，保留文件其余内容。 */
function writeAgents(text: string, targetPath: string): boolean {
  try {
    mkdirSync(join(targetPath, '..'), { recursive: true })
    const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
    const eol: '\n' | '\r\n' = existing.includes('\r\n') ? '\r\n' : '\n'
    const stripped = stripManagedBlock(existing)
    const content = text.trim()
    if (content.length === 0) {
      // 关闭或空内容：只删除受管块；本来没有块时不做任何写入。
      if (!stripped.found) return true
      writeFileSync(targetPath, stripped.body, 'utf8')
      return true
    }
    const rest = stripped.body.replace(/^[\r\n]+/, '')
    const managed = buildManagedBlock(content, eol)
    const next = rest.length > 0 ? managed + eol + rest : managed + eol
    if (next === existing) return true
    writeFileSync(targetPath, next, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 关闭写入开关后，从目标文件删除本插件的受管块。 */
function removeResidentAgentsBlock(targetPath: string): boolean {
  try {
    if (!existsSync(targetPath)) return true
    const existing = readFileSync(targetPath, 'utf8')
    const stripped = stripManagedBlock(existing)
    if (!stripped.found) return true
    writeFileSync(targetPath, stripped.body, 'utf8')
    return true
  } catch {
    return false
  }
}

function warn(ctx: Context, message: string): void {
  try {
    ctx.logger?.warn(message)
  } catch {
    // 日志不可用时保持静默，避免二次故障掩盖主路径。
  }
}
/** 把上游 instruction-hint.mjs 的提示文本替换为读同目录 agents-instruction.txt。 */
function patchInstructionHint(source: string): string {
  source = source.replace(/\r\n/g, '\n')
  const original = [
    '      const text = [',
    '        ...sections,',
    '        \'Do NOT assume their content. When a task touches this workspace, read the relevant instruction files first and follow them.\',',
    '      ].join(\' \')',
  ].join('\n')
  const replacement = [
    '  const agentsInstructionText = readFileSync(new URL(\'./agents-instruction.txt\', import.meta.url), \'utf8\').trim()',
    '  const text = agentsInstructionText.length > 0',
    '    ? agentsInstructionText',
    '    : [',
    '        ...sections,',
    '        \'Do NOT assume their content. When a task touches this workspace, read the relevant instruction files first and follow them.\',',
    '      ].join(\' \')',
  ].join('\n')
  if (!source.includes("import { createEpochPromotion }")) {
    throw new Error('instruction-hint.mjs import marker missing')
  }
  if (!source.includes(original)) {
    throw new Error('instruction-hint.mjs text marker missing')
  }
  return source
    .replace("import { createEpochPromotion } from './compaction-epoch.mjs'", "import { readFileSync } from 'node:fs'\nimport { createEpochPromotion } from './compaction-epoch.mjs'")
    .replace(original, replacement)
}

const SETTINGS_BRIDGE_PREFIX = '/api/prompt-tool/settings'
const MAX_SETTINGS_BRIDGE_BODY = 64 * 1024

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

/** dsh-tui 暴露的布尔开关：键名与 settings 路径一致。 */
const TUI_BOOLEAN_SWITCHES: ReadonlyArray<readonly [key: string, label: string]> = [
  ['writeAgents', '写入常驻规则 AGENTS.md'],
  ['writePreset', '启用锚定预设'],
  ['injectPrompt', '锚定确认后注入 preset.md'],
  ['injectAgentsPrompt', '用 AGENTS.md 替换 instruction-hint 提示'],
  ['anchorFirstTurn', '追加任务引导'],
  ['anchorCustom', '使用自定义引导'],
  ['subagentFlash', '子代理固定 Flash 模型'],
] as const

/** 把布尔开关渲染成 dsh-tui 命令输出。 */
function renderTuiStatus(source: PromptSettings): string {
  const onOff = (value: boolean): string => value ? '开' : '关'
  const lines = [
    '提示词工具开关',
    ...TUI_BOOLEAN_SWITCHES.map(([key, label]) => {
      const value = source[key as keyof PromptSettings]
      return `${key.padEnd(22)}${onOff(typeof value === 'boolean' ? value : false)}  ${label}`
    }),
    '锚点文本:',
    `  anchorText               ${source.anchorText.length > 0 ? source.anchorText : '（空 = 按任务自动选择）'}`,
    `  deepseekAvailable       ${source.deepseekAvailable ? '是' : '否（未检测到 DeepSeek 模型，subagentFlash 不可用）'}`,
    '技能开关:',
  ]
  for (const skill of source.skillCatalog) {
    const value = source.skillSwitches[skill.folder] !== false
    lines.push(`${('skill ' + skill.folder).padEnd(22)}${onOff(value)}  ${skill.name || skill.folder}`)
  }
  return lines.join('\n')
}

/** 解析 on/off/toggle 三种输入。 */
function parseTuiBoolean(token: string | undefined, current: boolean): boolean | undefined {
  if (token === 'on') return true
  if (token === 'off') return false
  if (token === 'toggle') return !current
  return undefined
}

/** 通过 DSH 命令注册表暴露 /prompt-tool，Web 与 dsh-tui 都能执行。 */
function registerTuiCommand(ctx: Context, getSource: () => PromptSettings, getDeepseekAvailable: () => boolean, getDeepseekState: () => DeepseekDetection): void {
  ctx.inject(['settings'], (sctx: Context) => {
    return sctx.commands.register({
      name: 'prompt-tool',
      description: '提示词工具：查看或切换本插件开关',
      input: { hint: 'status | on/off/toggle <开关> | skill <目录名> on/off' },
      handler: async (invocation): Promise<CommandResult> => {
        const usage = (): CommandResult => ({
          kind: 'error',
          text: '用法：/prompt-tool status\n' +
            '      /prompt-tool on|off|toggle <writeAgents|writePreset|injectPrompt|injectAgentsPrompt|anchorFirstTurn|anchorCustom|subagentFlash>\n' +
            '      /prompt-tool skill <技能目录名> on|off|toggle',
        })
        const tokens = invocation.rawInput.trim().split(/\s+/).filter((token) => token.length > 0)
        const source = getSource()
        if (tokens.length === 0 || tokens[0] === 'status') {
          const detection = getDeepseekState()
          const deepseekLine = detection.available
            ? `检测到的 DeepSeek 模型路由: ${detection.providers.join(', ') || '（无）'}`
            : `未检测到 DeepSeek 模型路由。providers=[${detection.providers.join(', ') || '空'}] error=${detection.error ?? '无'}`
          return { kind: 'success', text: renderTuiStatus(source) + '\n' + deepseekLine }
        }
        if (tokens[0] === 'skill') {
          const folder = tokens[1]
          if (folder === undefined) return usage()
          const current = source.skillSwitches[folder] !== false
          const next = parseTuiBoolean(tokens[2], current)
          if (next === undefined) return usage()
          await sctx.settings.mutate(NS, [{ op: 'set', path: ['skillSwitches', folder], value: next }])
          return { kind: 'success', text: `已把技能 ${folder} 设为 ${next ? '开' : '关'}

${renderTuiStatus(getSource())}` }
        }
        const action = tokens[0]
        const key = tokens[1]
        if (action !== 'on' && action !== 'off' && action !== 'toggle') return usage()
        if (key === undefined || !TUI_BOOLEAN_SWITCHES.some(([candidate]) => candidate === key)) return usage()
        if (key === 'subagentFlash' && !getDeepseekAvailable()) {
          const detection = getDeepseekState()
          return { kind: 'error', text: `未检测到 DeepSeek 模型路由，subagentFlash 开关不可用。providers=[${detection.providers.join(', ') || '空'}] error=${detection.error ?? '无'}` }
        }
        const currentValue = source[key as keyof PromptSettings]
        if (typeof currentValue !== 'boolean') {
          return { kind: 'error', text: `${key} 不是布尔开关，不能这样切换` }
        }
        const next = parseTuiBoolean(action, currentValue)
        if (next === undefined) return usage()
        await sctx.settings.mutate(NS, [{ op: 'set', path: [key], value: next }])
        return { kind: 'success', text: `已把 ${key} 设为 ${next ? '开' : '关'}

${renderTuiStatus(getSource())}` }
      },
    })
  })
}

/** 自建 loopback settings bridge：替代 registerConfigurableProviders，避免模型设置区出现插件条目。 */
function registerSettingsBridge(ctx: Context, getDeepseekAvailable: () => boolean, getDeepseekState: () => DeepseekDetection): void {
  ctx.inject(['settings'], (sctx: Context) => {
    sctx.effect(() => {
      const findDescriptor = (): SettingsDescriptor | undefined =>
        sctx.settings.describe({ redactSecrets: true }).find((entry) => String(entry.ns) === String(NS))
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
            writeBridgeJson(res, 200, { ok: true, value: descriptor, deepseekAvailable: detection.available, deepseekProviders: detection.providers, deepseekError: detection.error })
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
              await sctx.settings.mutate(NS, record.ops as SettingsPathOp[], expectedRevision)
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
            const originals = readProjectOriginals()
            const ops: SettingsPathOp[] = []
            if (scope === 'preset' || scope === 'all') ops.push({ op: 'set', path: ['promptText'], value: originals.presetText })
            if (scope === 'agents' || scope === 'all') ops.push({ op: 'set', path: ['agentsText'], value: originals.agentsText })
            const expectedRevision = typeof record.expectedRevision === 'number' ? record.expectedRevision : undefined
            try {
              await sctx.settings.mutate(NS, ops, expectedRevision)
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
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'prompt-tool: settings bridge')
  })
}

interface WritePresetOptions {
  anchorFirstTurn: boolean
  anchorText: string
  anchorCustom: boolean
  injectPrompt: boolean
  subagentFlash: boolean
  subagentFlashProvider: string
  subagentFlashModel: string
  customBashPath: string
  /** 用该文本替换上游 instruction-hint 的提示内容；不传则保持上游原样。 */
  agentsInstructionText?: string
  presetDir: string
  presetOrder: number
}

/** 旧版“每块强制 we need”默认锚句；已存 settings 时归一化为自动模式。 */
const LEGACY_ANCHOR_TEXT = [
  'You are a helpful software assistant.',
  '',
  "Begin every reasoning block with 'We need'.",
].join('\n')

/** 旧默认值归一化为空（自动）；用户自定义文本原样保留。 */
function normalizeAnchorText(text: string | undefined): string {
  const value = typeof text === 'string' ? text : ''
  return value.trim() === LEGACY_ANCHOR_TEXT.trim() ? '' : value
}

/** DeepSeek 模型检测结果（含诊断信息，供 Web/TUI 展示）。 */
interface DeepseekDetection {
  available: boolean
  providers: string[]
  error?: string
}

/** 检测 DeepSeek 模型：live provider + 可配置 provider 目录双通道匹配。 */
function detectDeepseek(ctx: Context): DeepseekDetection {
  const empty = { available: false, providers: [] }
  try {
    const llm = ctx.get('llm') as {
      listProviders?: () => Array<{ id?: string; name?: string }>
      listConfigurableProviders?: () => Array<{ provider?: string; displayName?: string }>
    } | undefined
    if (llm === undefined) return { ...empty, error: 'ctx.get("llm") 返回 undefined' }
    const live = llm.listProviders?.() ?? []
    const configured = llm.listConfigurableProviders?.() ?? []
    const names = new Set<string>()
    const matches = (id: string | undefined, name: string | undefined): boolean =>
      /deepseek/i.test(id ?? '') || /deepseek/i.test(name ?? '')
    for (const provider of live) {
      const id = typeof provider.id === 'string' ? provider.id : String(provider.id ?? '')
      names.add(id || provider.name || '(unnamed)')
      if (matches(provider.id, provider.name)) return { available: true, providers: [...names] }
    }
    for (const provider of configured) {
      const id = typeof provider.provider === 'string' ? provider.provider : ''
      if (id.length > 0) names.add(id)
      if (matches(provider.provider, provider.displayName)) return { available: true, providers: [...names] }
    }
    return { available: false, providers: [...names], ...(live.length === 0 && configured.length === 0 ? { error: 'llm 服务未返回任何 provider' } : {}) }
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 给宿主直派的子代理补 Flash 路由；调用方显式 provider/model 优先，不覆盖 persona 与工具白名单。 */
function installSubagentFlashRoute(ctx: Context, isEnabled: () => boolean, provider: string, model: string): void {
  ctx.inject(['subagents'], (sctx: Context) => {
    const service = sctx.get('subagents') as { start?: (name: string, request: Record<string, unknown>) => unknown } | undefined
    if (service === undefined || typeof service.start !== 'function') return
    const original = service.start
    const wrapped = (name: string, request: Record<string, unknown>): unknown => {
      if (!isEnabled() || request === null || typeof request !== 'object') return original.call(service, name, request)
      const agentOptions = request.agentOptions !== null && typeof request.agentOptions === 'object'
        ? request.agentOptions as Record<string, unknown>
        : {}
      if (agentOptions.provider === undefined && agentOptions.model === undefined) {
        return original.call(service, name, { ...request, agentOptions: { ...agentOptions, provider, model } })
      }
      return original.call(service, name, request)
    }
    service.start = wrapped
    return () => {
      if (service.start === wrapped) service.start = original
    }
  })
}

/** prompt-tool 补丁：子代理直接全量放行（assembled.tools 本身已是动态白名单）。 */
function patchToolBootstrap(source: string): string {
  source = source.replace(/\r\n/g, '\n')
  const original = [
    '    const assembled = await next()',
    '    try {',
    '      const status = promotion.status(context.agent)',
  ].join('\n')
  const replacement = [
    '    const assembled = await next()',
    '    try {',
    '      // prompt-tool 补丁：子代理跳过目录裁剪，直接使用组装结果；',
    '      // 调用方（如 dsh-mnemon）的工具白名单已先行过滤 assembled.tools，',
    '      // 因此任意前缀的新插件工具都会自动出现在子代理第一次会话。',
    "      if ((context.agent?.session?.header?.delegationDepth ?? 0) > 0) return assembled",
    '      const status = promotion.status(context.agent)',
  ].join('\n')
  if (!source.includes(original)) {
    throw new Error('tool-bootstrap.mjs assembled marker missing')
  }
  return source.replace(original, replacement)
}

// 完整 anchored preset：上游文件（agent.cordis.yml + 全部 preset/*.mjs）直引
// 子模块，本项目自有文件（preset.yml / router-first-turn.mjs / near-anchor.mjs /
// prompt-injector.mjs）走 preset/ 快照。agent.cordis.yml 注入本地附加件，常驻
// 规则提示等附加内容全部由 prompt-injector.mjs 在运行时注入。
function writePreset(prompt: string, options: WritePresetOptions): void {
  const presetDir = options.presetDir
  mkdirSync(presetDir, { recursive: true })
  writeFileSync(join(presetDir, 'agent.cordis.yml'), buildCordis(prompt, {
    anchorFirstTurn: options.anchorFirstTurn,
    anchorText: options.anchorText,
    anchorCustom: options.anchorCustom,
    injectPrompt: options.injectPrompt,
    subagentFlash: options.subagentFlash,
    subagentFlashProvider: options.subagentFlashProvider,
    subagentFlashModel: options.subagentFlashModel,
    bashPath: options.customBashPath,
  }), 'utf8')
  const meta = readFileSync(PRESET_TEMPLATE_META, 'utf8').replace(/^order:.*$/m, `order: ${options.presetOrder}`)
  writeFileSync(join(presetDir, 'preset.yml'), meta, 'utf8')
  for (const file of readdirSync(VENDOR_PRESET_DIR)) {
    if (!file.endsWith('.mjs')) continue
    const vendorSource = readFileSync(join(VENDOR_PRESET_DIR, file), 'utf8')
    // 最优组合补丁：子代理直接全量放行（assembled.tools 本身已是动态白名单）。
    writeFileSync(join(presetDir, file), file === 'tool-bootstrap.mjs' ? patchToolBootstrap(vendorSource) : vendorSource, 'utf8')
  }
  const agentsInstructionPath = join(presetDir, 'agents-instruction.txt')
  if (options.agentsInstructionText !== undefined) {
    writeFileSync(agentsInstructionPath, options.agentsInstructionText, 'utf8')
    const hintPath = join(presetDir, 'instruction-hint.mjs')
    writeFileSync(hintPath, patchInstructionHint(readFileSync(hintPath, 'utf8')), 'utf8')
  } else {
    rmSync(agentsInstructionPath, { force: true })
  }
  const injectorPath = join(presetDir, 'prompt-injector.mjs')
  if (options.injectPrompt) {
    writeFileSync(injectorPath, readFileSync(PRESET_TEMPLATE_INJECTOR, 'utf8'), 'utf8')
  } else {
    // 关闭 preset.md 注入时清掉旧快照，只保留工具引导。
    rmSync(injectorPath, { force: true })
  }
  writeFileSync(join(presetDir, 'router-first-turn.mjs'), readFileSync(PRESET_TEMPLATE_ROUTER, 'utf8'), 'utf8')
  // 清理历史版本的独立锚定轮快照；新版不再引用该文件。
  rmSync(join(presetDir, 'turn-anchor.mjs'), { force: true })
  const anchorPath = join(presetDir, 'near-anchor.mjs')
  if (options.anchorFirstTurn) {
    writeFileSync(anchorPath, readFileSync(PRESET_TEMPLATE_ANCHOR, 'utf8'), 'utf8')
  } else {
    // 开关关闭时清掉旧快照，避免遗留文件误导后续调试。
    rmSync(anchorPath, { force: true })
  }
}

export function apply(ctx: Context, config: Config): void {
  const deepseekState = (): DeepseekDetection => detectDeepseek(ctx)
  const getDeepseekAvailable = (): boolean => deepseekState().available
  const getDeepseekState = (): DeepseekDetection => deepseekState()
  let current = config.text || readPromptFile(config.fallbackText)
  let currentAgents = config.agentsText || readAgents()
  const skills = readSkills(config.skillsDir)
  const skillCatalog: SkillCatalogEntry[] = skills.map((skill) => ({
    folder: skill.folder,
    name: skill.name,
    description: skill.description,
  }))

  // 1) 按需层：注册 skills/*/SKILL.md，name/description/whenToUse/metadata 全部来自各自 frontmatter。
  //    content 只包含技能自身正文；preset.md 不拼进技能正文，全部技能关闭时列表自然为空。
  let skillSwitches: Record<string, boolean> = { ...config.skillSwitches }
  let invalidateSkills: (() => void) | undefined
  ctx.skills.registerProvider((control: SkillProviderControl): SkillProvider => {
    invalidateSkills = control.invalidate
    return {
      name: 'prompt-tool',
      list: async (options: SkillLookupOptions): Promise<readonly SkillCandidate[]> => {
        if (options.signal?.aborted) return []
        return readSkills(config.skillsDir)
          .filter((skill) => skillSwitches[skill.folder] !== false)
          .map((skill, index): SkillCandidate => ({
            name: skill.name,
            description: skill.description || skill.folder,
            ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'runtime',
            provider: 'prompt-tool',
            resourceBase: { kind: 'directory', path: join(config.skillsDir, skill.folder) },
            rank: config.skillRankBase + index,
            locator: skill.folder,
            path: skill.file,
            ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
          }))
      },
      get: async (candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> => {
        if (options.signal?.aborted) return undefined
        const skill = readSkills(config.skillsDir).find((entry) => entry.folder === candidate.locator || entry.name === candidate.name)
        if (skill === undefined || skillSwitches[skill.folder] === false) return undefined
        return {
          name: candidate.name,
          description: candidate.description,
          ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
          invocation: candidate.invocation,
          source: candidate.source,
          provider: candidate.provider,
          resourceBase: candidate.resourceBase,
          ...(candidate.path !== undefined ? { path: candidate.path } : { path: skill.file }),
          ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {}),
          content: skill.body,
        }
      },
    }
  })

  // 在线编辑不再经 ctx.llm 暴露 settings namespace：改为自建 loopback bridge，
  // 这样模型设置页不会出现「提示词工具」目录条目。
  registerSettingsBridge(ctx, getDeepseekAvailable, getDeepseekState)

  // settings 存储优先于 cordis config：installSettingsSection 注册后立即用
  // settings 的解析值触发一次 onChange，完成初始写入，因此 config 只作 base。
  const runtime: RuntimeOptions = {
    writeAgents: config.writeAgents,
    writePreset: config.writePreset,
    injectAgentsPrompt: config.injectAgentsPrompt,
    injectPrompt: config.injectPrompt,
    skillSwitches: { ...config.skillSwitches },
    anchorFirstTurn: config.anchorFirstTurn,
    anchorText: config.anchorText,
    anchorCustom: config.anchorCustom,
    subagentFlash: config.subagentFlash && getDeepseekAvailable(),
  }

  // 宿主直派子代理（如 dsh-mnemon）也按开关补 Flash 路由；
  // 调用方显式模型优先，persona 与 toolFilter 保持不变。
  installSubagentFlashRoute(ctx, () => runtime.subagentFlash, config.subagentFlashProvider, config.subagentFlashModel)

  let currentSource = (): PromptSettings => ({
    promptText: current,
    promptPath: PRESET_FILE_PATH,
    agentsText: currentAgents,
    agentsPath: AGENTS_FILE_PATH,
    injectAgentsPrompt: runtime.injectAgentsPrompt,
    anchorFirstTurn: runtime.anchorFirstTurn,
    anchorText: normalizeAnchorText(runtime.anchorText),
    anchorCustom: runtime.anchorCustom,
    subagentFlash: runtime.subagentFlash,
    deepseekAvailable: getDeepseekAvailable(),
    injectPrompt: runtime.injectPrompt,
    skillSwitches: runtime.skillSwitches,
    skillCatalog,
    writeAgents: runtime.writeAgents,
    writePreset: runtime.writePreset,
  })

  // dsh-tui 命令入口：/prompt-tool 查看或切换开关。
  registerTuiCommand(ctx, () => currentSource(), getDeepseekAvailable, getDeepseekState)

  let needsInitialApply = true
  const applyState = (): void => {
    const next = currentSource()
    const nextRuntime: RuntimeOptions = {
      writeAgents: typeof next.writeAgents === 'boolean' ? next.writeAgents : config.writeAgents,
      writePreset: typeof next.writePreset === 'boolean' ? next.writePreset : config.writePreset,
      injectAgentsPrompt: typeof next.injectAgentsPrompt === 'boolean' ? next.injectAgentsPrompt : config.injectAgentsPrompt,
      injectPrompt: typeof next.injectPrompt === 'boolean' ? next.injectPrompt : config.injectPrompt,
      skillSwitches: next.skillSwitches !== undefined ? next.skillSwitches : config.skillSwitches,
      anchorFirstTurn: typeof next.anchorFirstTurn === 'boolean' ? next.anchorFirstTurn : config.anchorFirstTurn,
      anchorText: normalizeAnchorText(typeof next.anchorText === 'string' ? next.anchorText : config.anchorText),
      anchorCustom: typeof next.anchorCustom === 'boolean' ? next.anchorCustom : config.anchorCustom,
      subagentFlash: (typeof next.subagentFlash === 'boolean' ? next.subagentFlash : config.subagentFlash) && getDeepseekAvailable(),
    }
    const promptChanged = next.promptText !== current
    const agentsChanged = next.agentsText !== currentAgents
    const skillSwitchesChanged = JSON.stringify(runtime.skillSwitches) !== JSON.stringify(nextRuntime.skillSwitches)
    const settingsChanged = runtime.writeAgents !== nextRuntime.writeAgents
      || runtime.writePreset !== nextRuntime.writePreset
      || runtime.injectAgentsPrompt !== nextRuntime.injectAgentsPrompt
      || runtime.injectPrompt !== nextRuntime.injectPrompt
      || skillSwitchesChanged
      || runtime.anchorFirstTurn !== nextRuntime.anchorFirstTurn
      || runtime.anchorText !== nextRuntime.anchorText
      || runtime.anchorCustom !== nextRuntime.anchorCustom
      || runtime.subagentFlash !== nextRuntime.subagentFlash
    // 首次必须写入：settings 与文件/config 一致时也不能跳过 preset/AGENTS 生成。
    if (!needsInitialApply && !promptChanged && !agentsChanged && !settingsChanged) return
    needsInitialApply = false

    if (promptChanged) current = next.promptText
    if (agentsChanged) currentAgents = next.agentsText
    runtime.writeAgents = nextRuntime.writeAgents
    runtime.writePreset = nextRuntime.writePreset
    runtime.injectAgentsPrompt = nextRuntime.injectAgentsPrompt
    runtime.injectPrompt = nextRuntime.injectPrompt
    runtime.skillSwitches = nextRuntime.skillSwitches
    runtime.anchorFirstTurn = nextRuntime.anchorFirstTurn
    runtime.anchorText = nextRuntime.anchorText
    runtime.anchorCustom = nextRuntime.anchorCustom
    runtime.subagentFlash = nextRuntime.subagentFlash
    skillSwitches = runtime.skillSwitches
    if (skillSwitchesChanged) invalidateSkills?.()

    let residentAgentsWritten = false
    if (runtime.writeAgents) {
      residentAgentsWritten = writeAgents(currentAgents, config.residentAgentsPath)
      if (!residentAgentsWritten) {
        warn(ctx, `prompt-tool: failed to write resident rules to ${config.residentAgentsPath}`)
      }
    } else {
      residentAgentsWritten = removeResidentAgentsBlock(config.residentAgentsPath)
      if (!residentAgentsWritten) {
        warn(ctx, `prompt-tool: failed to remove resident rules block from ${config.residentAgentsPath}`)
      }
    }
    if (runtime.writePreset) {
      const presetPrompt = runtime.injectPrompt && current.length > 0 ? current : ''
      writePreset(presetPrompt, {
        anchorFirstTurn: runtime.anchorFirstTurn,
        anchorText: runtime.anchorText,
        anchorCustom: runtime.anchorCustom,
        injectPrompt: runtime.injectPrompt,
        subagentFlash: runtime.subagentFlash,
        subagentFlashProvider: config.subagentFlashProvider,
        subagentFlashModel: config.subagentFlashModel,
        customBashPath: config.customBashPath,
        agentsInstructionText: runtime.injectAgentsPrompt && currentAgents.length > 0 ? currentAgents : undefined,
        presetDir: config.presetDir,
        presetOrder: config.presetOrder,
      })
    } else {
      // writePreset 关闭时移除旧的生成目录，避免残留 prompt-injector 继续注入。
      try {
        rmSync(config.presetDir, { recursive: true, force: true })
      } catch (error) {
        warn(ctx, 'prompt-tool: failed to remove ' + config.presetDir + ': ' + String(error))
      }
    }
  }

  const settingsEntry: PromptSettings = {
    promptText: current,
    promptPath: PRESET_FILE_PATH,
    agentsText: currentAgents,
    agentsPath: AGENTS_FILE_PATH,
    injectAgentsPrompt: config.injectAgentsPrompt,
    anchorFirstTurn: config.anchorFirstTurn,
    anchorText: config.anchorText,
    anchorCustom: config.anchorCustom,
    subagentFlash: config.subagentFlash && getDeepseekAvailable(),
    deepseekAvailable: getDeepseekAvailable(),
    injectPrompt: config.injectPrompt,
    skillSwitches: { ...config.skillSwitches },
    skillCatalog,
    writeAgents: config.writeAgents,
    writePreset: config.writePreset,
  }

  installSettingsSection(ctx, NS, PromptSettingsSchema, settingsEntry, {
    setSource: (source) => { currentSource = source },
    onChange: applyState,
  })

  // 首次安装：settings.yaml 没有 user 层文本时，用项目文件内容初始化。
  seedSettingsOnce(ctx, readProjectOriginals())
}

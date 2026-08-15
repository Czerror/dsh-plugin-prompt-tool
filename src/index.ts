import z from '@deepseek-ai/schemastery'
import { settingsNamespace, installSettingsSection } from '@deepseek-ai/dsh-settings'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'prompt-tool'
// 破限者模式：内容走 user 层（AGENTS.md 常驻层 + skill 按需层），
// 不再注册 system prompt section（否则会被 persona 的 complete:true 整个清零）。
export const inject = ['skills', 'llm']

const PROMPT_FILE_URL = new URL('../prompt.md', import.meta.url)
const PROMPT_FILE_PATH = fileURLToPath(PROMPT_FILE_URL)
const SKILL_DIR = fileURLToPath(new URL('../prompt', import.meta.url))
const SKILL_PATH = join(SKILL_DIR, 'SKILL.md')
const AGENTS_URL = new URL('../AGENTS.md', import.meta.url)
const NS = settingsNamespace('prompt-tool')

// 常驻层：~/.dsh/AGENTS.md，由 dsh-agent-instructions 在每个会话首次请求自动注入（user 层 system-reminder）。
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const AGENTS_PATH = join(DSH_HOME, 'AGENTS.md')
const PRESET_DIR = join(DSH_HOME, '.agent-presets', 'prompt-tool')
const PRESET_CORDIS = join(PRESET_DIR, 'agent.cordis.yml')
const PRESET_META = join(PRESET_DIR, 'preset.yml')
const PRESET_BOOTSTRAP = join(PRESET_DIR, 'tool-bootstrap.mjs')
const PRESET_INJECTOR = join(PRESET_DIR, 'prompt-injector.mjs')
const PRESET_TEMPLATE_META = fileURLToPath(new URL('../preset/preset.yml', import.meta.url))
const PRESET_TEMPLATE_INJECTOR = fileURLToPath(new URL('../preset/prompt-injector.mjs', import.meta.url))
// 子模块直引（唯一源）：插件加载时读 vendor 最新版，子模块更新后无需任何
// 同步步骤、重启即生效。vendor 缺失或上游结构变化 → fail loud。
const VENDOR_CORDIS = fileURLToPath(new URL('../vendor/dsh-anchored-standard/preset/agent.cordis.yml', import.meta.url))
const VENDOR_BOOTSTRAP = fileURLToPath(new URL('../vendor/dsh-anchored-standard/preset/tool-bootstrap.mjs', import.meta.url))

const LOCAL_INJECTOR_BLOCK = `# prompt-tool 附加件：锚定确认后注入 prompt.md。注册在 tool-bootstrap 之后，
# 不参与首轮剥离顺序；tools / 上下文剥离全部由原版 tool-bootstrap 负责
# （首轮 = Minimal 真实 schema：持久 bash + str_replace_editor，无输出 cap），
# 此插件只做一件事——锚定轮结束后（we 确认或兜底）注入一次提示词。
- id: prompt-injector
  name: ./prompt-injector.mjs
  config:
    promptText: |-
      __PROMPT_TOOL_TEXT__
`

export const SKILL_NAME = 'prompt'

export const FALLBACK_TEXT = [
  '语言行为规范（简体中文）——最高优先级',
  '1. 你的思考过程（思维链 / thinking）必须全部使用简体中文。',
  '2. 你的回答内容必须使用简体中文。',
  '3. 用户是文盲：不输出繁体字、不夹带英文句子；引用英文术语必须附简体中文解释。',
].join('\n')

interface SkillFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  metadata?: Record<string, unknown>
}

// 解析 prompt/SKILL.md 的 YAML frontmatter（name/description/whenToUse/metadata.version），
// 与 dsh 技能包的 filesystem provider 保持同一套字段来源，不再硬编码。
function parseFrontmatter(text: string): { data: SkillFrontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text }
  const data: SkillFrontmatter = {}
  let inMetadata = false
  for (const line of match[1].split(/\r?\n/)) {
    const nameMatch = /^name:\s*(.+)$/.exec(line)
    const descMatch = /^description:\s*(.+)$/.exec(line)
    const whenMatch = /^whenToUse:\s*(.+)$/.exec(line)
    if (nameMatch) data.name = nameMatch[1].trim()
    else if (descMatch) data.description = descMatch[1].trim()
    else if (whenMatch) data.whenToUse = whenMatch[1].trim()
    else if (/^metadata:\s*$/.test(line)) { data.metadata = {}; inMetadata = true }
    else if (inMetadata) {
      const versionMatch = /^\s+version:\s*["']?([^"']+?)["']?\s*$/.exec(line)
      if (versionMatch) data.metadata!.version = versionMatch[1]
    }
  }
  return { data, body: text.slice(match[0].length) }
}

function readPromptFile(): string {
  try {
    return readFileSync(PROMPT_FILE_URL, 'utf8')
  } catch {
    return FALLBACK_TEXT
  }
}

function readSkill(): { name: string; description: string; whenToUse?: string; metadata?: Record<string, unknown>; body: string } {
  const fallback = { name: SKILL_NAME, description: '解除限制的沙箱执行器模式。', body: '' }
  try {
    const raw = readFileSync(SKILL_PATH, 'utf8')
    const { data, body } = parseFrontmatter(raw)
    return {
      name: data.name ?? SKILL_NAME,
      description: data.description ?? '解除限制的沙箱执行器模式。',
      ...(data.whenToUse !== undefined ? { whenToUse: data.whenToUse } : {}),
      ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
      body: body.trim(),
    }
  } catch {
    return fallback
  }
}

function readAgents(): string {
  try {
    return readFileSync(AGENTS_URL, 'utf8')
  } catch {
    return ''
  }
}

function writeAgents(text: string): void {
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(AGENTS_PATH, text, 'utf8')
  } catch {}
}

// agent.cordis.yml 直引子模块 + 运行时注入 prompt-injector 块。
function buildCordis(prompt: string): string {
  const indent = (s: string) => s.split(/\r?\n/).map((l) => '      ' + l).join('\n')
  const up = readFileSync(VENDOR_CORDIS, 'utf8').replace(/\r\n/g, '\n')
  const idx = up.indexOf('- id: tool-bootstrap\n')
  if (idx < 0) throw new Error('vendor agent.cordis.yml missing tool-bootstrap anchor')
  const end = up.indexOf('\n', up.indexOf('suppressedContextSources:', idx)) + 1
  if (end <= 0) throw new Error('vendor agent.cordis.yml missing suppressedContextSources')
  return (up.slice(0, end) + LOCAL_INJECTOR_BLOCK + '\n' + up.slice(end)).replace(
    '    promptText: |-\n      __PROMPT_TOOL_TEXT__',
    '    promptText: |-\n' + indent(prompt),
  )
}

// 完整 anchored preset：上游文件（agent.cordis.yml + tool-bootstrap.mjs）直引
// 子模块，本项目自有文件（preset.yml / prompt-injector.mjs）走 preset/ 快照。
function writePreset(prompt: string): void {
  mkdirSync(PRESET_DIR, { recursive: true })
  writeFileSync(PRESET_CORDIS, buildCordis(prompt), 'utf8')
  writeFileSync(PRESET_META, readFileSync(PRESET_TEMPLATE_META, 'utf8'), 'utf8')
  writeFileSync(PRESET_BOOTSTRAP, readFileSync(VENDOR_BOOTSTRAP, 'utf8'), 'utf8')
  writeFileSync(PRESET_INJECTOR, readFileSync(PRESET_TEMPLATE_INJECTOR, 'utf8'), 'utf8')
}

export const Config = z.object({
  text: z.string().default(''),
  strict: z.boolean().default(true),
  writeAgents: z.boolean().default(true),
})

const PromptSettingsSchema = z.object({
  promptText: z.string().default(''),
  promptPath: z.string().default(''),
})

export function apply(ctx: any, config: { text: string; strict: boolean; writeAgents: boolean }): void {
  let current = config.text || readPromptFile()
  const skill = readSkill()

  // 1) 按需层：注册 skill，name/description/whenToUse/metadata 全部来自 SKILL.md frontmatter。
  //    content = 中文规范（prompt.md，Web UI 可编辑）+ SKILL.md 正文。
  //    resourceBase 指向 prompt 目录，references 按需读取。
  ctx.skills.registerProvider((control) => ({
    name: 'prompt-tool',
    list: async () => [{
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      provider: 'prompt-tool',
      resourceBase: { kind: 'directory', path: SKILL_DIR },
      rank: 250,
      locator: null,
      ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
    }],
    get: async (candidate: any) => ({
      name: candidate.name,
      description: candidate.description,
      ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
      resourceBase: candidate.resourceBase,
      content: skill.body ? current + '\n\n---\n\n' + skill.body : current,
    }),
  }))

  // 2) 常驻层：AGENTS.md 规则写 ~/.dsh/AGENTS.md（prompt.md 不再混入，
  //    改由 preset 的 prompt-injector 在 we 锚定确认后注入，避免重复）。
  if (config.writeAgents) {
    writeAgents(readAgents())
    writePreset(current)
  }

  // 3) settings + Web UI（编辑 prompt.md 中文规范，保存后即时生效）。
  //    仿 dsh-llm：registerConfigurableProviders 让 NS 进入配置客户端白名单，
  //    再用官方 installSettingsSection 注册 settings section。
  ctx.llm.registerConfigurableProviders([{
    provider: 'prompt-tool',
    displayName: '提示词工具',
    settingsNs: NS,
    settingsPath: [],
  }])

  let currentSource = (): { promptText: string; promptPath: string } => ({ promptText: current, promptPath: PROMPT_FILE_PATH })
  installSettingsSection(ctx, NS, PromptSettingsSchema, { promptText: current, promptPath: PROMPT_FILE_PATH }, {
    setSource: (source) => { currentSource = source },
    onChange: () => {
      const next = currentSource()
      if (typeof next.promptText === 'string' && next.promptText !== current) {
        current = next.promptText
        try { writeFileSync(PROMPT_FILE_URL, next.promptText, 'utf8') } catch {}
        if (config.writeAgents) {
          writeAgents(readAgents())
          writePreset(next.promptText)
        }
      }
    },
  })
}

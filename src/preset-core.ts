/**
 * prompt-tool preset 生成核心：与 dsh 插件上下文无关的纯函数，
 * 独立成文件以便单元测试与复用。失败一律抛出（fail loud）。
 */
import { parse as parseYaml } from 'yaml'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 子模块直引（唯一源）：插件加载时读 vendor 最新版，子模块更新后无需任何
// 同步步骤、重启即生效。vendor 缺失或上游结构变化 → fail loud。
const VENDOR_CORDIS = fileURLToPath(new URL('../upstream/dsh-anchored-standard/preset/agent.cordis.yml', import.meta.url))

export interface SkillFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  metadata?: Record<string, unknown>
}

const ROUTER_FIRST_TURN_BLOCK = `# prompt-tool 本地附加件（最优组合）：首轮只保留计划段 + 训练原句，
# 并清空自动注入 contexts；子代理直接放行。注册在 tool-bootstrap 之后，
# 不参与首轮工具目录裁剪——tools 仍由原版 tool-bootstrap 负责。
- id: router-first-turn
  name: ./router-first-turn.mjs
`

const ROUTER_GUIDE_BLOCK = `# Flash 主会话每轮近距离深度引导（dsh-router-standard 方案）。
# 模型为 Flash 且会话晋升后，每个真实用户消息之后追加固定引导。
# useCustom=true 时固定使用 text；false 按任务自动选择。
- id: router-guide
  name: ./router-guide.mjs
  config:
    text: |-
      __GUIDE_TEXT__
    useCustom: __USE_GUIDE_CUSTOM__
    enabled: __GUIDE_ENABLED__
`

const NEAR_ANCHOR_BLOCK = `# prompt-tool 近距离首句锚定：在首条真实用户消息之后追加一次性锚点。
# 不拆轮、不挪任务；useCustom=false 时按任务自动选择 we/let 首句，
# useCustom=true 时固定使用 anchorText。
- id: near-anchor
  name: ./near-anchor.mjs
  config:
    anchorText: |-
      __ANCHOR_TEXT__
    useCustom: __USE_CUSTOM__
`

const LOCAL_INJECTOR_BLOCK = `# prompt-tool 附加件：锚定确认后注入 preset.md。注册在工具引导之后，
# 不参与首轮剥离顺序；tools / 上下文剥离由 tool-bootstrap 与
# router-first-turn 负责（首轮 = Minimal 真实 schema + 训练原句）。
- id: prompt-injector
  name: ./prompt-injector.mjs
  config:
    promptText: |-
      __PROMPT_TOOL_TEXT__
`

// 解析 skills/*/SKILL.md 的 YAML frontmatter（name/description/whenToUse/metadata）。
// 使用正规 YAML 解析器，与 dsh 技能包的 filesystem provider 保持同一套字段来源。
export function parseFrontmatter(text: string): { data: SkillFrontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text }
  const data: SkillFrontmatter = {}
  const doc = parseYaml(match[1]!, { logLevel: 'silent' }) as Record<string, unknown> | null
  if (doc !== null && typeof doc === 'object') {
    if (typeof doc.name === 'string') data.name = doc.name
    if (typeof doc.description === 'string') data.description = doc.description
    if (typeof doc.whenToUse === 'string') data.whenToUse = doc.whenToUse
    if (doc.metadata !== null && typeof doc.metadata === 'object') {
      data.metadata = doc.metadata as Record<string, unknown>
    }
  }
  return { data, body: text.slice(match[0].length) }
}

export interface BuildCordisOptions {
  /** 首轮近距离锚定：首条真实用户消息后追加一次性首句锚点。 */
  anchorFirstTurn?: boolean
  /** 自定义锚点文本；anchorCustom=true 时固定使用。 */
  anchorText?: string
  /** 自定义锚点开关：true 固定使用 anchorText；false 按任务自动选择。 */
  anchorCustom?: boolean
  /** 自定义每轮引导文本；guideCustom=true 时固定使用。 */
  guideText?: string
  /** 自定义每轮引导开关：true 固定使用 guideText；false 按任务自动选择。 */
  guideCustom?: boolean
  /** 锚定确认后注入 preset.md；关闭时仍保留工具引导，但不注册 prompt-injector 行。 */
  injectPrompt?: boolean
  /** 子代理固定 Flash 模型：true 时给 subagent/subagent_fork 行加 agentOptions。 */
  subagentFlash?: boolean
  /** 子代理 Flash 路由 provider（默认 deepseek-official）。 */
  subagentFlashProvider?: string
  /** 子代理 Flash 模型名（默认 deepseek-v4-flash）。 */
  subagentFlashModel?: string
  /** Windows custom-bash 可执行名或路径；默认 bash.exe（PATH 查找）。 */
  bashPath?: string
}

/** dsh-router-standard 的 Flash 弱路由 persona（子代理版）。 */
const ROUTER_FLASH_PERSONA = [
  'You are a helpful assistant.',
  'Before acting, decide the task type (build or fix) and adopt the matching style: build → hands-on production; fix → inspect-and-plan.',
  'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.',
  'Think deeply first, then produce.',
].join('\n')

/** 适配上游 context-gate：保留 near-anchor 消息；子代理沿用全量放行策略。 */
function normalizeContextGate(source: string): string {
  const block = `- id: context-gate
  name: ./context-gate.mjs
  config:
    promoteOn: either
    includeSubagents: true
    allowKinds: [skill-invocation]`
  const replaced = `- id: context-gate
  name: ./context-gate.mjs
  config:
    promoteOn: either
    includeSubagents: false
    allowKinds: [skill-invocation, near-anchor, router-guide]`
  if (!source.includes(block)) throw new Error('vendor agent.cordis.yml missing context-gate row')
  return source.replace(block, replaced)
}

/** 上游可能携带作者机器固定路径；生成时统一改写为可配置 bashPath。 */
function normalizeBashPath(source: string, bashPath: string): string {
  const marker = /bashPath:\s*'[^']*'/.exec(source)
  if (marker === null) throw new Error('vendor agent.cordis.yml missing bashPath row')
  return source.replace(marker[0], `bashPath: '${bashPath}'`)
}

/** 给 subagent/subagent_fork 行加 dsh-router-standard 的 Flash 子代理方案；关闭时保持继承主会话路由。 */
function applySubagentFlash(source: string, enabled: boolean, provider: string, model: string): string {
  if (!enabled) return source
  const agentOptions = `        agentOptions:
          provider: ${provider}
          model: ${model}`
  const persona = ROUTER_FLASH_PERSONA.split('\n').map((line) => `          ${line}`).join('\n')
  const targets = [
    { id: 'tool-subagent', toolName: 'subagent', provider: 'spawn' },
    { id: 'tool-subagent-fork', toolName: 'subagent_fork', provider: 'fork' },
  ]
  let out = source
  for (const target of targets) {
    const block = `    - id: ${target.id}
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: ${target.provider}
        toolName: ${target.toolName}
        backgroundMode: continuable`
    const replaced = `${block}
${agentOptions}
        persona: |-
${persona}`
    if (!out.includes(block)) throw new Error(`vendor agent.cordis.yml missing ${target.id} row`)
    out = out.replace(block, replaced)
  }
  return out
}

// agent.cordis.yml 直引子模块 + 运行时注入本地附加块。
// 锚点定位到 tool-bootstrap 行与其后第一个零缩进非空行，不依赖 config 字段文本；
// 替换占位符后断言无残留，并用 YAML 解析器验证生成文件结构，失败即 fail loud。
export function buildCordis(prompt: string, options: BuildCordisOptions = {}): string {
  const anchorFirstTurn = options.anchorFirstTurn === true
  const anchorCustom = options.anchorCustom === true
  const guideCustom = options.guideCustom === true
  const guideText = typeof options.guideText === 'string' && options.guideText.length > 0 ? options.guideText : ''
  const injectPrompt = options.injectPrompt !== false
  const anchorText = typeof options.anchorText === 'string' && options.anchorText.length > 0
    ? options.anchorText
    : ''
  const indent = (s: string) => s.split(/\r?\n/).map((l) => l.length === 0 ? '' : '      ' + l).join('\n')
  const up = normalizeContextGate(
    normalizeBashPath(
    applySubagentFlash(
      readFileSync(VENDOR_CORDIS, 'utf8').replace(/\r\n/g, '\n'),
      options.subagentFlash === true,
      typeof options.subagentFlashProvider === 'string' && options.subagentFlashProvider.length > 0 ? options.subagentFlashProvider : 'deepseek-official',
      typeof options.subagentFlashModel === 'string' && options.subagentFlashModel.length > 0 ? options.subagentFlashModel : 'deepseek-v4-flash',
    ),
    typeof options.bashPath === 'string' && options.bashPath.length > 0 ? options.bashPath : 'bash.exe',
    ),
  )

  // 1) 定位 tool-bootstrap 顶层条目，并把插入点放在该条目之后：
  //    条目内部行（缩进行）与空行跳过，遇到下一个零缩进非空行（注释块或条目）即停。
  const bootstrap = /^-\s+id:\s+tool-bootstrap\s*$/m.exec(up)
  if (!bootstrap) throw new Error('vendor agent.cordis.yml missing tool-bootstrap row')
  let cursor = up.indexOf('\n', bootstrap.index)
  if (cursor < 0) throw new Error('vendor agent.cordis.yml has no top-level row after tool-bootstrap')
  cursor += 1
  let insertAt = -1
  while (cursor <= up.length) {
    const lineEnd = up.indexOf('\n', cursor)
    const line = lineEnd < 0 ? up.slice(cursor) : up.slice(cursor, lineEnd)
    if (line.trim() !== '' && !/^\s/.test(line)) {
      insertAt = cursor
      break
    }
    if (lineEnd < 0) break
    cursor = lineEnd + 1
  }
  if (insertAt < 0) throw new Error('vendor agent.cordis.yml has no top-level row after tool-bootstrap')
  const head = up.slice(0, insertAt)
  const tail = up.slice(insertAt)
  const separator = head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n'

  // 2) 按开关组装附加块：router-first-turn 恒启用（最优组合）；
  //    near-anchor 由 anchorFirstTurn 控制；prompt-injector 负责 promptText 注入。
  const guideBlock = ROUTER_GUIDE_BLOCK
    .replace('    useCustom: __USE_GUIDE_CUSTOM__', `    useCustom: ${anchorFirstTurn && guideCustom}`)
    .replace('    enabled: __GUIDE_ENABLED__', `    enabled: ${anchorFirstTurn}`)
    .replace('    text: |-\n      __GUIDE_TEXT__', '    text: |-\n' + (guideText.length > 0 ? indent(guideText) : '      '))
  const parts: string[] = [ROUTER_FIRST_TURN_BLOCK, guideBlock]
  if (anchorFirstTurn) {
    const anchorMarker = '    anchorText: |-\n      __ANCHOR_TEXT__'
    if (!NEAR_ANCHOR_BLOCK.includes(anchorMarker)) {
      throw new Error('internal error: near-anchor template lost its anchorText placeholder')
    }
    const anchorBlock = NEAR_ANCHOR_BLOCK
      .replace('    useCustom: __USE_CUSTOM__', `    useCustom: ${anchorCustom}`)
      .replace(anchorMarker, '    anchorText: |-\n' + (anchorText.length > 0 ? indent(anchorText) : '      '))
    parts.push(anchorBlock)
  }
  if (injectPrompt) {
    const promptMarker = '    promptText: |-\n      __PROMPT_TOOL_TEXT__'
    if (!LOCAL_INJECTOR_BLOCK.includes(promptMarker)) {
      throw new Error('internal error: prompt-injector template lost its promptText placeholder')
    }
    parts.push(LOCAL_INJECTOR_BLOCK.replace(promptMarker, '    promptText: |-\n' + indent(prompt)))
  }

  const extra = parts.join('\n')
  const out = head + separator + extra + '\n' + tail
  if ((injectPrompt && out.includes('__PROMPT_TOOL_TEXT__')) || (anchorFirstTurn && (out.includes('__ANCHOR_TEXT__') || out.includes('__USE_CUSTOM__'))) || out.includes('__GUIDE_TEXT__') || out.includes('__USE_GUIDE_CUSTOM__') || out.includes('__GUIDE_ENABLED__')) {
    throw new Error('internal error: preset template placeholder was not replaced')
  }

  // 3) 生成文件必须是合法 YAML，且按开关校验本插件行落位。
  let parsed: unknown
  try {
    parsed = parseYaml(out, { logLevel: 'silent' })
  } catch (error) {
    throw new Error(`generated agent.cordis.yml is invalid YAML: ${String((error as Error & { message?: string }).message ?? error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('generated agent.cordis.yml is not a YAML array')
  const ids = new Set(parsed.map((row) => (row as { id?: string } | null)?.id))
  if (!ids.has('router-first-turn')) throw new Error('generated agent.cordis.yml is missing the router-first-turn row')
  if (injectPrompt && !ids.has('prompt-injector')) throw new Error('generated agent.cordis.yml is missing the prompt-injector row')
  if (!injectPrompt && ids.has('prompt-injector')) throw new Error('generated agent.cordis.yml still contains the prompt-injector row')
  if (anchorFirstTurn && !ids.has('near-anchor')) throw new Error('generated agent.cordis.yml is missing the near-anchor row')
  if (!anchorFirstTurn && ids.has('near-anchor')) throw new Error('generated agent.cordis.yml still contains the near-anchor row')
  return out
}

/**
 * prompt-tool preset 生成核心：与 dsh 插件上下文无关的纯函数，
 * 独立成文件以便单元测试与复用。失败一律抛出（fail loud）。
 */
import { parse as parseYaml } from 'yaml'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// agent.cordis.yml 已脱离上游运行时直读：使用本项目自有模板（preset/agent.cordis.yml），
// 动态项（usePtcMode / bootstrapMaxTokens / subagentFlash）仍由 buildCordis 注入。
// 上游文件仅作溯源与 sync 对照。
const CORDIS_TEMPLATE = fileURLToPath(new URL('../preset/agent.cordis.yml', import.meta.url))

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
  /** 首轮输出封顶（bootstrapMaxTokens）；0 或未设置 = 本项目默认无封顶。 */
  bootstrapMaxTokens?: number
  /** 使用 PTC 模式：默认 true——晋升后把 wire 切换为 Code Mode（单一 run_code，完整插件工具经生成 SDK 调用）；显式 false 时晋升后恢复原生完整工具目录。 */
  usePtcMode?: boolean
}

/** dsh-router-standard 的 Flash 弱路由 persona（子代理版）。 */
const ROUTER_FLASH_PERSONA = [
  'You are a helpful assistant.',
  'Before acting, decide the task type (build or fix) and adopt the matching style: build → hands-on production; fix → inspect-and-plan.',
  'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.',
  'Think deeply first, then produce.',
].join('\n')


/** 按开关向本地 tool-bootstrap 行注入 usePtcMode / bootstrapMaxTokens。 */
function applyToolBootstrapOptions(source: string, usePtcMode: boolean, bootstrapMaxTokens?: number): string {
  const rowStart = source.indexOf('- id: tool-bootstrap\n  name: ./tool-bootstrap.mjs\n  config:\n')
  if (rowStart < 0) throw new Error('preset/agent.cordis.yml missing tool-bootstrap config block')
  const include = source.indexOf('    includeSubagents: true\n', rowStart)
  if (include < 0) throw new Error('preset/agent.cordis.yml tool-bootstrap row missing includeSubagents')
  const at = include + '    includeSubagents: true'.length + 1
  const lines = [`    usePtcMode: ${usePtcMode}`]
  if (bootstrapMaxTokens !== undefined && Number.isSafeInteger(bootstrapMaxTokens) && bootstrapMaxTokens > 0) {
    lines.push(`    bootstrapMaxTokens: ${bootstrapMaxTokens}`)
  }
  return source.slice(0, at) + lines.join('\n') + '\n' + source.slice(at)
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
    if (!out.includes(block)) throw new Error(`preset/agent.cordis.yml missing ${target.id} row`)
    out = out.replace(block, replaced)
  }
  return out
}

/** 给生成的 tool-bootstrap.mjs 打补丁：子代理全量放行 + 可选的 PTC 呈现切换。 */
export function patchToolBootstrap(source: string): string {
  source = source.replace(/\r\n/g, '\n')

  // 1) 子代理跳过目录裁剪，直接使用组装结果。
  const original = [
    '    const assembled = await next()',
    '    try {',
    '      const status = promotion.status(context.agent)',
  ].join('\n')
  const replacement = [
    '    const assembled = await next()',
    '    try {',
    '      const agent = context.agent',
    '      if (agent === undefined) return assembled',
    '      // prompt-tool patch: subagents skip catalog narrowing and use assembled tools directly.',
    '      // Callers (such as dsh-mnemon) already filter assembled.tools through their own whitelists.',
    '      // New plugin tools with any prefix therefore appear in the subagent first session automatically.',
    "      agentBySession.set(agent.session, agent)",
    "      if ((agent.session?.header?.delegationDepth ?? 0) > 0) {",
    '        if (usePtcMode) applyCodePresentation(agent)',
    '        return assembled',
    '      }',
    '      const status = promotion.status(agent)',
  ].join('\n')
  if (!source.includes(original)) {
    throw new Error('tool-bootstrap.mjs assembled marker missing')
  }
  source = source.replace(original, replacement)

  // 2) 允许并解析 usePtcMode 配置。
  const allowedOriginal = "const ALLOWED_KEYS = new Set(['bootstrapTools', 'promoteOn', 'bootstrapMaxTokens', 'compactionTools', 'includeSubagents'])"
  const allowedReplacement = "const ALLOWED_KEYS = new Set(['bootstrapTools', 'promoteOn', 'bootstrapMaxTokens', 'compactionTools', 'includeSubagents', 'usePtcMode'])"
  if (!source.includes(allowedOriginal)) {
    throw new Error('tool-bootstrap.mjs ALLOWED_KEYS marker missing')
  }
  source = source.replace(allowedOriginal, allowedReplacement)

  const parseOriginal = "  const includeSubagents = booleanOption(source.includeSubagents, 'includeSubagents', false)"
  const parseReplacement = parseOriginal + "\n  const usePtcMode = booleanOption(source.usePtcMode, 'usePtcMode', true)"
  if (!source.includes(parseOriginal)) {
    throw new Error('tool-bootstrap.mjs includeSubagents parse marker missing')
  }
  source = source.replace(parseOriginal, parseReplacement)

  // 3) 插入 PTC 呈现状态机与 step/turn 边界监听器。
  const trackerOriginal = [
    '  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })',
    "  ctx.on('session/event', (session, event) => promotion.observe(session, event))",
  ].join('\n')
  const trackerReplacement = [
    '  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })',
    '',
    '  // prompt-tool patch: optional Code Mode (PTC) wire presentation after promotion.',
    '  const presentationBySession = new WeakMap()',
    '  const agentBySession = new WeakMap()',
    '  const presentationState = (session) => {',
    '    let state = presentationBySession.get(session)',
    '    if (state === undefined) {',
    '      state = { applied: false, disposer: undefined }',
    '      presentationBySession.set(session, state)',
    '    }',
    '    return state',
    '  }',
    '  const applyCodePresentation = (agent) => {',
    '    const session = agent?.session',
    '    if (session === undefined) return',
    '    const state = presentationState(session)',
    '    if (state.applied) return',
    '    const tools = agent.ctx?.tools',
    '    if (tools === undefined || typeof tools.presentAs !== \'function\') return',
    '    state.disposer = tools.presentAs(\'code\')',
    '    state.applied = true',
    '  }',
    '  const releaseCodePresentation = (session) => {',
    '    const state = presentationBySession.get(session)',
    '    if (state === undefined) return',
    '    if (typeof state.disposer === \'function\') {',
    '      try { state.disposer() } catch { /* never brick the session */ }',
    '    }',
    '    state.disposer = undefined',
    '    state.applied = false',
    '  }',
    "  ctx.on('session/event', (session, event) => promotion.observe(session, event))",
    '',
    "  ctx.on('session/event', (session, event) => {",
    '    if (!usePtcMode) return',
    "    if (event.type === 'compaction/end') {",
    '      releaseCodePresentation(session)',
    '      return',
    '    }',
    "    if (event.type !== 'step/end' && event.type !== 'turn/end') return",
    '    const agent = agentBySession.get(session)',
    '    if (agent !== undefined && promotion.status(agent).promoted) applyCodePresentation(agent)',
    '  })',
  ].join('\n')
  if (!source.includes(trackerOriginal)) {
    throw new Error('tool-bootstrap.mjs promotion tracker marker missing')
  }
  source = source.replace(trackerOriginal, trackerReplacement)

  // 4) 晋升后保留组装目录；usePtcMode 只切换 wire 呈现，不再裁剪 resident 集。
  const promotedStart = source.indexOf('      if (status.promoted) {\n        // PROMOTED:')
  const promotedEnd = source.indexOf('      // Controlled phase:', promotedStart)
  if (promotedStart < 0 || promotedEnd < 0) {
    throw new Error('tool-bootstrap.mjs promoted/controlled marker missing')
  }
  const promotedReplacement = [
    '      if (status.promoted) {',
    '        // prompt-tool patch: both modes keep the assembled catalog after promotion.',
    '        // usePtcMode switches the wire presentation instead of narrowing resident tools.',
    '        if (usePtcMode) applyCodePresentation(agent)',
    '        return assembled',
    '      }',
    '',
  ].join('\n')
  source = source.slice(0, promotedStart) + promotedReplacement + source.slice(promotedEnd)

  // 5) 移除上游 dev_tool_search 常驻集与解锁状态机（该工具已从 preset 移除）。
  const residentOriginal = "const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']\n\n"
  if (source.includes(residentOriginal)) source = source.replace(residentOriginal, '')
  const unlockedStart = source.indexOf('/**\n   * Tool names the model explicitly unlocked via `dev_tool_search`')
  const unlockedEnd = source.indexOf('  /** Narrow the assembled catalog', unlockedStart)
  if (unlockedStart >= 0 && unlockedEnd > unlockedStart) {
    source = source.slice(0, unlockedStart) + source.slice(unlockedEnd)
  }

  // 6) 更新晋升后目录说明，移除 dev_tool_search 历史叙述。
  const headerStart = source.indexOf(' * POST-PROMOTION RESIDENT SET')
  const headerEnd = source.indexOf(' * COMPACTION (local addition)', headerStart)
  if (headerStart >= 0 && headerEnd > headerStart) {
    const headerReplacement = [
      ' * POST-PROMOTION CATALOG (prompt-tool patch): after promotion both modes',
      ' * keep the assembled catalog. `usePtcMode` switches the wire presentation',
      ' * to Code Mode (PTC, single run_code) instead of narrowing the resident set.',
      ' * The controlled phase below still narrows the catalog before promotion and',
      ' * after compaction.',
      '',
    ].join(String.fromCharCode(10))
    source = source.slice(0, headerStart) + headerReplacement + source.slice(headerEnd)
  }
  return source
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
  const usePtcMode = options.usePtcMode !== false
  const anchorText = typeof options.anchorText === 'string' && options.anchorText.length > 0
    ? options.anchorText
    : ''
  const indent = (s: string) => s.split(/\r?\n/).map((l) => l.length === 0 ? '' : '      ' + l).join('\n')
  const up = applyToolBootstrapOptions(
    applySubagentFlash(
      readFileSync(CORDIS_TEMPLATE, 'utf8').replace(/\r\n/g, '\n'),
      options.subagentFlash === true,
      typeof options.subagentFlashProvider === 'string' && options.subagentFlashProvider.length > 0 ? options.subagentFlashProvider : 'deepseek-official',
      typeof options.subagentFlashModel === 'string' && options.subagentFlashModel.length > 0 ? options.subagentFlashModel : 'deepseek-v4-flash',
    ),
    usePtcMode,
    options.bootstrapMaxTokens,
  )
  // 1) 定位 tool-bootstrap 顶层条目，并把插入点放在该条目之后：
  //    条目内部行（缩进行）与空行跳过，遇到下一个零缩进非空行（注释块或条目）即停。
  const bootstrap = /^-\s+id:\s+tool-bootstrap\s*$/m.exec(up)
  if (!bootstrap) throw new Error('preset/agent.cordis.yml missing tool-bootstrap row')
  let cursor = up.indexOf('\n', bootstrap.index)
  if (cursor < 0) throw new Error('preset/agent.cordis.yml has no top-level row after tool-bootstrap')
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
  if (insertAt < 0) throw new Error('preset/agent.cordis.yml has no top-level row after tool-bootstrap')
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

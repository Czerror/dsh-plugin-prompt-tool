/**
 * prompt-tool preset 核心(兼容层):
 *   - buildCordis:按单一参数 preset.yml 渲染 anchored 组合文件(不再做字符串补丁);
 *   - patchToolBootstrap:上游原始快照的补丁函数(仅测试/溯源保留,writePreset 已不使用);
 *   - parseFrontmatter:skills frontmatter 解析。
 * 新代码请使用 src/engine/ 下的 manifest / write-preset / prompt-configs / templates。
 */
import { parse as parseYaml } from 'yaml'
import { fileURLToPath } from 'node:url'
import { loadCompositionText, loadPresetSpec, renderTemplateVariables, resolvePresetTokens } from './engine/manifest.ts'

// anchored 预设模板目录(打包后 lib/ 与包根 preset/ 平级)。
const ANCHORED_TEMPLATE_DIR = fileURLToPath(new URL('../preset/anchored/', import.meta.url))

export interface SkillFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  metadata?: Record<string, unknown>
  /** 官方调用策略：true 时模型不可发现/不可加载（默认 false = 可调用）。 */
  disableModelInvocation?: boolean
  /** 官方调用策略：false 时用户命令不可加载（默认 true）。 */
  userInvocable?: boolean
}

import type { BuildCordisOptions } from './engine/prompt-configs.ts'
export type { BuildCordisOptions, PromptConfigFile, PromptConfigSpec } from './engine/prompt-configs.ts'
export { buildDefaultPromptConfigs, buildPromptConfigFiles, loadPromptConfigFiles, mergePromptConfigs, renderPromptConfigYaml } from './engine/prompt-configs.ts'

const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

// 解析 skills/*/SKILL.md 的 YAML frontmatter（name/description/whenToUse/metadata
// 与官方 disable-model-invocation / user-invocable 调用策略）。
// 使用正规 YAML 解析器，与 dsh 技能包的 filesystem provider 保持同一套字段来源。
// 容忍 UTF-8 BOM：Windows 记事本保存的文件会在 --- 前写入 EF BB BF，
// 不剥离会导致整个 frontmatter 匹配失败。
export function parseFrontmatter(text: string): { data: SkillFrontmatter; body: string } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { data: {}, body: source }
  const data: SkillFrontmatter = {}
  const doc = parseYaml(match[1]!, { logLevel: 'silent' }) as Record<string, unknown> | null
  if (doc !== null && typeof doc === 'object') {
    if (typeof doc.name === 'string') data.name = doc.name
    if (typeof doc.description === 'string') data.description = doc.description
    if (typeof doc.whenToUse === 'string') data.whenToUse = doc.whenToUse
    if (doc.metadata !== null && typeof doc.metadata === 'object') {
      data.metadata = doc.metadata as Record<string, unknown>
    }
    // 接受官方连字符字段与旧版驼峰字段；布尔语义与官方 filesystem provider 一致。
    const disable = asBoolean(doc['disable-model-invocation']) ?? asBoolean(doc.disableModelInvocation)
    if (disable !== undefined) data.disableModelInvocation = disable
    const userInvocable = asBoolean(doc['user-invocable']) ?? asBoolean(doc.userInvocable)
    if (userInvocable !== undefined) data.userInvocable = userInvocable
  }
  return { data, body: source.slice(match[0].length) }
}

/**
 * 渲染 anchored 组合文件:
 * agent.cordis.yml 是模板自带完整组合(含 router-first-turn 与 prompt-config-engine 行),
 * 动态值全部由 preset.yml 的 variables 声明为 __TOKEN__;本函数只做变量替换 + YAML 校验。
 */
export function buildCordis(prompt: string, options: BuildCordisOptions = {}): string {
  const spec = loadPresetSpec(ANCHORED_TEMPLATE_DIR)
  const runtime = {
    promptText: prompt,
    anchorFirstTurn: options.anchorFirstTurn === true,
    anchorCustom: options.anchorCustom === true,
    anchorText: typeof options.anchorText === 'string' ? options.anchorText : '',
    guideCustom: options.guideCustom === true,
    guideText: typeof options.guideText === 'string' ? options.guideText : '',
    injectPrompt: options.injectPrompt !== false,
    usePtcMode: options.usePtcMode !== false,
    bootstrapMaxTokens: Number.isSafeInteger(options.bootstrapMaxTokens) && (options.bootstrapMaxTokens ?? 0) > 0
      ? options.bootstrapMaxTokens
      : 0,
    subagentFlash: options.subagentFlash === true,
    subagentFlashProvider: typeof options.subagentFlashProvider === 'string' && options.subagentFlashProvider.length > 0
      ? options.subagentFlashProvider
      : 'deepseek-official',
    subagentFlashModel: typeof options.subagentFlashModel === 'string' && options.subagentFlashModel.length > 0
      ? options.subagentFlashModel
      : 'deepseek-v4-flash',
  }
  const tokens = resolvePresetTokens(spec, runtime)
  const out = renderTemplateVariables(loadCompositionText(spec), tokens)
  const unresolved = out.match(/__[A-Z0-9_]+__/g)
  if (unresolved !== null) throw new Error(`generated agent.cordis.yml has unresolved variables: ${unresolved.join(', ')}`)

  // 生成文件必须是合法 YAML,且引擎行指向提示词配置模块目录与模板策略目录。
  let parsed: unknown
  try {
    parsed = parseYaml(out, { logLevel: 'silent' })
  } catch (error) {
    throw new Error(`generated agent.cordis.yml is invalid YAML: ${String((error as Error & { message?: string }).message ?? error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('generated agent.cordis.yml is not a YAML array')
  const ids = new Set(parsed.map((row) => (row as { id?: string } | null)?.id))
  if (!ids.has('router-first-turn')) throw new Error('generated agent.cordis.yml is missing the router-first-turn row')
  if (!ids.has('prompt-config-engine')) throw new Error('generated agent.cordis.yml is missing the prompt-config-engine row')
  const engine = parsed.find((row) => (row as { id?: string } | null)?.id === 'prompt-config-engine') as { config?: { configsDir?: string } } | undefined
  if (engine?.config?.configsDir !== '../prompt-configs') throw new Error('generated agent.cordis.yml prompt-config-engine row must point configsDir at ../prompt-configs')
  return out
}

/** 给上游 tool-bootstrap.mjs 打补丁:子代理全量放行 + 可选的 PTC 呈现切换(仅溯源测试用)。 */
export function patchToolBootstrap(source: string): string {
  source = source.replace(/\r\n/g, '\n')

  // 1) 子代理跳过目录裁剪,直接使用组装结果。
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

  // 4) 晋升后保留组装目录;usePtcMode 只切换 wire 呈现,不再裁剪 resident 集。
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

  // 5) 移除上游 dev_tool_search 常驻集与解锁状态机(该工具已从 preset 移除)。
  const residentOriginal = "const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']\n\n"
  if (source.includes(residentOriginal)) source = source.replace(residentOriginal, '')
  const unlockedStart = source.indexOf('/**\n   * Tool names the model explicitly unlocked via `dev_tool_search`')
  const unlockedEnd = source.indexOf('  /** Narrow the assembled catalog', unlockedStart)
  if (unlockedStart >= 0 && unlockedEnd > unlockedStart) {
    source = source.slice(0, unlockedStart) + source.slice(unlockedEnd)
  }

  // 6) 更新晋升后目录说明,移除 dev_tool_search 历史叙述。
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

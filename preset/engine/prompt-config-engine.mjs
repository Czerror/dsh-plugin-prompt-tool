/**
 * prompt-config-engine — prompt-tool 的唯一提示词注入执行器。
 *
 * 架构职责（P0-1 统一提示词配置）：
 *   本模块只负责「注入」：
 *     - 挂载 agent/pre-step waterfall；
 *     - 跟踪 epoch-aware promotion（主会话 / 子代理两种语义）；
 *     - 按提示词配置声明的 modelScope / subagents / promotion / position / dedupe
 *       过滤与落位；
 *     - 构造 user 消息（id/role/content/source）并插入决策消息面；
 *     - 以持久事件 + 进程内快路径做幂等；
 *     - 任一提示词配置失败只跳过该提示词配置并 warnOnce，绝不让注入 bug 卡死会话。
 *
 *   旧有 near-anchor / router-guide / prompt-injector / instruction-hint
 *   四个独立 .mjs 模块已移除。它们退化为「提示词配置文件夹」中的 YAML 提示词配置
 *   （默认 ./prompt-configs/*.yml，文件名数字前缀决定执行顺序）+ 引擎内置策略：
 *
 *     strategy          说明
 *     static            固定文本（text 字段，或 templateFile 引用外部模板）
 *     anchor-auto       首句锚点：按任务自动选择 we 构建 / we 检查 / let 深推
 *     guide-auto        每轮引导：按任务自动选择弱引导 / 深度引导，
 *                       useCustom 时固定文本（Pro/Flash 都注入）
 *     anchor-fallback   锚定词注入：晋升后首个 reasoning 命中自定义锚定词
 *                       （params.anchorWord，默认 "we"）立即注入一次，
 *                       未命中最多等一轮兜底；we-fallback 为兼容别名
 *     instruction-hint  晋升后一次性提示 AGENTS/CLAUDE 文件存在
 *                       （agents-instruction.txt 优先，否则探测文件系统）
 *
 *   agent.cordis.yml 只保留一个 engine 行：
 *     - id: prompt-config-engine
 *       name: ./prompt-config-engine.mjs
 *       config:
 *         configsDir: ./prompt-configs
 *
 *   提示词配置文件 schema（每个 yml/json 一个提示词配置）：
 *     layer         官方注入通道，决定提示词配置在哪个 API 层执行：
 *                     pre-step          agent/pre-step 消息批（当前默认）
 *                     system-section    systemPrompt.section 静态 system 段
 *                     runtime-context   systemPrompt.context 动态运行时快照
 *                     agent-request     agent/request 调用配置 patch
 *                     llm-stream        llm/stream 流包装（pass/replace）
 *                     tool-pipeline     tools/pre-execute·execute·post-execute
 *   id            提示词配置名，也是默认 source.plugin 与幂等标识
 *   enabled       false 时引擎跳过
 *   strategy      上述五种内容策略之一
 *   position      'after-user' | 'before-all' | 'after-all'（pre-step 层）
 *   dedupe        'session'（每会话一次，持久事件幂等） | 'batch'（当前批去重）
 *   promotion     'none' | 'main' | 'include-subagents'
 *                 none=不要求晋升；main=主会话 tracker（子代理恒视为已晋升）；
 *                 include-subagents=子代理跟随自己的首轮晋升阶段
 *   subagents     'none' | 'inherit' | 'only'（only=仅子代理）
 *   modelScope    'all' | 'pro' | 'flash'（按 agent.options.model 过滤）
 *   sourceKind    默认注入消息的 source.kind
 *   identity      { field: 'plugin' | 'kind', value } —— 持久事件幂等匹配
 *   text          strategy=static 或各策略的自定义文本
 *   templateFile  外部 yml/json/纯文本内容模板
 *   params        各策略的专用参数；agent-request 用 patch，tool-pipeline
 *                 用 preDecision/postAction/toolNames，llm-stream 用 mode
 *
 *   各层声明式参数：
 *     system-section    text/templateFile（支持官方 {{variable}}）、params.complete
 *     runtime-context   text/templateFile（支持官方 {{variable}}）
 *     agent-request     params.patch（LlmCallConfig 字段浅合并）、params.replace
 *     llm-stream        params.mode='pass'（默认）| 'replace'（text 替代流）
 *     tool-pipeline     params.toolNames（逗号分隔，空=全部）、
 *                       params.preDecision='allow'|'deny'|'ask'、
 *                       params.postAction='accept'|'replace'|'block'
 *
 * 提示词配置处理顺序契约（等价旧多行注册顺序的嵌套展开）：
 *   near-anchor → router-guide → prompt-injector → instruction-hint。
 * after-user 提示词配置之间：先执行的提示词配置先贴近用户消息，后执行者在同一用户索引之后
 * 再次插入——与旧 waterfall 外层 router-guide 看到内层 near-anchor 结果后的
 * 最终顺序一致。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { parse as parseYaml } from './vendor/yaml/index.js'
import { createEpochPromotion } from './compaction-epoch.mjs'
import { createWarnOnce, extractText, isDelegated, newMessageId, PROMOTE_EVENTS } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'prompt-config-engine'

/**
 * 等待全部可注入层级的宿主服务。preset 行在 agent 组合内解析这些服务
 * （persona 依赖 systemPrompt，工具行依赖 tools，agent loop 依赖 llm）。
 */
export const inject = ['systemPrompt', 'tools', 'llm']

// ── near-anchor 策略文本（自旧 near-anchor.mjs） ───────────────────────────
const BUILD_RE = /(开发|创建|写一个|生成|从零|做一个|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/i
const COMPLEX_RE = /(架构|重构|设计|系统|全面|深度|迁移|兼容|审查|architecture|refactor|comprehensive|design|system|migrate|review)/i
const ANCHOR_BUILD = "Start your reasoning with the exact sentence: 'We need to build it directly and verify it.'"
const ANCHOR_INSPECT = "Start your reasoning with the exact sentence: 'We need to inspect the code first.'"
const ANCHOR_DEEP = "Start your reasoning with the exact sentence: 'Let me think through the design before changing anything.'"

// ── router-guide 策略文本（自旧 router-guide.mjs） ─────────────────────────
const GUIDE_COMPLEX_RE = /(架构|重构|全面|详细|设计|系统|优化|分析|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i
const GUIDE_WEAK = '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.'
const GUIDE_DEEP = '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'
const DEFAULT_GUIDE_TEXT = ['简单任务自动引导：', GUIDE_WEAK.trim(), '', '复杂任务自动引导：', GUIDE_DEEP.trim()].join('\n')

// ── instruction-hint 策略（自旧 instruction-hint.mjs） ─────────────────────
const PROJECT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
const USER_GLOBAL_CANDIDATE = 'AGENTS.md'

/** instruction-hint 提示文本：agents-instruction.txt 优先，否则动态探测。 */
function readAgentsInstructionText() {
  try {
    return readTextFile(new URL('./agents-instruction.txt', import.meta.url)).trim()
  } catch {
    return ''
  }
}

/**
 * 内容模板加载：提示词配置可声明 templateFile，由外部 yml / json / 纯文本模板提供内容，
 * 引擎只负责读取与注入（内容与执行分离）。
 *   - .json：解析为 { text, id?, role?, content?, source? }，或纯字符串；
 *   - .yml/.yaml：用 vendored yaml 完整解析（顶层对象取 text 等字段）；
 *   - 其他扩展名：整个文件内容作为 text。
 */
function readTextFile(url) {
  return readFileSync(url, 'utf8')
}

function loadTemplate(file) {
  if (typeof file !== 'string' || file.length === 0) return undefined
  let raw
  try {
    raw = readTextFile(new URL(file, import.meta.url))
  } catch {
    throw new TypeError(`${name}: templateFile ${JSON.stringify(file)} is not readable`)
  }
  if (/\.json$/i.test(file)) {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'string' ? { text: parsed } : parsed
    } catch (error) {
      throw new TypeError(`${name}: templateFile ${JSON.stringify(file)} is not valid JSON: ${String(error?.message ?? error)}`)
    }
  }
  if (/\.ya?ml$/i.test(file)) {
    try {
      const parsed = parseYaml(raw)
      return typeof parsed === 'string' ? { text: parsed } : parsed
    } catch (error) {
      throw new TypeError(`${name}: templateFile ${JSON.stringify(file)} is not valid YAML: ${String(error?.message ?? error)}`)
    }
  }
  return { text: raw }
}

// ── 提示词配置文件加载（模块文件夹：每个 yml/json 一个提示词配置） ─────────────────────────

/**
 * 完整 YAML 解析（vendored yaml 包）：提示词配置文件直接使用标准 YAML。
 * 支持缩进 map、列表、block scalar、行尾注释、引号转义等全部语法。
 */
export function parsePromptConfigYaml(raw) {
  const parsed = parseYaml(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${name}: prompt config yaml must contain a single object`)
  }
  return parsed
}

/**
 * 从提示词配置模块目录加载全部提示词配置描述：按文件名排序扫描 *.yml / *.yaml / *.json。
 * 文件名用数字前缀表达引擎执行顺序（00-…、10-…）。
 */
export function loadPromptConfigFiles(dirUrl) {
  let entries
  try {
    entries = readdirSync(dirUrl, { withFileTypes: true })
  } catch (error) {
    throw new TypeError(`${name}: configsDir ${String(dirUrl)} is not readable: ${String(error?.message ?? error)}`)
  }
  const specs = []
  const files = entries
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of files) {
    const url = new URL(entry.name, dirUrl)
    const raw = readFileSync(url, 'utf8')
    if (/\.json$/i.test(entry.name)) {
      specs.push(JSON.parse(raw))
    } else {
      specs.push(parsePromptConfigYaml(raw))
    }
  }
  return specs
}

/** Find the project root: first ancestor containing any root marker (e.g. .git). */
async function findProjectRoot(fs, cwd, signal) {
  let current = cwd
  for (;;) {
    for (const marker of ['.git', '.hg', '.svn']) {
      try {
        const target = await fs.resolve(joinPath(current, marker), { cwd, signal })
        const info = await fs.stat(target, signal)
        if (info !== undefined) return current
      } catch {
        // Probe failure = marker absent; continue.
      }
    }
    const parent = parentPath(current)
    if (parent === current || parent.length === 0) return cwd
    current = parent
  }
}

/** List instruction files present in one directory (project candidates). */
async function presentInDir(fs, dir, candidates, signal) {
  const found = []
  for (const candidate of candidates) {
    try {
      const target = await fs.resolve(joinPath(dir, candidate), { cwd: dir, signal })
      const info = await fs.stat(target, signal)
      if (info !== undefined && info.type === 'file') found.push(candidate)
    } catch {
      // Absent or unreadable — skip.
    }
  }
  return found
}

/** Join one path segment onto a directory (platform-agnostic string join). */
function joinPath(dir, segment) {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + segment
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir + sep + segment
}

/** Parent of an absolute Windows or POSIX path. */
function parentPath(path) {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx <= 0) return path
  const parent = path.slice(0, idx)
  return parent.length === 0 ? path : parent
}

// ── 提示词配置归一化与策略解析 ─────────────────────────────────────────────────────

/** 事件数据兼容两层形状：event.data 本身是消息，或 event.data.message 是消息。 */
function eventMessage(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return undefined
  const message = data.message !== null && typeof data.message === 'object' ? data.message : data
  return message?.source !== null && typeof message?.source === 'object' ? message : undefined
}

/** 按提示词配置声明的 identity 在持久事件流中查找已注入消息。 */
/** 合并身份：merged 模式用 mergeGroup 或同位置默认组名；separate 模式保持自身身份。 */
function mergedIdentity(config) {
  if (config.mergeMode !== 'merged') return config.mergeGroup ?? config.id
  return config.mergeGroup ?? `merged:${config.position}`
}

function hasInjected(config, session) {
  const field = config.identity.field
  const value = config.mergeMode === 'merged' ? mergedIdentity(config) : config.mergeGroup ?? config.identity.value
  return (Array.isArray(session.events) ? session.events : []).some((event) => {
    const message = eventMessage(event)
    return message?.source?.[field] === value
  })
}

/** 当前消息批内是否已有该提示词配置注入（每轮去重）。 */
function hasInBatch(config, messages) {
  const value = config.mergeMode === 'merged' ? mergedIdentity(config) : config.mergeGroup ?? config.identity.value
  return messages.some((message) => message?.source?.[config.identity.field] === value)
}

/** 模型范围过滤：flash=仅 Flash 家族模型；pro=仅非 Flash；all=全部。 */
function matchesModel(scope, model) {
  if (scope === 'all') return true
  const isFlash = typeof model === 'string' && /flash/i.test(model)
  return scope === 'flash' ? isFlash : !isFlash
}

/** 构造默认 user/assistant 消息；策略返回完整 patch 时覆盖对应字段。 */
function buildMessage(config, resolved) {
  const text = typeof resolved.text === 'string' ? resolved.text : ''
  const defaultContent = config.texts.length > 0
    ? config.texts.map((item) => ({ type: 'text', text: item }))
    : [{ type: 'text', text }]
  const sourceValue = mergedIdentity(config)
  return {
    id: typeof resolved.id === 'string' && resolved.id.length > 0 ? resolved.id : newMessageId(config.id),
    role: typeof resolved.role === 'string' ? resolved.role : config.role,
    content: Array.isArray(resolved.content) ? resolved.content : defaultContent,
    source: resolved.source !== null && typeof resolved.source === 'object'
      ? resolved.source
      : {
          kind: config.sourceKind,
          ...(config.identity.field !== 'kind' ? { plugin: sourceValue } : {}),
          ...(typeof config.form === 'string' ? { form: config.form } : {}),
          ...(typeof config.summary === 'string' && config.summary.length > 0 ? { summary: config.summary } : {}),
        },
  }
}

/** 模板变量插值：提示词配置 variables 优先，内置 {{DSH_HOME}} / {{WORKSPACE}} / {{CWD}}。 */
function interpolateVariables(text, variables, session) {
  const builtins = {
    DSH_HOME: process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : ''),
    WORKSPACE: process.env.DSH_WORKSPACE ?? session?.header?.cwd ?? process.cwd(),
    CWD: session?.header?.cwd ?? process.cwd(),
  }
  return text.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) return String(variables[key])
    return Object.prototype.hasOwnProperty.call(builtins, key) ? builtins[key] : whole
  })
}

/** 按提示词配置声明的插入位置写入消息批；找不到插入锚点返回 false（本提示词配置跳过）。 */
function insertMessage(config, messages, message) {
  if (config.position === 'before-all') {
    messages.unshift(message)
    return true
  }
  if (config.position === 'after-all') {
    messages.push(message)
    return true
  }
  // 默认 after-user：只锚真实用户消息，插件消息不算。
  const userIndex = messages.findIndex((item) => item?.source?.kind === 'user')
  if (userIndex < 0) return false
  messages.splice(userIndex + 1, 0, message)
  return true
}

/** anchor-auto：首条真实用户消息后的一次性任务锚点。 */
function createAnchorAutoResolver(config) {
  const useCustom = config.params?.useCustom === true
  const customText = typeof config.params?.anchorText === 'string' ? config.params.anchorText : ''
  return ({ messages }) => {
    if (useCustom) {
      const text = customText.trim()
      return text.length > 0 ? { text } : null
    }
    const userIndex = messages.findIndex((message) => message?.source?.kind === 'user')
    if (userIndex < 0) return null
    const taskText = extractText(messages[userIndex])
    if (taskText.length === 0) return null
    let anchor
    if (COMPLEX_RE.test(taskText)) anchor = ANCHOR_DEEP
    else if (BUILD_RE.test(taskText)) anchor = ANCHOR_BUILD
    else anchor = ANCHOR_INSPECT
    return { text: anchor }
  }
}

/** guide-auto：晋升后每轮用户消息后的弱/深度引导。 */
function createGuideAutoResolver(config) {
  const useCustom = config.params?.useCustom === true
  const customText = typeof config.params?.text === 'string' ? config.params.text : ''
  const unchangedDefault = customText.trim() === DEFAULT_GUIDE_TEXT.trim()
  return ({ messages }) => {
    const userIndex = messages.findIndex((message) => message?.source?.kind === 'user')
    if (userIndex < 0) return null
    const text = extractText(messages[userIndex])
    if (text.length === 0) return null
    if (useCustom && !unchangedDefault) {
      const guide = customText.trim()
      return guide.length > 0 ? { text: guide } : null
    }
    return { text: (text.length > 120 || GUIDE_COMPLEX_RE.test(text)) ? GUIDE_DEEP : GUIDE_WEAK }
  }
}

/** 锚定词正则转义。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 判断 reasoning 开头是否命中自定义锚定词：ASCII 词按词边界匹配，其他按前缀匹配。 */
function matchesAnchorWord(raw, anchorWord) {
  const text = String(raw ?? '').trim()
  if (text.length === 0 || anchorWord.length === 0) return false
  if (/^[\x20-\x7E]+$/.test(anchorWord)) {
    return new RegExp(`^${escapeRegExp(anchorWord.toLowerCase())}\\b`, 'i').test(text)
  }
  return text.startsWith(anchorWord)
}

/**
 * anchor-fallback：晋升后首个 reasoning 命中自定义锚定词（params.anchorWord，
 * 默认 "we"）立即注入一次；未命中最多等满两轮 assistant 消息兜底。
 * we-fallback 保留为兼容别名（默认锚定词 "we"，行为不变）。
 */
function createAnchorFallbackResolver(config) {
  const promptText = (typeof config.text === 'string' && config.text.length > 0)
    ? config.text
    : (typeof config.params?.text === 'string' && config.params.text.length > 0 ? config.params.text : undefined)
  const anchorWord = typeof config.params?.anchorWord === 'string' && config.params.anchorWord.length > 0
    ? config.params.anchorWord
    : 'we'
  /** Sessions whose first assistant reasoning has been scanned (memoized). */
  const anchorScanned = new Map()

  const isAnchorConfirmed = (agent) => {
    const session = agent.session
    const cached = anchorScanned.get(session.id)
    if (cached !== undefined) return cached
    const first = session.events.find((event) => event.type === 'assistant/message')
    // 首个 assistant 消息尚未落库时不要缓存 false，等待下一轮再查。
    if (first === undefined) return false
    const content = first.data?.message?.content ?? []
    const reasoning = content.find((block) => block.type === 'reasoning')
    const confirmed = reasoning !== undefined && matchesAnchorWord(reasoning.text, anchorWord)
    anchorScanned.set(session.id, confirmed)
    return confirmed
  }

  const assistantRounds = (agent) =>
    agent.session.events.filter((event) => event.type === 'assistant/message').length

  return ({ agent }) => {
    if (promptText === undefined) return null
    const session = agent.session
    const confirmed = isAnchorConfirmed(agent)
    if (!confirmed && assistantRounds(agent) <= 1) return null
    return {
      text: promptText,
      source: {
        kind: 'plugin',
        plugin: config.id,
        form: 'notice',
        summary: confirmed
          ? `prompt-tool 提示词（「${anchorWord}」锚定确认后注入）`
          : `prompt-tool 提示词（「${anchorWord}」未确认，兜底注入）`,
      },
    }
  }
}

/** instruction-hint：晋升后一次性提示指令文件存在（agents-instruction.txt 优先）。 */
function createInstructionHintResolver() {
  const agentsInstructionText = readAgentsInstructionText()
  return async ({ ctx, agent, session }) => {
    const id = `instruction-hint-${session.id}`
    if (agentsInstructionText.length > 0) {
      return {
        id,
        text: agentsInstructionText,
        source: { kind: 'instruction-hint', form: 'hint' },
      }
    }
    const fs = ctx.get('fs')
    if (fs === undefined) return null
    const cwd = session.header?.cwd ?? process.cwd()
    const projectFiles = []
    const root = await findProjectRoot(fs, cwd, agent.signal)
    projectFiles.push(...await presentInDir(fs, root, PROJECT_CANDIDATES, agent.signal))
    const userGlobalFiles = []
    try {
      const dshHome = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : undefined)
      if (dshHome !== undefined) {
        userGlobalFiles.push(...await presentInDir(fs, dshHome, [USER_GLOBAL_CANDIDATE], agent.signal))
      }
    } catch {
      // Unreadable home probe — ignore.
    }
    const sections = []
    if (projectFiles.length > 0) {
      sections.push(`Workspace instruction files exist: ${projectFiles.join(', ')} (project root: ${root}).`)
    }
    if (userGlobalFiles.length > 0) {
      sections.push(`A user-global instruction file exists: ${USER_GLOBAL_CANDIDATE}.`)
    }
    if (sections.length === 0) return null
    return {
      id,
      text: [
        ...sections,
        'Do NOT assume their content. When a task touches this workspace, read the relevant instruction files first and follow them.',
      ].join(' '),
      source: { kind: 'instruction-hint', form: 'hint' },
    }
  }
}

/**
 * env-facts：机器事实动态填充器。
 * params.envKeys 逗号分隔环境变量白名单，默认 DSH_HOME,DSH_WORKSPACE；
 * CWD 特殊映射到 session.header.cwd ?? process.cwd()。
 * 返回 facts 变量表与默认文本；用户可用 text 模板 + {{变量}} 完全自定义输出。
 */
function createEnvFactsResolver(config) {
  const keys = parseToolNames(typeof config.params?.envKeys === 'string' && config.params.envKeys.length > 0
    ? config.params.envKeys
    : 'DSH_HOME,DSH_WORKSPACE')
  return ({ agent }) => {
    const session = agent?.session
    const cwd = session?.header?.cwd ?? process.cwd()
    const builtinHome = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : '')
    const facts = {}
    for (const key of keys) {
      let value
      if (key === 'CWD' || key === 'WORKSPACE') value = cwd
      else if (key === 'DSH_HOME') value = builtinHome
      else value = process.env[key]
      if (typeof value === 'string' && value.length > 0) facts[key] = value
    }
    facts.WORKSPACE = process.env.DSH_WORKSPACE ?? cwd
    facts.CWD = cwd
    const defaultText = ['Environment facts:', ...Object.entries(facts).map(([key, value]) => `- ${key}=${value}`)].join('\n')
    return { text: defaultText, variables: facts }
  }
}


/**
 * skill-catalog：技能目录动态填充器。
 * 数据来自宿主 skills 服务（聚合各 provider；本插件 provider 的 list 已按
 * skillSwitches 过滤，因此目录天然只含已启用技能）。服务缺失或列表失败时
 * 跳过本配置并告警一次，绝不伤及会话。
 * params：
 *   limit        输出数量上限，默认 20；0 = 全部（完整目录会扰动轨迹，谨慎使用）
 *   fields       输出字段子集（name/description/whenToUse），默认 name,description
 *   providers    provider 过滤（逗号分隔）；空 = 全部 provider
 *   emptyBehavior skip=无技能时不注入（默认）| text=注入 emptyText
 *   emptyText    emptyBehavior=text 时的输出文本
 * 返回 variables：SKILL_COUNT / SKILL_NAMES / SKILLS_TEXT（预格式化列表），
 * 用户可用 text 模板 + {{变量}} 完全自定义输出。
 */
function createSkillCatalogResolver(config) {
  const limit = Number.isSafeInteger(config.params?.limit) && config.params.limit >= 0
    ? config.params.limit
    : 20
  const fields = parseToolNames(typeof config.params?.fields === 'string' ? config.params.fields : 'name,description')
    .filter((field) => ['name', 'description', 'whenToUse'].includes(field))
  const providers = parseToolNames(config.params?.providers)
  const emptyBehavior = config.params?.emptyBehavior === 'text' ? 'text' : 'skip'
  const emptyText = typeof config.params?.emptyText === 'string' && config.params.emptyText.length > 0
    ? config.params.emptyText
    : '当前没有可用技能。'
  let warned = false
  const warnOnceLocal = (ctx, message) => {
    if (warned) return
    warned = true
    try {
      ctx?.logger?.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  return async ({ ctx, agent, session }) => {
    try {
      const skills = getService(ctx, 'skills')
      if (skills === undefined || typeof skills.list !== 'function') {
        warnOnceLocal(ctx, `${name}: skills service unavailable — skill-catalog config ${config.id} skipped`)
        return null
      }
      const all = await skills.list({
        scope: agent ?? ctx,
        ...(session?.header?.cwd !== undefined ? { cwd: session.header.cwd } : {}),
        ...(agent?.signal !== undefined ? { signal: agent.signal } : {}),
      })
      const visible = Array.isArray(all) ? all : []
      const scoped = providers.length === 0
        ? visible
        : visible.filter((skill) => providers.includes(skill?.provider))
      const total = scoped.length
      if (total === 0) {
        if (emptyBehavior !== 'text') return null
        return { text: emptyText, variables: { SKILL_COUNT: '0', SKILL_NAMES: '', SKILLS_TEXT: '' } }
      }

      const nameOf = (skill) => {
        const value = skill?.name
        if (typeof value === 'string' && value.length > 0) return value
        if (typeof skill?.locator === 'string' && skill.locator.length > 0) return skill.locator
        return String(skill?.id ?? '(unnamed)')
      }
      const firstLine = (value) => typeof value === 'string' ? value.split('\n')[0].trim() : ''
      const rows = (limit === 0 ? scoped : scoped.slice(0, limit)).map((skill) => {
        const parts = []
        if (fields.includes('name')) parts.push(nameOf(skill))
        if (fields.includes('description')) {
          const description = firstLine(skill?.description)
          if (description.length > 0) parts.push(description)
        }
        if (fields.includes('whenToUse')) {
          const whenToUse = firstLine(skill?.whenToUse)
          if (whenToUse.length > 0) parts.push(`适用：${whenToUse}`)
        }
        return parts.length === 0 ? '' : `- ${parts.join(': ')}`
      }).filter((line) => line.length > 0)
      const skillsText = rows.join('\n')
      const skillsNames = scoped.map((skill) => nameOf(skill)).join(', ')
      return {
        text: `Available skills (${total}):\n${skillsText}`,
        variables: {
          SKILL_COUNT: String(total),
          SKILL_NAMES: skillsNames,
          SKILLS_TEXT: skillsText,
        },
      }
    } catch (error) {
      warnOnceLocal(ctx, `${name}: skill-catalog config ${config.id} failed, skipping: ${String((error && error.message) || error)}`)
      return null
    }
  }
}


/** 动态填充器：strategy=placeholder 时按 fill 键在注入点填充内容。 */
const FILLERS = {
  'instruction-hint': () => createInstructionHintResolver(),
  'env-facts': (config) => createEnvFactsResolver(config),
  // skill-catalog：技能目录动态填充器（数据来自宿主 skills 服务，服务缺失时降级跳过）。
  'skill-catalog': (config) => createSkillCatalogResolver(config),
}

function createPlaceholderResolver(config) {
  const make = FILLERS[config.fill]
  if (make === undefined) {
    throw new TypeError(`${name}: unknown config fill ${JSON.stringify(config.fill)}`)
  }
  return make(config)
}

/** 为归一化后的提示词配置绑定策略 resolve（策略状态随提示词配置对象，不随 apply）。 */
function bindResolver(config) {
  switch (config.strategy) {
    case 'placeholder': return createPlaceholderResolver(config)
    case 'anchor-auto': return createAnchorAutoResolver(config)
    case 'guide-auto': return createGuideAutoResolver(config)
    case 'anchor-fallback': return createAnchorFallbackResolver(config)
    case 'we-fallback': return createAnchorFallbackResolver(config) // 兼容别名
    case 'instruction-hint': return createInstructionHintResolver()
    case 'static': {
      const text = config.text
      const texts = config.texts
      const patch = config.templatePatch ?? {}
      return () => {
        if (texts.length > 0) return { ...patch, content: texts.map((item) => ({ type: 'text', text: item })) }
        return text.length > 0 ? { ...patch, text } : null
      }
    }
    default:
      throw new TypeError(`${name}: unknown config strategy ${JSON.stringify(config.strategy)}`)
  }
}

const KNOWN_STRATEGIES = new Set(['static', 'anchor-auto', 'guide-auto', 'anchor-fallback', 'we-fallback', 'instruction-hint', 'placeholder'])
const KNOWN_SLOT_KINDS = new Set(['ordered', 'anchor'])
/**
 * 官方注入通道（v0.1.0-rc.7 源码面）。当前引擎只接通 pre-step；
 * 其余 layer 声明有效，执行通道接入前该提示词配置跳过（不注入、不报错）。
 */
const KNOWN_LAYERS = new Set(['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline'])
const KNOWN_POSITIONS = new Set(['after-user', 'before-all', 'after-all'])
const KNOWN_DEDUPES = new Set(['session', 'batch', 'none'])
const KNOWN_PROMOTIONS = new Set(['none', 'main', 'include-subagents'])
const KNOWN_SUBAGENT_MODES = new Set(['none', 'inherit', 'only'])
const KNOWN_MERGE_MODES = new Set(['separate', 'merged'])
const KNOWN_MODEL_SCOPES = new Set(['all', 'pro', 'flash'])
const KNOWN_ROLES = new Set(['user', 'assistant'])
const KNOWN_FILLS = new Set(['instruction-hint', 'env-facts', 'skill-catalog'])

/** 从 YAML 提示词配置描述构造运行时提示词配置。配置错误必须在挂载时暴露（fail loud）。 */
export function createPromptConfigs(specs) {
  if (specs === undefined) return []
  if (!Array.isArray(specs)) throw new TypeError(`${name}: config.configs must be an array`)
  const configs = specs.map((spec, index) => {
    const label = `configs[${index}]`
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new TypeError(`${name}: ${label} must be an object`)
    }
    if (typeof spec.id !== 'string' || spec.id.length === 0) {
      throw new TypeError(`${name}: ${label}.id must be a non-empty string`)
    }
    const strategy = spec.strategy ?? 'static'
    if (!KNOWN_STRATEGIES.has(strategy)) {
      throw new TypeError(`${name}: ${label} unknown strategy ${JSON.stringify(strategy)}`)
    }
    const configKind = spec.configKind ?? 'ordered'
    if (!KNOWN_SLOT_KINDS.has(configKind)) {
      throw new TypeError(`${name}: ${label} unknown configKind ${JSON.stringify(configKind)}`)
    }
    const layer = spec.layer ?? 'pre-step'
    if (!KNOWN_LAYERS.has(layer)) {
      throw new TypeError(`${name}: ${label} unknown layer ${JSON.stringify(layer)} — known layers: ${[...KNOWN_LAYERS].sort().join(', ')}`)
    }
    const position = spec.position ?? 'after-user'
    if (!KNOWN_POSITIONS.has(position)) {
      throw new TypeError(`${name}: ${label} unknown position ${JSON.stringify(position)}`)
    }
    const dedupe = spec.dedupe ?? 'none'
    if (!KNOWN_DEDUPES.has(dedupe)) {
      throw new TypeError(`${name}: ${label} unknown dedupe ${JSON.stringify(dedupe)}`)
    }
    const promotion = spec.promotion ?? 'none'
    if (!KNOWN_PROMOTIONS.has(promotion)) {
      throw new TypeError(`${name}: ${label} unknown promotion ${JSON.stringify(promotion)}`)
    }
    const subagents = spec.subagents ?? 'none'
    if (!KNOWN_SUBAGENT_MODES.has(subagents)) {
      throw new TypeError(`${name}: ${label} unknown subagents ${JSON.stringify(subagents)}`)
    }
    const modelScope = spec.modelScope ?? 'all'
    if (!KNOWN_MODEL_SCOPES.has(modelScope)) {
      throw new TypeError(`${name}: ${label} unknown modelScope ${JSON.stringify(modelScope)}`)
    }
    const role = spec.role ?? 'user'
    if (!KNOWN_ROLES.has(role)) {
      throw new TypeError(`${name}: ${label} unknown role ${JSON.stringify(role)}`)
    }
    const identity = spec.identity ?? { field: 'plugin', value: spec.id }
    if (identity === null || typeof identity !== 'object' || Array.isArray(identity)
      || !['plugin', 'kind'].includes(identity.field) || typeof identity.value !== 'string' || identity.value.length === 0) {
      throw new TypeError(`${name}: ${label}.identity must be { field: 'plugin'|'kind', value: string }`)
    }
    const order = spec.order ?? 0
    if (typeof order !== 'number' || !Number.isFinite(order)) {
      throw new TypeError(`${name}: ${label}.order must be a finite number`)
    }
    if (spec.group !== undefined && (typeof spec.group !== 'string' || spec.group.length === 0)) {
      throw new TypeError(`${name}: ${label}.group must be a non-empty string when present`)
    }
    if (spec.exclusive !== undefined && typeof spec.exclusive !== 'boolean') {
      throw new TypeError(`${name}: ${label}.exclusive must be a boolean when present`)
    }
    if (spec.name !== undefined && (typeof spec.name !== 'string' || spec.name.length === 0)) {
      throw new TypeError(`${name}: ${label}.name must be a non-empty string when present`)
    }
    if (spec.variables !== undefined && (spec.variables === null || typeof spec.variables !== 'object' || Array.isArray(spec.variables))) {
      throw new TypeError(`${name}: ${label}.variables must be an object when present`)
    }
    if (spec.texts !== undefined && (!Array.isArray(spec.texts) || spec.texts.some((item) => typeof item !== 'string'))) {
      throw new TypeError(`${name}: ${label}.texts must be an array of strings when present`)
    }
    if (spec.mergeGroup !== undefined && (typeof spec.mergeGroup !== 'string' || spec.mergeGroup.length === 0)) {
      throw new TypeError(`${name}: ${label}.mergeGroup must be a non-empty string when present`)
    }
    const priority = spec.priority ?? 0
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      throw new TypeError(`${name}: ${label}.priority must be a finite number`)
    }
    const mergeMode = spec.mergeMode ?? 'separate'
    if (!KNOWN_MERGE_MODES.has(mergeMode)) {
      throw new TypeError(`${name}: ${label} unknown mergeMode ${JSON.stringify(mergeMode)}`)
    }
    if (strategy === 'placeholder' && layer !== 'pre-step' && layer !== 'runtime-context') {
      throw new TypeError(`${name}: ${label} strategy=placeholder supports layer pre-step or runtime-context only, got ${JSON.stringify(layer)}`)
    }
    let fill
    if (strategy === 'placeholder') {
      fill = typeof spec.fill === 'string' && spec.fill.length > 0 ? spec.fill : undefined
      if (fill === undefined || !KNOWN_FILLS.has(fill)) {
        throw new TypeError(`${name}: ${label} strategy=placeholder requires fill in [${[...KNOWN_FILLS].sort().join(', ')}]`)
      }
    }
    const template = loadTemplate(spec.templateFile)
    const templatePatch = template !== null && typeof template === 'object'
      ? { id: template.id, role: template.role, content: template.content, source: template.source }
      : undefined
    const config = {
      id: spec.id,
      name: typeof spec.name === 'string' ? spec.name : spec.id,
      enabled: spec.enabled !== false,
      strategy,
      configKind,
      layer,
      group: typeof spec.group === 'string' ? spec.group : undefined,
      exclusive: spec.exclusive === true,
      order,
      role,
      fill,
      position,
      dedupe,
      promotion,
      subagents,
      modelScope,
      sourceKind: typeof spec.sourceKind === 'string' && spec.sourceKind.length > 0 ? spec.sourceKind : spec.id,
      form: typeof spec.form === 'string' ? spec.form : 'notice',
      summary: typeof spec.summary === 'string' ? spec.summary : '',
      identity,
      text: typeof spec.text === 'string' && spec.text.length > 0 ? spec.text : (typeof template?.text === 'string' ? template.text : ''),
      texts: Array.isArray(spec.texts) ? spec.texts.filter((item) => typeof item === 'string' && item.length > 0) : [],
      mergeMode,
      mergeGroup: typeof spec.mergeGroup === 'string' && spec.mergeGroup.length > 0 ? spec.mergeGroup : undefined,
      priority,
      variables: spec.variables !== null && typeof spec.variables === 'object' && !Array.isArray(spec.variables) ? spec.variables : {},
      templatePatch,
      params: spec.params !== null && typeof spec.params === 'object' && !Array.isArray(spec.params) ? spec.params : {},
    }
    config.resolve = bindResolver(config)
    return config
  })
  // 排序契约：anchor 提示词配置保持模块文件相对顺序（固定锚点），ordered 提示词配置按 order
  // 稳定升序排在其后。默认 order=0 时等价于文件顺序。
  return configs
    .map((config, fileOrder) => ({ config, fileOrder }))
    .sort((a, b) => {
      const aAnchor = a.config.configKind === 'anchor' ? 0 : 1
      const bAnchor = b.config.configKind === 'anchor' ? 0 : 1
      if (aAnchor !== bAnchor) return aAnchor - bAnchor
      if (aAnchor === 1 && a.config.order !== b.config.order) return a.config.order - b.config.order
      return a.fileOrder - b.fileOrder
    })
    .map(({ config }) => config)
}

/** 读取可选服务；测试桩 / 极简组合里缺失时返回 undefined，由调用方降级。 */
function getService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** 把服务注册返回的 disposer 挂到 fiber（资源注册契约）。 */
function keepDisposer(ctx, disposer, label) {
  if (typeof disposer !== 'function') return
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => disposer, label)
      return
    }
  } catch {
    // 极简测试桩没有 effect：保持注册随进程，测试自行隔离。
  }
}

/** 逗号分隔的工具名过滤；空 = 全部。 */
function parseToolNames(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

/** 仅做提示词配置级静态变量替换（无 session 上下文的层）。 */
function interpolateStatic(text, variables) {
  return text.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : whole)
}

/** agent/request 与 tools/* 层的作用域过滤。 */
function matchesAgentScope(config, agent) {
  if (agent === undefined) return true
  const delegated = isDelegated(agent.session)
  if (config.subagents === 'none' && delegated) return false
  if (config.subagents === 'only' && !delegated) return false
  return matchesModel(config.modelScope, agent.options?.model)
}

/** 单条文本型配置的完整文本：text 优先，否则 texts 数组按空行拼接。 */
function configText(config) {
  const text = interpolateStatic(config.text, config.variables)
  if (text.length > 0) return text
  return config.texts
    .map((item) => interpolateStatic(item, config.variables))
    .filter((item) => item.length > 0)
    .join('\n\n')
}

/** 文本型层分组：merged 模式按 order+mergeGroup 分组，否则每条独立。 */
function textLayerGroups(configs) {
  const sorted = [...configs].sort((a, b) => (a.order - b.order) || (a.priority - b.priority))
  const groups = []
  const index = new Map()
  for (const config of sorted) {
    const key = config.mergeMode === 'merged' ? `merged:${config.order}:${config.mergeGroup ?? ''}` : undefined
    if (key === undefined) {
      groups.push([config])
      continue
    }
    let at = index.get(key)
    if (at === undefined) {
      at = groups.length
      index.set(key, at)
      groups.push([])
    }
    groups[at].push(config)
  }
  return groups
}

/** system-section：注册静态 system prompt 段（支持官方 {{variable}} 渲染与 merged 拼接）。 */
function wireSystemSections(ctx, configs, warnOnce) {
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
    if (configs.length > 0) warnOnce(`${name}: systemPrompt service unavailable — system-section configs skipped`)
    return
  }
  for (const group of textLayerGroups(configs)) {
    const base = group[0]
    try {
      const text = group.map((config) => configText(config)).filter((item) => item.length > 0).join('\n\n')
      if (text.length === 0) continue
      keepDisposer(ctx, systemPrompt.section({
        name: typeof base.params?.sectionName === 'string' && base.params.sectionName.length > 0 ? base.params.sectionName : (base.mergeGroup ?? base.id),
        order: base.order,
        text,
        ...(base.params?.complete === true ? { complete: true } : {}),
      }), `${name}: section ${base.id}`)
    } catch (error) {
      warnOnce(`${name}: system-section config ${base.id} failed: ${String(error?.message ?? error)}`)
    }
  }
}

/** runtime-context：注册动态运行时上下文（晋升后由 context-gate 差分投影；支持 merged 拼接与 placeholder 函数 provider）。 */
function wireRuntimeContexts(ctx, configs, warnOnce) {
  const systemPrompt = getService(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') {
    if (configs.length > 0) warnOnce(`${name}: systemPrompt service unavailable — runtime-context configs skipped`)
    return
  }
  const staticConfigs = configs.filter((config) => config.strategy !== 'placeholder')
  for (const group of textLayerGroups(staticConfigs)) {
    const base = group[0]
    try {
      const text = group.map((config) => configText(config)).filter((item) => item.length > 0).join('\n\n')
      if (text.length === 0) continue
      keepDisposer(ctx, systemPrompt.context({
        name: typeof base.params?.contextName === 'string' && base.params.contextName.length > 0 ? base.params.contextName : (base.mergeGroup ?? base.id),
        order: base.order,
        text,
      }), `${name}: context ${base.id}`)
    } catch (error) {
      warnOnce(`${name}: runtime-context config ${base.id} failed: ${String(error?.message ?? error)}`)
    }
  }
  // placeholder：官方 context 接受函数 provider，在每次 assembly 时动态填充。
  const placeholders = configs.filter((config) => config.strategy === 'placeholder')
    .sort((a, b) => (a.order - b.order) || (a.priority - b.priority))
  for (const config of placeholders) {
    try {
      const resolver = config.resolve
      keepDisposer(ctx, systemPrompt.context({
        name: typeof config.params?.contextName === 'string' && config.params.contextName.length > 0 ? config.params.contextName : (config.mergeGroup ?? config.id),
        order: config.order,
        text: async (assembly) => {
          const agent = assembly?.agent
          const session = agent?.session
          const resolved = await resolver({ ctx, agent, session, decision: { kind: 'ok', messages: [] }, messages: [] })
          if (resolved === null || resolved === undefined) return ''
          const variables = { ...config.variables, ...(resolved.variables !== null && typeof resolved.variables === 'object' ? resolved.variables : {}) }
          if (config.text.length > 0) return interpolateVariables(config.text, variables, session)
          return typeof resolved.text === 'string' ? interpolateVariables(resolved.text, variables, session) : ''
        },
      }), `${name}: context ${config.id}`)
    } catch (error) {
      warnOnce(`${name}: runtime-context placeholder ${config.id} failed: ${String(error?.message ?? error)}`)
    }
  }
}

/** agent-request：对冻结的 LlmCallConfig 做浅合并 / 整体替换。 */
function wireAgentRequests(ctx, configs, warnOnce) {
  for (const config of configs) {
    ctx.on('agent/request', async (payload, next) => {
      const base = await next()
      try {
        if (!matchesAgentScope(config, payload?.agent)) return base
        const patch = config.params?.patch !== null && typeof config.params?.patch === 'object' && !Array.isArray(config.params.patch)
          ? config.params.patch
          : {}
        if (config.params?.replace === true) return { ...patch }
        return { ...base, ...patch }
      } catch (error) {
        warnOnce(`${name}: agent-request config ${config.id} failed: ${String(error?.message ?? error)}`)
        return base
      }
    })
  }
}

/** 把流替换为提示词配置文本的最小合法 chunk 序列。 */
async function* replacedStream(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
}

/** llm-stream：pass 透传；replace 用提示词配置文本替代整个模型流。 */
function wireLlmStreams(ctx, configs, warnOnce) {
  for (const config of configs) {
    ctx.on('llm/stream', (options, next) => {
      try {
        const mode = config.params?.mode ?? 'pass'
        if (mode === 'replace' && config.text.length > 0 && matchesModel(config.modelScope, options?.model)) {
          return replacedStream(config.text)
        }
        return next()
      } catch (error) {
        warnOnce(`${name}: llm-stream config ${config.id} failed: ${String(error?.message ?? error)}`)
        return next()
      }
    })
  }
}

/** tool-pipeline：pre-execute 判定、execute 包装、post-execute 结果替换/阻断。 */
function wireToolPipelines(ctx, configs, warnOnce) {
  for (const config of configs) {
    const names = parseToolNames(config.params?.toolNames)
    const matchesTool = (exec) => names.length === 0 || names.includes(exec?.name)
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (!matchesTool(exec) || !matchesAgentScope(config, exec?.agent)) return next()
        const decision = config.params?.preDecision ?? 'allow'
        if (decision === 'allow') return next()
        if (decision === 'deny') {
          return { kind: 'deny', reason: String(config.params?.denyReason ?? `${config.name}: denied by prompt config`) }
        }
        if (decision === 'ask') return { kind: 'ask' }
        return next()
      } catch (error) {
        warnOnce(`${name}: tool-pipeline(pre) config ${config.id} failed: ${String(error?.message ?? error)}`)
        return next()
      }
    })
    ctx.on('tools/execute', async (exec, next) => {
      try {
        if (!matchesTool(exec) || !matchesAgentScope(config, exec?.agent)) return next()
        // 透传包装点：未来 timeout/重试参数在此接入。
        return next()
      } catch (error) {
        warnOnce(`${name}: tool-pipeline(execute) config ${config.id} failed: ${String(error?.message ?? error)}`)
        return next()
      }
    })
    ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        if (!matchesTool(exec) || !matchesAgentScope(config, exec?.agent)) return next()
        const action = config.params?.postAction ?? 'accept'
        if (action === 'accept') return next()
        if (action === 'replace' && config.text.length > 0) {
          return { kind: 'accept', content: [{ type: 'text', text: config.text }] }
        }
        if (action === 'block') {
          return { kind: 'block', feedback: [{ type: 'text', text: config.text.length > 0 ? config.text : `${config.name}: blocked by prompt config` }] }
        }
        return next()
      } catch (error) {
        warnOnce(`${name}: tool-pipeline(post) config ${config.id} failed: ${String(error?.message ?? error)}`)
        return next()
      }
    })
  }
}

/** 把非 pre-step 提示词配置接入其声明的官方层级通道。 */
function wireLayers(ctx, configs, warnOnce) {
  wireSystemSections(ctx, configs.filter((config) => config.layer === 'system-section'), warnOnce)
  wireRuntimeContexts(ctx, configs.filter((config) => config.layer === 'runtime-context'), warnOnce)
  wireAgentRequests(ctx, configs.filter((config) => config.layer === 'agent-request'), warnOnce)
  wireLlmStreams(ctx, configs.filter((config) => config.layer === 'llm-stream'), warnOnce)
  wireToolPipelines(ctx, configs.filter((config) => config.layer === 'tool-pipeline'), warnOnce)
}

/**
 * 把一组运行时提示词配置装配为注入执行器。
 * @param prepend 是否以 prepend 注册 pre-step（合并行恒 true；单条提示词配置兼容层由参数决定）。
 */
export function applyPromptConfigs(ctx, configs, options = {}) {
  const list = configs.filter((config) => config !== undefined && config !== null)
  if (list.length === 0) return
  // 互斥组：同一 group 且 exclusive=true 时，只保留排序后第一个 enabled 提示词配置。
  const claimedGroups = new Set()
  const effectiveList = list.filter((config) => {
    if (config.enabled === false) return false
    if (config.group !== undefined && config.exclusive === true) {
      if (claimedGroups.has(config.group)) return false
      claimedGroups.add(config.group)
    }
    return true
  })
  const main = createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: false })
  const withSubagents = createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: true })
  ctx.on('session/event', (session, event) => {
    main.observe(session, event)
    withSubagents.observe(session, event)
  })

  /** 每提示词配置每会话的进程内快路径；真相在持久事件流。 */
  const injectedMemo = new Map()
  const configMemo = (config) => {
    let memo = injectedMemo.get(config.id)
    if (memo === undefined) {
      memo = new Set()
      injectedMemo.set(config.id, memo)
    }
    return memo
  }

  const warnOnce = createWarnOnce(ctx, name)
  const prepend = options.prepend === true || list.some((config) => config.prepend === true)

  // 非 pre-step 提示词配置接入各自声明的官方层级通道（system-section /
  // runtime-context / agent-request / llm-stream / tool-pipeline）。
  wireLayers(ctx, effectiveList.filter((config) => config.layer !== 'pre-step'), warnOnce)

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    try {
      if (decision.kind === 'reject') return decision
      if (agent === undefined) return decision
      const session = agent.session
      if (session === undefined) return decision

      const messages = Array.isArray(decision.messages) ? [...decision.messages] : []
      let changed = false

      const due = []
      for (const config of effectiveList) {
        try {
          if (config.layer !== 'pre-step') continue
          const delegated = isDelegated(session)
          if (config.subagents === 'none' && delegated) continue
          if (config.subagents === 'only' && !delegated) continue
          if (!matchesModel(config.modelScope, agent.options?.model)) continue
          if (config.promotion === 'main' && !main.status(agent).promoted) continue
          if (config.promotion === 'include-subagents' && !withSubagents.status(agent).promoted) continue

          const memo = configMemo(config)
          if (config.dedupe === 'session') {
            if (memo.has(session.id) || hasInjected(config, session)) {
              memo.add(session.id)
              continue
            }
          } else if (config.dedupe === 'batch' && hasInBatch(config, messages)) {
            continue
          }

          const resolved = await config.resolve({ ctx, agent, session, decision, messages })
          if (resolved === null || resolved === undefined) continue
          const patched = { ...resolved }
          const mergedVars = { ...config.variables, ...(resolved.variables !== null && typeof resolved.variables === 'object' ? resolved.variables : {}) }
          if (config.strategy === 'placeholder' && config.text.length > 0) {
            // 高度自定义：filler 提供变量，用户用 text 模板决定输出。
            patched.text = interpolateVariables(config.text, mergedVars, session)
          } else if (typeof patched.text === 'string') {
            // 提示词配置级模板变量 + filler 变量 + 内置环境变量插值。
            patched.text = interpolateVariables(patched.text, mergedVars, session)
          }
          if (config.texts.length > 0) {
            const blocks = config.texts
              .map((item) => interpolateVariables(item, mergedVars, session))
              .filter((item) => item.length > 0)
              .map((item) => ({ type: 'text', text: item }))
            if (blocks.length > 0) patched.content = blocks
          }
          const hasText = typeof patched.text === 'string' && patched.text.length > 0
          const hasContent = Array.isArray(patched.content) && patched.content.length > 0
          if (!hasText && !hasContent) continue
          due.push({ config, resolved: patched, priority: config.priority })
        } catch (error) {
          // 单个提示词配置失败不得伤及会话：跳过该提示词配置，只告警一次。
          warnOnce(`${name}: config ${String(config?.id ?? '<unknown>')} failed, skipping: ${String((error && error.message) || error)}`)
        }
      }

      // priority 升序（同值保持声明顺序）：决定拼接顺序与同位置插入顺序。
      due.sort((a, b) => a.priority - b.priority)

      // 同一 mergeGroup 的多条提示词配置在首条配置的位置合并为一条消息；
      // 文本按内容块拼接，source 身份改用 mergeGroup 以保持持久幂等。
      const orderedGroups = []
      const groupIndex = new Map()
      for (const entry of due) {
        const group = entry.config.mergeMode === 'merged'
          ? `${entry.config.position}:${entry.config.mergeGroup ?? ''}`
          : undefined
        if (group === undefined) {
          orderedGroups.push([entry])
          continue
        }
        let index = groupIndex.get(group)
        if (index === undefined) {
          index = orderedGroups.length
          groupIndex.set(group, index)
          orderedGroups.push([])
        }
        orderedGroups[index].push(entry)
      }

      const planned = []
      for (const group of orderedGroups) {
        const base = group[0]
        const message = buildMessage(base.config, base.resolved)
        if (group.length > 1) {
          message.content = group.flatMap((entry) => {
            if (Array.isArray(entry.resolved.content)) return entry.resolved.content
            return typeof entry.resolved.text === 'string' && entry.resolved.text.length > 0
              ? [{ type: 'text', text: entry.resolved.text }]
              : []
          })
          if (message.source !== null && typeof message.source === 'object') {
            if (base.config.identity.field === 'kind') message.source = { ...message.source, kind: mergedIdentity(base.config) }
            else message.source = { ...message.source, plugin: mergedIdentity(base.config) }
          }
          if (new Set(group.map((entry) => entry.config.position)).size > 1) {
            warnOnce(`${name}: mergeGroup ${String(base.config.mergeGroup)} mixes positions — using ${String(base.config.position)} from the first config`)
          }
        }
        planned.push({ position: base.config.position, message, group })
      }

      // 同位置批量插入：planned 已按 priority 升序，多元素 splice/unshift/push 保持该顺序。
      const markGroup = (group) => {
        for (const entry of group) {
          if (entry.config.dedupe === 'session') configMemo(entry.config).add(session.id)
        }
      }
      const beforeAll = planned.filter((item) => item.position === 'before-all')
      const afterUser = planned.filter((item) => item.position !== 'before-all' && item.position !== 'after-all')
      const afterAll = planned.filter((item) => item.position === 'after-all')
      if (beforeAll.length > 0) {
        messages.unshift(...beforeAll.map((item) => item.message))
        for (const item of beforeAll) markGroup(item.group)
        changed = true
      }
      const userIndex = messages.findIndex((item) => item?.source?.kind === 'user')
      if (afterUser.length > 0 && userIndex >= 0) {
        messages.splice(userIndex + 1, 0, ...afterUser.map((item) => item.message))
        for (const item of afterUser) markGroup(item.group)
        changed = true
      }
      if (afterAll.length > 0) {
        messages.push(...afterAll.map((item) => item.message))
        for (const item of afterAll) markGroup(item.group)
        changed = true
      }

      return changed ? { ...decision, messages } : decision
    } catch (error) {
      warnOnce(`${name}: prompt config failed, skipping: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend })
}

/**
 * 引擎插件入口：config.configsDir 为提示词配置模块目录（相对本文件的 URL），
 * 引擎扫描目录内每个 *.yml / *.yaml / *.json 并装配为提示词配置。
 * agent.cordis.yml 只保留本行与 configsDir 参数，提示词配置内容全部在模块文件夹中。
 */
export function apply(ctx, config) {
  const dirName = typeof config?.configsDir === 'string' && config.configsDir.length > 0
    ? config.configsDir
    : './prompt-configs'
  const dirUrl = new URL(dirName.endsWith('/') ? dirName : `${dirName}/`, import.meta.url)
  applyPromptConfigs(ctx, createPromptConfigs(loadPromptConfigFiles(dirUrl)), { prepend: true })
}

/**
 * instruction-hint — 通用内置指令文件提示引擎。
 *
 * 本模块同时是「可 import 的纯函数库」与「可被组合源挂载的 plugin」：
 * - prompt-config 的 strategy=instruction-hint / placeholder fill=instruction-hint
 *   直接使用本模块的探测与消息构造；
 * - plugin 形态（见文件末尾 apply）：**挂本行 = 开启**「晋升后把
 *   agent-instructions 全文替换为一次性 hint，后续全文消息丢弃」的转换。
 *
 * 只提示参考文件存在，不把文件正文塞进每轮上下文。文件探测失败时返回空结果，
 * 不阻断会话；独立生成的 hint 使用随机 id，替换既有消息时保留其 id。
 *
 * PLUGIN CONFIG（挂载期校验；声明即校验，未声明 `enabled` = 关闭）：
 * - `enabled`: boolean，缺省 false（组合源须显式写 true）。
 * - `promoteOn`: 'either'（缺省）| 'tool-call' | 'assistant-message'。
 * - `includeSubagents`: boolean，缺省 false（子代理首次请求即视为已晋升）。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createEpochPromotion } from './compaction-epoch.mjs'
import { booleanOption, createWarnOnce, parsePromoteOn, validateConfig } from './shared.mjs'

export const name = 'instruction-hint'

/** 无 inject：监听器只在使用时触碰 ctx 服务（同 tool-bootstrap / context-gate 纪律）。 */
export const inject = []

/** 项目目录链中按优先级探测的指令文件名。 */
export const PROJECT_INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
export const USER_GLOBAL_INSTRUCTION_CANDIDATE = 'AGENTS.md'
const REFERENCE_HINT_SUFFIX = "They are reference documents about the user's environment and workspace conventions, not task instructions. Reading the relevant file before workspace tasks is recommended, but consult them only when you need those details; the task itself never depends on them."

/** Join one path segment onto a directory (platform-agnostic string join). */
export function joinPath(dir, segment) {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + segment
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir + sep + segment
}

/** Parent of an absolute Windows or POSIX path. */
export function parentPath(path) {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx <= 0) return path
  const parent = path.slice(0, idx)
  return parent.length === 0 ? path : parent
}

/** Find the project root: first ancestor containing any root marker. */
export async function findProjectRoot(fs, cwd, signal) {
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

/** List instruction files present in one directory. */
export async function presentInDir(fs, dir, candidates, signal) {
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

/**
 * 探测 cwd 到项目根的完整目录链，以及 DSH_HOME 下的用户级 AGENTS.md。
 * home 未传时使用当前宿主的 DSH_HOME/USERPROFILE 推导值。
 */
export async function collectInstructionFiles(fs, cwd, signal, home) {
  const root = await findProjectRoot(fs, cwd, signal)
  const projectFiles = []
  let probed = cwd
  for (;;) {
    for (const candidate of await presentInDir(fs, probed, PROJECT_INSTRUCTION_CANDIDATES, signal)) {
      projectFiles.push(probed === root ? candidate : joinPath(probed, candidate))
    }
    if (probed === root) break
    const parent = parentPath(probed)
    if (parent === probed || parent.length === 0) break
    probed = parent
  }

  const userGlobalFiles = []
  const dshHome = home ?? process.env.DSH_HOME
    ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : undefined)
  if (dshHome !== undefined) {
    userGlobalFiles.push(...await presentInDir(fs, dshHome, [USER_GLOBAL_INSTRUCTION_CANDIDATE], signal))
  }
  return { root, projectFiles, userGlobalFiles, userGlobalHome: dshHome }
}

/**
 * 将探测结果格式化为建议式 hint；无文件时返回空字符串。
 * scope 限定只报告某一来源：all（默认）/ global（$DSH_HOME/AGENTS.md）/ project（cwd→项目根链）。
 */
export function buildInstructionHintText({ root, projectFiles = [], userGlobalFiles = [], userGlobalHome } = {}, scope = 'all') {
  const sections = []
  if (scope !== 'global' && projectFiles.length > 0) {
    sections.push(`Reference documents exist: ${projectFiles.join(', ')} (project root: ${root}).`)
  }
  if (scope !== 'project' && userGlobalFiles.length > 0) {
    const paths = typeof userGlobalHome === 'string' && userGlobalHome.length > 0
      ? userGlobalFiles.map((name) => joinPath(userGlobalHome, name))
      : userGlobalFiles
    sections.push(`A user reference document exists: ${paths.join(', ')}.`)
  }
  if (sections.length === 0) return ''
  sections.push(REFERENCE_HINT_SUFFIX)
  return sections.join(' ')
}

const HINT_SCOPES = new Set(['all', 'global', 'project'])

function hintScope(value) {
  return typeof value === 'string' && HINT_SCOPES.has(value) ? value : 'all'
}

/**
 * prompt-config strategy=instruction-hint 的 resolver。
 * params.text（自定义提示）优先；params.file（文件卡绑定的单个指令文件）次之——
 * 运行时读该文件正文并加 `Instructions from:` 头注入；最后按 params.scope 探测来源
 * （all / global / project）只发「文件存在」提示。
 * 文件缺失、不可读或空内容时返回 null，不注入任何消息。
 */
export function createInstructionHintResolver(config = {}) {
  const customText = typeof config?.params?.text === 'string' && config.params.text.trim().length > 0
    ? config.params.text.trim()
    : ''
  const scope = hintScope(config?.params?.scope)
  const file = typeof config?.params?.file === 'string' && config.params.file.trim().length > 0
    ? config.params.file.trim()
    : ''
  const fileLabel = typeof config?.params?.displayPath === 'string' && config.params.displayPath.trim().length > 0
    ? config.params.displayPath.trim()
    : file
  /** 文件即真相：每次注入都重读绑定文件，外部编辑立即生效。 */
  const readBoundFile = () => {
    try {
      return readFileSync(file, 'utf8').trim()
    } catch {
      return ''
    }
  }

  return async ({ ctx, agent, session }) => {
    const id = `instruction-hint-${session.id}-${randomUUID()}`
    if (customText.length > 0) {
      return { id, text: customText, source: { kind: 'instruction-hint', form: 'hint' } }
    }
    if (file.length > 0) {
      const content = readBoundFile()
      return content.length > 0
        ? { id, text: `Instructions from: ${fileLabel}\n\n${content}`, source: { kind: 'instruction-file', form: 'instructions' } }
        : null
    }
    const fs = ctx.get('fs')
    if (fs === undefined) return null
    const cwd = session.header?.cwd ?? process.cwd()
    const found = await collectInstructionFiles(fs, cwd, agent.signal)
    const text = buildInstructionHintText(found, scope)
    return text.length > 0
      ? { id, text, source: { kind: 'instruction-hint', form: 'hint' } }
      : null
  }
}

const INSTRUCTION_FROM_RE = /(?:^|\n) *(?:Additional |Updated )?Instructions from: ([^\n]+)/g

/** 从 agent-instructions 注入消息提取参考文件路径。 */
export function extractInstructionPaths(message) {
  const paths = []
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    for (const match of block.text.matchAll(INSTRUCTION_FROM_RE)) {
      const path = match[1].trim()
      if (path !== '' && !paths.includes(path)) paths.push(path)
    }
  }
  return paths
}

/** 构造一次性非命令式 hint 消息；替换已有消息时保留其 id。 */
export function buildInstructionHint(original, paths, sourceName = 'instruction-hint') {
  return {
    id: typeof original?.id === 'string' && original.id !== '' ? original.id : `instruction-hint-${randomUUID()}`,
    role: 'user',
    content: [{
      type: 'text',
      text: '<system-reminder>\n'
        + `Reference documents exist: ${paths.join(', ')}. ${REFERENCE_HINT_SUFFIX}`
        + '\n</system-reminder>',
    }],
    source: { kind: 'instruction-hint', form: 'hint', plugin: sourceName },
  }
}

/** 将 agent-instructions 全文替换为一次性 hint，后续全文消息丢弃。 */
export function instructionHintMessages(messages, state, sourceName = 'instruction-hint') {
  const kept = []
  for (const message of messages) {
    if (message?.source?.kind !== 'agent-instructions') {
      kept.push(message)
      continue
    }
    if (state.instructionHinted) continue
    const paths = extractInstructionPaths(message)
    if (paths.length === 0) {
      kept.push(message)
      continue
    }
    state.instructionHinted = true
    kept.push(buildInstructionHint(message, paths, sourceName))
  }
  return kept
}

// ── plugin 形态 ─────────────────────────────────────────────────────────────

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['enabled', 'promoteOn', 'includeSubagents'])

/** The visible surface, not the append-only log, owns hint lifetime. */
function hasVisibleInstructionHint(session) {
  const messages = session?.deriveMessages?.()
  return Array.isArray(messages) && messages.some((message) => message?.source?.kind === 'instruction-hint')
}

/**
 * 注册晋升后的指令正文转换。
 *
 * `prepend: true` + 组合首选行：waterfall after-next 变换按注册逆序生效，本转换因此
 * 是最外层——后注册的注入无法绕过它。`promotion.status(agent)` 兼作冷扫入口（resume /
 * reload 后由 durable 事件流重建相位）。声明即校验：非法配置在挂载期暴露，未声明
 * `enabled` 时同样报错。
 */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  const promoteEvents = parsePromoteOn(name, source.promoteOn)
  const includeSubagents = booleanOption(name, source.includeSubagents, 'includeSubagents', false)
  // 开关语义：未声明 = 关闭（组合源为本模块显式写 enabled: true）。
  const enabled = booleanOption(name, source.enabled, 'enabled', false)
  if (!enabled) return

  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })
  const warnOnce = createWarnOnce(ctx, name)
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (!promotion.status(agent).promoted) return decision
      if (!Array.isArray(decision.messages)) return decision
      if (agent?.session === undefined) return decision
      // 1 换 1 的转换不能按长度判断（长度相同仍可能已转换），
      // instructionHintMessages 本身保留非目标消息，直接采用结果。
      const hintState = { instructionHinted: hasVisibleInstructionHint(agent.session) }
      return { ...decision, messages: instructionHintMessages(decision.messages, hintState, name) }
    } catch (error) {
      // 转换失败不阻断会话：保留原消息。
      warnOnce(`${name}: instruction hint conversion failed, keeping messages: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}

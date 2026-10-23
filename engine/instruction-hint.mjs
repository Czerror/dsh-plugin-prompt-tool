/**
 * instruction-hint — 通用内置指令文件提示引擎（可挂载的行 + 消息构造）。
 *
 * 探测（候选清单、项目根、目录链）归 engine/instruction-files.mjs，本模块只消费它的
 * 异步执行器。两个入口：
 * - prompt-config 的 strategy=placeholder + fill=instruction-hint
 *   直接使用本模块的消息构造与 instruction-files 的探测结果；
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
 * - `messageTemplate` / `suffixTemplate`: 显式转换模板；正文模板为空时不注册转换。
 * - `projectTemplate` / `globalTemplate`: 显式文件探测提示模板，缺省均为空。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createEpochPromotion } from './compaction-epoch.mjs'
import {
  ancestorDirs,
  collectInstructionFiles,
  ENGINE_PROJECT_ROOT_MARKERS,
  PROJECT_INSTRUCTION_CANDIDATES,
  USER_GLOBAL_INSTRUCTION_FILE,
} from './instruction-files.mjs'
import { interpolateStatic } from './interpolate.mjs'
import { machinePaths } from './machine-paths.mjs'
import { resolveRealWithin } from './path-safety.mjs'
import { booleanOption, createWarnOnce, getService, parsePromoteOn, validateConfig } from './shared.mjs'
import { PRE_STEP_COORDINATOR_SERVICE } from './service-names.mjs'
import { instructionBlocks } from './instruction-blocks.mjs'

export const name = 'instruction-hint'

/** 无 inject：监听器只在使用时触碰 ctx 服务（同 tool-bootstrap / context-gate 纪律）。 */
export const inject = []

const templateOf = (templates, key) => typeof templates?.[key] === 'string' ? templates[key] : ''

/**
 * 用显式模板格式化探测结果；无文件或无正文模板时返回空字符串。
 * scope 限定只报告某一来源：all（默认）/ global（$DSH_HOME/AGENTS.md）/ project（cwd→项目根链）。
 */
export function buildInstructionHintText({ root, projectFiles = [], userGlobalFiles = [], userGlobalHome } = {}, scope = 'all', templates = {}) {
  const sections = []
  if (scope !== 'global' && projectFiles.length > 0) {
    const text = interpolateStatic(templateOf(templates, 'projectTemplate'), { FILES: projectFiles.join(', '), ROOT: root ?? '' }, undefined, 'projectTemplate')
    if (text.trim().length > 0) sections.push(text)
  }
  if (scope !== 'project' && userGlobalFiles.length > 0) {
    const paths = typeof userGlobalHome === 'string' && userGlobalHome.length > 0
      ? userGlobalFiles.map((name) => join(userGlobalHome, name))
      : userGlobalFiles
    const text = interpolateStatic(templateOf(templates, 'globalTemplate'), { FILES: paths.join(', '), ROOT: root ?? '' }, undefined, 'globalTemplate')
    if (text.trim().length > 0) sections.push(text)
  }
  if (sections.length === 0) return ''
  const suffix = templateOf(templates, 'suffixTemplate')
  if (suffix.trim().length > 0) sections.push(suffix)
  return sections.join(' ')
}

const HINT_SCOPES = new Set(['all', 'global', 'project'])

function hintScope(value) {
  return typeof value === 'string' && HINT_SCOPES.has(value) ? value : 'all'
}

/** params.file 的白名单：与探测清单同源，只允许指令文件候选名。 */
const INSTRUCTION_FILE_NAMES = new Set([...PROJECT_INSTRUCTION_CANDIDATES, USER_GLOBAL_INSTRUCTION_FILE])

/**
 * 指令文件的信任根：cwd 的目录链，向上到最近的项目根为止（与探测范围一致）；
 * 没有 marker 时只有 cwd。不延伸到项目根之上——那会把同一卷上的任意路径都算进来。
 */
function instructionRoots(cwd) {
  const dirs = ancestorDirs(cwd)
  for (const [index, dir] of dirs.entries()) {
    if (ENGINE_PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dirs.slice(0, index + 1)
  }
  return [cwd]
}

/**
 * 文件即真相：每次注入都重读绑定文件，外部编辑立即生效。
 * 信任根 = cwd 的目录链到最近项目根（探测同一范围，故项目根 AGENTS.md 合法）+ DSH_HOME。
 * 越界、链接逃逸与非法名字直接抛出（executor 会 warn/skip 该配置）；
 * 目标或其父目录不存在时按缺失文件返回空串。
 */
function readBoundInstructionFile(file, cwd) {
  if (!INSTRUCTION_FILE_NAMES.has(basename(file))) {
    throw new Error(`instruction-hint: params.file must be an instruction file name (${[...INSTRUCTION_FILE_NAMES].join(', ')}), got ${JSON.stringify(file)}`)
  }
  let real
  try {
    real = resolveRealWithin(resolve(cwd, file), [...instructionRoots(cwd), machinePaths().DSH_HOME], 'instruction file')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
  try {
    return readFileSync(real, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * prompt-config placeholder fill=instruction-hint 的 resolver。
 * params.text（自定义提示）优先；params.file（文件卡绑定的单个指令文件）次之——
 * 运行时读该文件正文并加 `Instructions from:` 头注入；最后按 params.scope 探测来源
 * （all / global / project）按显式 projectTemplate/globalTemplate 生成提示。
 * 未配置提示模板时返回 null；引擎不提供默认引导文案。
 * params.file 不是任意文件读取：名字必须是指令文件候选名，真实路径必须在会话 cwd 到
 * 项目根的目录链或 DSH_HOME 内；越界、链接逃逸与非法名字在解析期抛错（executor 按单配置
 * 告警跳过）。文件缺失、不可读或空内容时返回 null。
 */
export function createInstructionHintResolver(config = {}) {
  const customText = typeof config?.params?.text === 'string' ? config.params.text.trim()
    : Array.isArray(config.texts) ? config.texts.join('\n\n').trim() : ''
  const scope = hintScope(config?.params?.scope)
  const file = typeof config?.params?.file === 'string' && config.params.file.trim().length > 0
    ? config.params.file.trim()
    : ''
  const fileLabel = typeof config?.params?.displayPath === 'string' && config.params.displayPath.trim().length > 0
    ? config.params.displayPath.trim()
    : file

  return async ({ ctx, agent, session }) => {
    const id = `instruction-hint-${session.id}-${randomUUID()}`
    if (customText.length > 0) {
      return { id, text: customText, source: { kind: 'instruction-hint', form: 'hint' } }
    }
    if (file.length > 0) {
      const content = readBoundInstructionFile(file, session.header?.cwd ?? process.cwd())
      return content.length > 0
        ? { id, text: `Instructions from: ${fileLabel}\n\n${content}`, source: { kind: 'instruction-file', form: 'instructions' } }
        : null
    }
    if (templateOf(config.params, 'projectTemplate').trim().length === 0 && templateOf(config.params, 'globalTemplate').trim().length === 0) return null
    const fs = ctx.get('fs')
    if (fs === undefined) return null
    const cwd = session.header?.cwd ?? process.cwd()
    const found = await collectInstructionFiles(fs, cwd, agent.signal)
    const text = buildInstructionHintText(found, scope, config.params)
    return text.length > 0
      ? { id, text, source: { kind: 'instruction-hint', form: 'hint' } }
      : null
  }
}

/** 从 agent-instructions 注入消息提取参考文件路径；removed 不是参考文件。 */
export function extractInstructionPaths(message) {
  const paths = []
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    for (const parsed of instructionBlocks(block.text)) {
      if (parsed.action === 'remove') continue
      const path = parsed.path.trim()
      if (path !== '' && !paths.includes(path)) paths.push(path)
    }
  }
  return paths
}

/** 构造一次性非命令式 hint 消息；替换已有消息时保留其 id。 */
export function buildInstructionHint(original, paths, sourceName = 'instruction-hint', templates = {}) {
  const template = templateOf(templates, 'messageTemplate')
  if (template.trim().length === 0) return original
  const text = interpolateStatic(template, { FILES: paths.join(', '), SUFFIX: templateOf(templates, 'suffixTemplate') }, undefined, 'messageTemplate')
  if (text.trim().length === 0) return original
  return {
    id: typeof original?.id === 'string' && original.id !== '' ? original.id : `instruction-hint-${randomUUID()}`,
    role: 'user',
    content: [{
      type: 'text',
      text,
    }],
    source: { kind: 'instruction-hint', form: 'hint', plugin: sourceName },
  }
}

/** 将 agent-instructions 全文替换为一次性 hint，后续全文消息丢弃。 */
export function instructionHintMessages(messages, state, sourceName = 'instruction-hint', templates = {}) {
  if (templateOf(templates, 'messageTemplate').trim().length === 0) return messages
  const kept = []
  for (const message of messages) {
    if (message?.source?.kind !== 'agent-instructions') {
      kept.push(message)
      continue
    }
    const paths = extractInstructionPaths(message)
    if (paths.length === 0) {
      if (!state.instructionHinted) kept.push(message)
      continue
    }
    const hint = buildInstructionHint(message, paths, sourceName, templates)
    if (hint === message) { kept.push(message); continue }
    if (state.instructionHinted) continue
    state.instructionHinted = true
    kept.push(hint)
  }
  return kept
}

// ── plugin 形态 ─────────────────────────────────────────────────────────────

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['enabled', 'promoteOn', 'includeSubagents', 'projectTemplate', 'globalTemplate', 'suffixTemplate', 'messageTemplate'])

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
  if (!enabled || templateOf(source, 'messageTemplate').trim().length === 0) return

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
      const coordinator = getService(ctx, PRE_STEP_COORDINATOR_SERVICE)
      const messages = typeof coordinator?.filterInstructions === 'function'
        ? coordinator.filterInstructions(agent, decision.messages)
        : decision.messages
      // 1 换 1 的转换不能按长度判断（长度相同仍可能已转换），
      // instructionHintMessages 本身保留非目标消息，直接采用结果。
      const hintState = { instructionHinted: hasVisibleInstructionHint(agent.session) }
      return { ...decision, messages: instructionHintMessages(messages, hintState, name, source) }
    } catch (error) {
      // 转换失败不阻断会话：保留原消息。
      warnOnce(`${name}: instruction hint conversion failed, keeping messages: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}

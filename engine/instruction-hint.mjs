/**
 * instruction-hint — 通用内置指令文件提示引擎。
 *
 * 这不是 anchored 预设专属能力：
 * - prompt-config 的 strategy=instruction-hint / placeholder fill=instruction-hint
 *   直接使用本模块；
 * - context-gate 的 instructionHint 转换也复用本模块的探测与消息构造。
 *
 * 只提示参考文件存在，不把文件正文塞进每轮上下文。文件探测失败时返回空结果，
 * 不阻断会话；独立生成的 hint 使用随机 id，替换既有消息时保留其 id。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const name = 'instruction-hint'

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
  return { root, projectFiles, userGlobalFiles }
}

/** 读取物化的 agents-instruction.md；路径相对本共享引擎文件解析。 */
export function readAgentsInstructionText(path = './agents-instruction.md') {
  try {
    return readFileSync(new URL(path, import.meta.url), 'utf8').trim()
  } catch {
    return ''
  }
}

/** 将探测结果格式化为建议式 hint；无文件时返回空字符串。 */
export function buildInstructionHintText({ root, projectFiles = [], userGlobalFiles = [] } = {}) {
  const sections = []
  if (projectFiles.length > 0) {
    sections.push(`Reference documents exist: ${projectFiles.join(', ')} (project root: ${root}).`)
  }
  if (userGlobalFiles.length > 0) {
    sections.push(`A user reference document exists: ${USER_GLOBAL_INSTRUCTION_CANDIDATE}.`)
  }
  if (sections.length === 0) return ''
  sections.push(REFERENCE_HINT_SUFFIX)
  return sections.join(' ')
}

/**
 * prompt-config strategy=instruction-hint 的 resolver。
 * params.text 优先，其次读取物化 agents-instruction.md，最后动态探测文件链。
 */
export function createInstructionHintResolver(config = {}) {
  const customText = typeof config?.params?.text === 'string' && config.params.text.trim().length > 0
    ? config.params.text.trim()
    : ''
  const instructionPath = typeof config?.params?.agentsInstructionPath === 'string'
    && config.params.agentsInstructionPath.trim().length > 0
    ? config.params.agentsInstructionPath
    : './agents-instruction.md'
  const agentsInstructionText = readAgentsInstructionText(instructionPath)

  return async ({ ctx, agent, session }) => {
    const id = `instruction-hint-${session.id}-${randomUUID()}`
    if (customText.length > 0) {
      return { id, text: customText, source: { kind: 'instruction-hint', form: 'hint' } }
    }
    if (agentsInstructionText.length > 0) {
      return { id, text: agentsInstructionText, source: { kind: 'instruction-hint', form: 'hint' } }
    }
    const fs = ctx.get('fs')
    if (fs === undefined) return null
    const cwd = session.header?.cwd ?? process.cwd()
    const found = await collectInstructionFiles(fs, cwd, agent.signal)
    const text = buildInstructionHintText(found)
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
/**
 * AGENTS 指令文件探测与文件卡合成。
 * 文件即真相：探测到的 AGENTS.md 不写进 preset.yml，只作为生成目录的 pre-step 卡；
 * 卡内编辑框经 bridge 直接读写该文件；注入侧运行时读该文件正文
 * （fill=instruction-file），文件缺失或空内容就不注入。
 *
 * 本模块是文件身份、读取快照与读写校验的唯一来源：UI 与运行时都走同一套规则，
 * 不各自实现一套转换。读取失败与「读取成功的空文件」严格区分。
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { DSH_HOME } from './paths.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'
import {
  MAX_INSTRUCTION_FILE_BYTES,
  type InstructionFileSnapshot,
  type InstructionFileStatus,
} from '../shared/instructions.ts'

/** 项目目录链候选文件（与 engine/instruction-hint.mjs 的探测候选同源）。 */
export const AGENTS_PROJECT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
export const AGENTS_USER_GLOBAL_FILE = 'AGENTS.md'
const PROJECT_ROOT_MARKERS = ['.git']
/** 大小写不敏感平台（Windows/macOS）：同一实际文件的不同写法必须映射到同一身份。 */
const CASE_INSENSITIVE_PLATFORM = process.platform === 'win32' || process.platform === 'darwin'

/** 文件身份（fileId + 路径 + 展示路径）：生成卡与读取快照共用的最小形状。 */
export interface AgentsFileIdentity {
  /** 稳定文件 id（规范化真实路径哈希；bridge 写白名单与卡 id 共用）。 */
  fileId: string
  /** 探测到的路径（普通文件；符号链接在 realPath 解析）。 */
  path: string
  displayPath: string
  scope: 'global' | 'project'
}

export interface AgentsFileCard extends AgentsFileIdentity {
  /** 解析后的真实路径：同一实际文件去重与身份校验用。 */
  realPath: string
}

export function agentsFileId(path: string): string {
  const normalized = resolve(path)
  const key = CASE_INSENSITIVE_PLATFORM ? normalized.toLowerCase() : normalized
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** 真实路径（解析符号链接/重解析点）；不存在或无法稳定确认时返回 undefined。 */
function realPathOf(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/** target 是否在 rootDir 内（大小写不敏感平台先归一，防符号链接把写入引到获准范围外）。 */
function within(rootDir: string, target: string): boolean {
  const root = CASE_INSENSITIVE_PLATFORM ? resolve(rootDir).toLowerCase() : resolve(rootDir)
  const candidate = CASE_INSENSITIVE_PLATFORM ? resolve(target).toLowerCase() : resolve(target)
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

function findProjectRoot(cwd: string): string {
  const start = resolve(cwd)
  let current = start
  for (;;) {
    if (PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/** 项目根 → cwd 的目录链（broad→specific）。 */
function ancestorChain(root: string, cwd: string): string[] {
  const stop = resolve(root)
  const chain: string[] = []
  let current = resolve(cwd)
  while (current !== stop) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(stop)
  return chain.reverse()
}

/** 显示路径：DSH_HOME 内用 `~/.dsh/…`，项目内用相对项目根路径，其余用绝对路径。 */
function displayPathOf(path: string, home: string, projectRoot: string): string {
  const inHome = relative(home, resolve(path))
  if (inHome.length > 0 && !inHome.startsWith('..')) return `~/.dsh/${inHome.replaceAll('\\', '/')}`
  const inProject = relative(projectRoot, resolve(path))
  if (inProject.length > 0 && !inProject.startsWith('..')) return inProject.replaceAll('\\', '/')
  return resolve(path)
}

/**
 * 探测当前可见的 AGENTS 指令文件：用户级 `$DSH_HOME/AGENTS.md` + cwd→项目根链的全部候选。
 * 只返回已存在的文件——探测不到就不生成卡。
 */
export function detectAgentsFiles(options: { cwd?: string; home?: string; projects?: boolean } = {}): AgentsFileCard[] {
  const home = resolve(options.home ?? DSH_HOME)
  const cwd = resolve(options.cwd ?? process.cwd())
  const root = findProjectRoot(cwd)
  const found: AgentsFileCard[] = []
  const seen = new Set<string>()
  const push = (path: string, scope: 'global' | 'project'): void => {
    if (!existsSync(path)) return
    // 只接受普通文件：目录、设备文件跳过（符号链接指向普通文件时按真实路径收录）。
    const realPath = realPathOf(path)
    if (realPath === undefined) return
    try {
      if (!statSync(realPath).isFile()) return
    } catch {
      return
    }
    // 重解析/符号链接不得把可写目标带出获准范围：全局文件限 DSH_HOME 内，
    // 项目文件限项目根内（项目根按 .git 标记，无标记时为会话 cwd）。
    if (!within(scope === 'global' ? home : root, realPath)) return
    // 同一实际文件只出现一次（例如 AGENTS.md 是指向 CLAUDE.md 的符号链接）。
    const identity = CASE_INSENSITIVE_PLATFORM ? realPath.toLowerCase() : realPath
    if (seen.has(identity)) return
    seen.add(identity)
    found.push({
      fileId: agentsFileId(realPath),
      path: resolve(path),
      realPath,
      displayPath: displayPathOf(path, home, root),
      scope,
    })
  }
  push(join(home, AGENTS_USER_GLOBAL_FILE), 'global')
  // projects: false = 项目范围不可用（无可解析本地会话）：只保留可确认的全局文件，
  // 不拿部署进程 cwd 冒充当前工作区。
  if (options.projects === false) return found
  for (const dir of ancestorChain(root, cwd)) {
    for (const candidate of AGENTS_PROJECT_CANDIDATES) push(join(dir, candidate), 'project')
  }
  return found
}

/**
 * 探测结果 → pre-step 提示卡（每个文件一张，不落 preset.yml）。
 * 插入点对齐官方 `@deepseek-ai/dsh-agent-instructions`：pre-step 层、紧随真实用户消息；
 * 注入内容 = 该文件当前正文（`fill=instruction-file` 运行时读取，params.file 精确到单个文件）。
 */
export function agentsFileCardSpecs(files: readonly AgentsFileIdentity[] = detectAgentsFiles()): PromptConfigSpec[] {
  return files.map((file, index) => ({
    id: `agents-file-${file.fileId}`,
    name: `AGENTS：${file.displayPath}`,
    enabled: true,
    strategy: 'placeholder',
    layer: 'pre-step',
    configKind: 'ordered' as const,
    order: 30 + index,
    role: 'user' as const,
    position: 'after-user' as const,
    dedupe: 'session' as const,
    promotion: 'include-subagents' as const,
    sourceKind: 'instruction-file',
    form: 'instructions',
    fill: 'instruction-hint',
    params: { scope: file.scope, file: file.path, displayPath: file.displayPath, fileId: file.fileId },
  }))
}

/**
 * 读取探测到的指令文件（缺失或不可读返回空串）。
 * @deprecated 只用于「失败即空」的旧调用点；需要区分读取失败请用 readAgentsFileSnapshot。
 */
export function readAgentsFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 单次读取形成一致快照：正文、revision、身份、读取状态来自同一次读取。
 * 只支持可正确解码的 UTF-8；有 BOM 的文件保留 BOM 字符，不让无关保存悄悄改写字节。
 */
export function readAgentsFileSnapshot(file: AgentsFileCard): InstructionFileSnapshot {
  const base = {
    fileId: file.fileId,
    path: file.path,
    displayPath: file.displayPath,
    scope: file.scope,
  }
  const fail = (status: InstructionFileStatus, message: string): InstructionFileSnapshot =>
    ({ ...base, status, text: '', revision: null, message })
  let size: number
  try {
    const stat = statSync(file.realPath)
    if (!stat.isFile()) return fail('unreadable', '不是普通文件')
    size = stat.size
  } catch {
    return fail('missing', '文件不存在或不可访问')
  }
  if (size > MAX_INSTRUCTION_FILE_BYTES) {
    return fail('too-large', `文件超过 ${MAX_INSTRUCTION_FILE_BYTES} 字节上限（${size} 字节），未读取`)
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(file.realPath)
  } catch {
    return fail('unreadable', '文件不可读（权限或 IO 错误）')
  }
  let text: string
  try {
    // ignoreBOM: 保留原文件 BOM 字符，保证「未编辑就不改字节」的往返一致。
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return fail('unreadable', '不是可正确解码的 UTF-8 文件，未读取')
  }
  return { ...base, status: 'ready', text, revision: sha256(bytes) }
}

/** 探测 + 读取：同一套探测规则下每个文件一份快照。 */
export function detectAgentsFileSnapshots(
  options: { cwd?: string; home?: string; projects?: boolean } = {},
): InstructionFileSnapshot[] {
  return detectAgentsFiles(options).map(readAgentsFileSnapshot)
}

export type AgentsFileWriteOutcome =
  | { ok: true; fileId: string; revision: string }
  | { ok: false; status: 400 | 404 | 409 | 413; code: string; message: string }

/** 同一文件的写盘串行队列（进程内）：两个并发请求不得交错读写同一目标。 */
const writeQueues = new Map<string, Promise<unknown>>()

/** 原子写指令文件（tmp + rename）；调用方必须先用 detectAgentsFiles() 校验路径白名单。 */
export function writeAgentsFile(path: string, content: string): void {
  const target = resolve(path)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let mode: number | undefined
  try {
    mode = statSync(target).mode & 0o777
  } catch {
    mode = undefined
  }
  try {
    writeFileSync(tmp, content, 'utf8')
    // 保留原文件权限，不让原子替换扩大访问范围。
    if (mode !== undefined) chmodSync(tmp, mode)
    renameSync(tmp, target)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不掩盖原始错误。
    }
    throw error
  }
}

/**
 * 带版本校验的单文件写：
 * 1. 写前在同一段内重读文件，expectedRevision 不一致 = 409（不做「猜到用户意图」的重试）；
 * 2. 目标消失 = 404，不自动重建用户文件；
 * 3. 正文超限 = 413，不截断保存；
 * 4. 替换前复查目标身份（真实路径未变），失败保留原文件并清理临时文件。
 */
export async function writeAgentsFileChecked(options: {
  file: AgentsFileCard
  content: string
  expectedRevision: string | null
}): Promise<AgentsFileWriteOutcome> {
  const { file, content, expectedRevision } = options
  const key = CASE_INSENSITIVE_PLATFORM ? file.realPath.toLowerCase() : file.realPath
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const run = previous.then(
    () => writeCheckedNow(),
    () => writeCheckedNow(),
  )
  const entry = run.then(() => undefined, () => undefined)
  writeQueues.set(key, entry)
  try {
    return await run
  } finally {
    // 只有队尾仍是本次写入时才清理；后续请求已把自己的链挂上时不动它。
    if (writeQueues.get(key) === entry) writeQueues.delete(key)
  }

  async function writeCheckedNow(): Promise<AgentsFileWriteOutcome> {
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > MAX_INSTRUCTION_FILE_BYTES) {
      return {
        ok: false,
        status: 413,
        code: 'agents-file-too-large',
        message: `正文 ${bytes.length} 字节超过 ${MAX_INSTRUCTION_FILE_BYTES} 字节上限，未写盘`,
      }
    }
    const before = readAgentsFileSnapshot(file)
    if (before.status === 'missing') {
      return { ok: false, status: 404, code: 'agents-file-missing', message: '指令文件已不存在（不自动重建）' }
    }
    if (before.status !== 'ready' || before.revision === null) {
      return {
        ok: false,
        status: 409,
        code: 'agents-file-unreadable',
        message: before.message ?? '指令文件当前不可读，未写盘',
      }
    }
    if (before.revision !== expectedRevision) {
      return {
        ok: false,
        status: 409,
        code: 'agents-file-conflict',
        message: '文件已被外部修改，保存被拒绝；请重新读取后再保存',
      }
    }
    if (realPathOf(file.path) !== file.realPath) {
      return { ok: false, status: 409, code: 'agents-file-identity-changed', message: '目标文件身份已变化，未写盘' }
    }
    try {
      writeAgentsFile(file.realPath, content)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, status: 409, code: 'agents-file-write-failed', message: `写盘失败：${message}` }
    }
    return { ok: true, fileId: file.fileId, revision: sha256(bytes) }
  }
}

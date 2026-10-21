/**
 * AGENTS 指令文件探测与文件卡合成。
 * 文件卡只作编辑视图，不写进 module.yml 或生成目录；正文经 bridge 写回原文件。
 * 官方负责注入，运行时只复用本模块的文件身份映射应用逐文件开关。
 *
 * 本模块拥有本地卡片的文件身份、读取快照与读写校验；读取失败与空文件严格区分。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { dshHome } from './paths.ts'
import { atomicWriteTextFile } from './text-file.ts'
import { replaceVersionedText } from './versioned-text.ts'
import { createTargetQueue } from '../shared/target-queue.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'
import {
  MAX_INSTRUCTION_FILE_BYTES,
  type InstructionFileSnapshot,
  type InstructionFileStatus,
} from '../shared/instructions.ts'
import {
  PROJECT_INSTRUCTION_CANDIDATES,
  USER_GLOBAL_INSTRUCTION_FILE,
  ancestorDirs,
  instructionPlan,
} from '../../engine/instruction-files.mjs'

/** 宿主的项目根标记；候选清单与目录链来自 engine/instruction-files.mjs，不再本地抄一份。 */
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


/** 官方展示路径 → 既有卡片身份；只解析路径，不读取正文，也不构成写入授权。 */
export function instructionFileIdFromDisplayPath(displayPath: string, projectRoot?: string, home: string = dshHome()): string | undefined {
  const global = displayPath === '~/.dsh/' + USER_GLOBAL_INSTRUCTION_FILE || displayPath === '$DSH_HOME/' + USER_GLOBAL_INSTRUCTION_FILE
  if (!global && (projectRoot === undefined || isAbsolute(displayPath) || displayPath.includes('\0'))) return undefined
  const root = global ? resolve(home) : resolve(projectRoot!)
  const path = global ? join(root, USER_GLOBAL_INSTRUCTION_FILE) : resolve(root, displayPath)
  if (!within(root, path)) return undefined
  // 文件已删除时仍按原普通路径匹配其关闭策略，允许过滤 remove 通知。
  const realPath = realPathOf(path) ?? path
  if (!within(realPathOf(root) ?? root, realPath)) return undefined
  return agentsFileId(realPath)
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
  const home = resolve(options.home ?? dshHome())
  const cwd = resolve(options.cwd ?? process.cwd())
  // 宿主只认自己的 marker 集合；选根与目录链由引擎探测判据一次给出。
  const markerDirs = new Set(ancestorDirs(cwd).filter((dir) => PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))))
  const plan = instructionPlan(cwd, markerDirs)
  const root = plan.root
  const realHome = realPathOf(home)
  const realRoot = realPathOf(root)
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
    // 授权根本身也可能是目录链接，必须与候选在同一真实路径空间比较。
    const allowedRoot = scope === 'global' ? realHome : realRoot
    if (allowedRoot === undefined || !within(allowedRoot, realPath)) return
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
  push(join(home, USER_GLOBAL_INSTRUCTION_FILE), 'global')
  // projects: false = 项目范围不可用（无可解析本地会话）：只保留可确认的全局文件，
  // 不拿部署进程 cwd 冒充当前工作区。
  if (options.projects === false) return found
  for (const dir of plan.dirs) {
    for (const candidate of PROJECT_INSTRUCTION_CANDIDATES) push(join(dir, candidate), 'project')
  }
  return found
}

/**
 * 探测结果 → pre-step 提示卡（每个文件一张，不落 module.yml）。
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
const writeQueues = createTargetQueue()

/** rename 前的复核失败：`replaceVersionedText` 只抛错，由写盘入口按这两个码映射成 409。 */
class AgentsFileRecheckError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message); this.name = 'AgentsFileRecheckError'; this.code = code
  }
}

/** 原子写指令文件（tmp + rename）；调用方必须先用 detectAgentsFiles() 校验路径白名单。 */
export function writeAgentsFile(path: string, content: string, beforeReplace?: () => void): void {
  // 暂存命名、独占创建、权限精确保留与失败清理归 text-file；本函数只解析目标路径。
  atomicWriteTextFile(resolve(path), content, { mkdir: true, ...(beforeReplace === undefined ? {} : { beforeReplace }) })
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
  return writeQueues.run(key, () => writeCheckedNow())

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
      replaceVersionedText({
        file: file.realPath,
        expectedRevision,
        read: () => {
          const current = readAgentsFileSnapshot(file)
          if (current.status !== 'ready' || current.revision === null) {
            throw new AgentsFileRecheckError('agents-file-conflict', '文件已被外部修改，保存被拒绝；请重新读取后再保存')
          }
          // 不传 text：同文也必须走一次 rename 前身份复核，保持旧写盘语义。
          return { revision: current.revision, value: current }
        },
        prepare: () => content,
        recheck: () => {
          // 版本比对到 rename 之间仍可能被外部改写：替换前再核身份。
          if (realPathOf(file.path) !== file.realPath) {
            throw new AgentsFileRecheckError('agents-file-identity-changed', '目标文件身份已变化，未写盘')
          }
        },
        conflict: () => new AgentsFileRecheckError('agents-file-conflict', '文件已被外部修改，保存被拒绝；请重新读取后再保存'),
        mkdir: true,
      })
    } catch (error) {
      if (error instanceof AgentsFileRecheckError) return { ok: false, status: 409, code: error.code, message: error.message }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, status: 409, code: 'agents-file-write-failed', message: `写盘失败：${message}` }
    }
    return { ok: true, fileId: file.fileId, revision: sha256(bytes) }
  }
}

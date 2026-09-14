/**
 * AGENTS 指令文件探测与文件卡合成。
 * 文件即真相：探测到的 AGENTS.md 不写进 preset.yml，只作为生成目录的 pre-step 卡；
 * 卡内编辑框经 bridge 直接读写该文件；注入侧运行时读该文件正文
 * （fill=instruction-file），文件缺失或空内容就不注入。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { DSH_HOME } from './paths.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'

/** 项目目录链候选文件（与 engine/instruction-hint.mjs 的探测候选同源）。 */
export const AGENTS_PROJECT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
export const AGENTS_USER_GLOBAL_FILE = 'AGENTS.md'
const PROJECT_ROOT_MARKERS = ['.git']

export interface AgentsFileCard {
  /** 稳定文件 id（绝对路径哈希前 8 位；bridge 写白名单与卡 id 共用）。 */
  fileId: string
  path: string
  displayPath: string
  scope: 'global' | 'project'
}

export function agentsFileId(path: string): string {
  return createHash('sha1').update(resolve(path).toLowerCase()).digest('hex').slice(0, 8)
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
export function detectAgentsFiles(options: { cwd?: string; home?: string } = {}): AgentsFileCard[] {
  const home = resolve(options.home ?? DSH_HOME)
  const cwd = resolve(options.cwd ?? process.cwd())
  const root = findProjectRoot(cwd)
  const found: AgentsFileCard[] = []
  const push = (path: string, scope: 'global' | 'project'): void => {
    if (!existsSync(path)) return
    found.push({ fileId: agentsFileId(path), path: resolve(path), displayPath: displayPathOf(path, home, root), scope })
  }
  push(join(home, AGENTS_USER_GLOBAL_FILE), 'global')
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
export function agentsFileCardSpecs(files: readonly AgentsFileCard[] = detectAgentsFiles()): PromptConfigSpec[] {
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

/** 读取探测到的指令文件（缺失或不可读返回空串）。 */
export function readAgentsFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 原子写指令文件（tmp + rename）；调用方必须先用 detectAgentsFiles() 校验路径白名单。 */
export function writeAgentsFile(path: string, content: string): void {
  const target = resolve(path)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, target)
}

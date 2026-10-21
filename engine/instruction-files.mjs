/**
 * instruction-files — 指令文件探测的判据库。
 *
 * 探测判据（候选清单、项目根、目录链）是纯函数；读盘由两个消费者各自完成——
 * 引擎用本文件提供的异步执行器（collectInstructionFiles），宿主用 node:fs 同步 +
 * 信任根校验。库随 engine/ 一起复制；行 instruction-hint 只消费这里的执行器。
 */
import { dirname, join } from 'node:path'
import { machinePaths } from './machine-paths.mjs'

/** 项目目录链中按优先级探测的指令文件名。 */
export const PROJECT_INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
export const USER_GLOBAL_INSTRUCTION_FILE = 'AGENTS.md'

/** 引擎侧的项目根标记；宿主有自己的集合（例如只要 .git），因此这里不做统一。 */
const ENGINE_PROJECT_ROOT_MARKERS = ['.git', '.hg', '.svn']

/** cwd 到文件系统根：含自身，父目录等于自身时停止。 */
export function ancestorDirs(cwd) {
  const dirs = [cwd]
  for (;;) {
    const parent = dirname(dirs[dirs.length - 1])
    if (parent === dirs[dirs.length - 1]) return dirs
    dirs.push(parent)
  }
}

/** 最近的含 marker 祖先；没有 marker 或 marker 不在祖先链上时回落 cwd。 */
function resolveProjectRoot(cwd, markerDirs) {
  for (const dir of ancestorDirs(cwd)) if (markerDirs.has(dir)) return dir
  return cwd
}

/** 项目根到 cwd 的目录链（广到窄）；root 不是 cwd 的祖先时只回落 cwd，不猜。 */
function instructionDirs(cwd, root) {
  const dirs = ancestorDirs(cwd)
  const index = dirs.indexOf(root)
  if (index < 0) return [cwd]
  return dirs.slice(0, index + 1).reverse()
}

/**
 * 一次给出项目根与目录链（广到窄）：调用方只需一次调用，不再自己排三步。
 * markerDirs 的字符串必须取自 ancestorDirs（同一套规范化，UNC 共享名根带尾分隔符）。
 * root 不是 cwd 的祖先时 dirs 只含 cwd，不猜。
 */
export function instructionPlan(cwd, markerDirs) {
  const root = resolveProjectRoot(cwd, markerDirs)
  return { root, dirs: instructionDirs(cwd, root) }
}

/** 列出某目录里的候选文件（按候选顺序）；探测失败逐条跳过，不阻断会话。 */
async function presentInDir(fs, dir, candidates, signal) {
  const found = []
  for (const candidate of candidates) {
    try {
      const target = await fs.resolve(join(dir, candidate), { cwd: dir, signal })
      const info = await fs.stat(target, signal)
      if (info !== undefined && info.type === 'file') found.push(candidate)
    } catch {
      // 不存在或不可读——跳过。
    }
  }
  return found
}

/**
 * 探测 cwd 到项目根的完整目录链，以及 DSH_HOME 下的用户级指令文件。
 * 计划与读盘分离：先由 ancestorDirs 得到祖先，再异步探 marker，最后交给纯函数选根。
 */
export async function collectInstructionFiles(fs, cwd, signal, home) {
  const markerDirs = new Set()
  for (const dir of ancestorDirs(cwd)) {
    for (const marker of ENGINE_PROJECT_ROOT_MARKERS) {
      try {
        const target = await fs.resolve(join(dir, marker), { cwd: dir, signal })
        if (await fs.stat(target, signal) !== undefined) { markerDirs.add(dir); break }
      } catch {
        // 标记不存在——继续看上一层。
      }
    }
  }
  const plan = instructionPlan(cwd, markerDirs)
  const projectFiles = []
  // 注入顺序要求近者优先：cwd 先于项目根；根目录下的文件用裸候选名。
  for (const dir of [...plan.dirs].reverse()) {
    for (const candidate of await presentInDir(fs, dir, PROJECT_INSTRUCTION_CANDIDATES, signal)) {
      projectFiles.push(dir === plan.root ? candidate : join(dir, candidate))
    }
  }
  const userGlobalFiles = []
  // 路径类事实取唯一来源；本处需要 undefined 表示「没有可探测的全局目录」，故把空串折回缺省。
  const dshHome = home ?? (machinePaths().DSH_HOME || undefined)
  if (dshHome !== undefined) {
    userGlobalFiles.push(...await presentInDir(fs, dshHome, [USER_GLOBAL_INSTRUCTION_FILE], signal))
  }
  return { root: plan.root, projectFiles, userGlobalFiles, userGlobalHome: dshHome }
}

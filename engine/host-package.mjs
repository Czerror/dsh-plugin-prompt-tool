/**
 * host-package — 从运行中的 DSH 宿主入口解析宿主侧包。
 *
 * 全局 dsh 常以 junction/symlink 暴露（npm-global/@deepseek-ai/dsh → 真实包目录），
 * 而 pnpm 在包内建立的相对 symlink 只在真实路径下可解析：沿 junction 路径用
 * createRequire(process.argv[1]) 解析会得到 Cannot find module '@deepseek-ai/dsh-tools'。
 * 入口先取 realpath，再回退原路径与引擎自身，两种安装形态都能解析到同一份宿主依赖。
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 按优先级列出 createRequire 的解析基准：真实入口 → 原始入口 → 引擎文件自身。
 * @param {string|undefined} entry 宿主入口路径（默认 process.argv[1]）。
 * @param {string|undefined} self 引擎文件路径（默认 import.meta.url）。
 * @returns {string[]} 去重后的基准列表。
 */
export function hostResolutionBases(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  const bases = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !bases.includes(value)) bases.push(value)
  }
  if (typeof entry === 'string' && entry.length > 0) {
    try { push(realpathSync(entry)) } catch { /* 入口不存在（测试/嵌入式）时退回原路径 */ }
    push(entry)
  }
  push(self)
  return bases
}

/**
 * 解析宿主侧包 id。
 * @param {string} id 包名（如 '@deepseek-ai/dsh-tools'）。
 * @param {string|undefined} entry 宿主入口路径。
 * @param {string|undefined} self 引擎文件路径。
 * @returns {string} 解析到的绝对文件路径。
 * @throws 全部基准都解析失败时抛出，并列出已尝试的基准。
 */
export function resolveHostPackage(id, entry, self) {
  const bases = hostResolutionBases(entry, self)
  for (const base of bases) {
    try { return createRequire(base).resolve(id) } catch { /* 下一个基准 */ }
  }
  throw new Error(`prompt-tool: cannot resolve ${id} from host entry (tried: ${bases.join(', ')})`)
}

/** 动态 import 宿主侧包，返回其命名空间。 */
export async function importHostPackage(id, entry, self) {
  return import(pathToFileURL(resolveHostPackage(id, entry, self)).href)
}

/**
 * path-safety — 真实路径（realpath）边界：词法 containment 拦不住 symlink / junction。
 *
 * 两个消费者共用这一条判据：instruction-hint 读 params.file、tool-config-engine 的 fs 执行器。
 * 已存在的目标解析自身；新文件解析父目录（writeFileSync 不创建目录），悬空链接先按
 * readlink 追到缺失目标——否则 write 会顺着链接写到信任根之外。
 */

import { readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** target 在 root 内（含 root 自身）；两者都必须是真实路径。 */
function isWithin(root, target) {
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** 目标真实路径；深层目录不存在或链接环时抛出原始错误。 */
function realPathOf(target) {
  try {
    return realpathSync(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    let link
    try { link = readlinkSync(target) } catch { link = undefined }
    // 悬空符号链接：realpath 看不到目标，但 write 会顺着它落盘，所以先解析链接本身。
    if (link !== undefined) return realPathOf(resolve(dirname(target), link))
    return join(realpathSync(dirname(target)), basename(target))
  }
}

/** 信任根的真实路径；不存在或不可解析的根跳过——根不可用不等于放行。 */
function usableRoots(roots) {
  const allowed = []
  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue
    try { allowed.push(realpathSync(root)) } catch { /* 根不存在或不可解析 */ }
  }
  return allowed
}

/**
 * 解析 target 并要求真实路径落在任一信任根内（fail closed）。
 *
 * @param target 已 resolve 的绝对路径（相对路径由调用方按自己的基目录解析）
 * @param roots 信任根：会话 cwd、DSH_HOME 等
 * @param label 报错中的对象名（path / instruction file）
 * @returns 真实路径：调用方后续 IO 都用它，避免校验与使用之间再次经过链接
 */
export function resolveRealWithin(target, roots, label = 'path') {
  const real = realPathOf(target)
  const allowed = usableRoots(roots)
  if (allowed.some((root) => isWithin(root, real))) return real
  const shown = allowed.length > 0
    ? allowed.join(', ')
    : roots.filter((root) => typeof root === 'string' && root.length > 0).join(', ') || 'the trust roots'
  throw new Error(`${label} ${JSON.stringify(target)} escapes the trust root: real path ${JSON.stringify(real)} is outside ${shown}`)
}

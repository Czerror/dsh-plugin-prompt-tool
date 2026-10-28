/** 清单 checks 的运行期事实：只读，按 manifest 与各检查文件的 mtime/size 缓存。 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { assertModuleDirectory } from './module-install.ts'
import { readModuleManifest, runModuleManifest } from './module-manifest.ts'

type Manifest = ReturnType<typeof readModuleManifest>

export interface ManifestCheckReader { read(moduleId: string): boolean | undefined }

/** 文件事实戳：mtime 加 size，避免同一毫秒内等长改写被漏掉。 */
const stampOf = (path: string): string | undefined => {
  const stat = statSync(path, { throwIfNoEntry: false })
  return stat === undefined ? undefined : `${stat.mtimeMs}:${stat.size}`
}

/**
 * check 本身保持只读：这里只把结果缓存成规则可读的事实。
 * 清单缺失、坏 YAML、模块目录不合法都是 undefined（UNAVAILABLE），不是「检查失败」。
 */
export function createManifestCheckReader(moduleRoot: string): ManifestCheckReader {
  const dirs = new Map<string, string>()
  const manifests = new Map<string, { stamp: string; value: Manifest }>()
  const results = new Map<string, { key: string; ok: boolean }>()
  // 目录解析与链接检查较贵，按 moduleId 缓存；路径派生不随目录内容变化，目录删除后由 manifest 缺失归为不可用。
  const dirOf = (moduleId: string): string | undefined => {
    const hit = dirs.get(moduleId)
    if (hit !== undefined) return hit
    try {
      const dir = assertModuleDirectory(moduleRoot, moduleId)
      dirs.set(moduleId, dir)
      return dir
    } catch { return undefined }
  }
  const manifestOf = (dir: string): { stamp: string; value: Manifest } | undefined => {
    const stamp = stampOf(join(dir, 'assets', 'manifest.yml'))
    if (stamp === undefined) { manifests.delete(dir); return undefined }
    const hit = manifests.get(dir)
    if (hit !== undefined && hit.stamp === stamp) return hit
    const value = readModuleManifest(dir)
    const entry = { stamp, value }
    manifests.set(dir, entry)
    return entry
  }
  const read = (moduleId: string): boolean | undefined => {
    const dir = dirOf(moduleId)
    if (dir === undefined) return undefined
    let current: { stamp: string; value: Manifest } | undefined
    try { current = manifestOf(dir) } catch { manifests.delete(dir); return undefined }
    if (current === undefined) return undefined
    // manifest 自己的戳也进键：改 kind/maxBytes 不碰检查文件时结论也必须跟着变。
    const files = (() => {
      try {
        return current!.value.checks.map((entry) => `${entry.path}:${stampOf(join(dir, entry.path)) ?? 'missing'}`).join('|')
      } catch { return undefined }
    })()
    if (files === undefined) return undefined
    const key = `${current.stamp}|${files}`
    const hit = results.get(dir)
    if (hit !== undefined && hit.key === key) return hit.ok
    try {
      const ok = runModuleManifest(dir, 'check').ok
      results.set(dir, { key, ok })
      return ok
    } catch { results.delete(dir); return undefined }
  }
  return { read }
}

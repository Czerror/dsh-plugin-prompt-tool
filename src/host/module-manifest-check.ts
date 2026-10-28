/** 清单 checks 的运行期事实：只读，缓存 1000ms，manifest 戳变化提前失效。 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { RuleManifestCheck } from '../../engine/rule-runtime.mjs'
import { assertModuleDirectory } from './module-install.ts'
import { runModuleManifest } from './module-manifest.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    promptToolManifestCheck: RuleManifestCheck
  }
}

/** manifest 配置戳；同戳等长改写由缓存到期后的完整检查识别。 */
const stampOf = (path: string): string | undefined => {
  const stat = statSync(path, { throwIfNoEntry: false })
  return stat === undefined ? undefined : `${stat.mtimeMs}:${stat.size}`
}

/**
 * check 本身保持只读：这里只把结果缓存成规则可读的事实。
 * 清单缺失、坏 YAML、模块目录不合法都是 undefined（UNAVAILABLE），不是「检查失败」。
 */
export function createManifestCheckReader(moduleRoot: string): RuleManifestCheck {
  const dirs = new Map<string, string>()
  const results = new Map<string, { stamp: string; checkedAt: number; ok: boolean | undefined }>()
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
  const read = (moduleId: string): boolean | undefined => {
    const dir = dirOf(moduleId)
    if (dir === undefined) return undefined
    let stamp: string | undefined
    try { stamp = stampOf(join(dir, 'assets', 'manifest.yml')) } catch { results.delete(dir); return undefined }
    if (stamp === undefined) { results.delete(dir); return undefined }
    const hit = results.get(dir)
    if (hit !== undefined && hit.stamp === stamp && performance.now() - hit.checkedAt < 1000) return hit.ok
    let ok: boolean | undefined
    try {
      ok = runModuleManifest(dir, 'check').ok
    } catch { ok = undefined }
    results.set(dir, { stamp, checkedAt: performance.now(), ok })
    return ok
  }
  return { read }
}

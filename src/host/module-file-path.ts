/** 模块私有文件的唯一路径语言：memory.md 根文件、assets/ 只读、data/ 只追加。 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { assertSafeRelativePath } from '../shared/asset-path.ts'
import { resolveRealWithin } from '../../engine/path-safety.mjs'
import { assertNoModuleLinks, modulePathExists } from './module-install.ts'

export type ModuleFileRoot = 'assets' | 'data'

export interface ModuleFilePathOptions {
  /** 允许模块根的 memory.md（读与追写）。 */
  allowRootMemory?: boolean
}

export interface ModuleFilePath {
  path: string
  file: string
}

/** 只做词法与允许根校验，不触盘：清单里尚未落盘的目标路径也要能校验。 */
export function moduleFilePath(
  moduleDir: string, path: string, roots: readonly ModuleFileRoot[], options: ModuleFilePathOptions = {},
): ModuleFilePath {
  if (typeof path !== 'string' || path.length === 0) throw new Error('模块文件路径必须是非空字符串')
  assertSafeRelativePath(path)
  const rootMemory = options.allowRootMemory === true && path === 'memory.md'
  const first = path.split('/')[0]!
  if (!rootMemory && !roots.includes(first as ModuleFileRoot)) {
    const allowed = [...(options.allowRootMemory === true ? ['memory.md'] : []), ...roots.map((root) => root + '/')]
    throw new Error(`模块文件路径只能位于 ${allowed.join('、')}：${path}`)
  }
  return { path, file: join(moduleDir, ...path.split('/')) }
}

/**
 * 解析模块内相对路径并要求真实路径落在模块目录内。
 *
 * 先做词法校验与链接检查（保留「包含链接」的可诊断文案），再用 `resolveRealWithin`
 * 拦悬空链接与真实路径越界；返回真实路径，调用方后续 IO 不再经过链接。
 */
export function resolveModuleFilePath(
  moduleDir: string, path: string, roots: readonly ModuleFileRoot[], options: ModuleFilePathOptions = {},
): string {
  const { file } = moduleFilePath(moduleDir, path, roots, options)
  assertNoModuleLinks(file)
  return resolveRealWithin(file, [moduleDir], '模块文件路径')
}

/** 只创建一级 data/；中间目录不替调用方发明，缺失时由真实路径解析报错。 */
export function ensureDataDirectory(moduleDir: string): string {
  const dir = join(moduleDir, 'data')
  assertNoModuleLinks(dir)
  if (!modulePathExists(dir)) mkdirSync(dir)
  assertNoModuleLinks(dir)
  return resolveRealWithin(dir, [moduleDir], '模块数据目录')
}

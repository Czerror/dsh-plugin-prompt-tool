import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseDocument, YAMLMap } from 'yaml'
import { MODULE_DEFINITION_FILE } from './paths.ts'

export function assertModuleId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`非法模块 id：${String(id)}；必须为小写字母、数字和连字符`)
  }
}

/** 规则模板路径相对模块根，复制目录无需重写路径或用户正文。 */
export function setModuleDefinitionId(doc: ReturnType<typeof parseDocument>, id: string): void {
  assertModuleId(id)
  const previous = doc.get('id')
  if (previous === id) return
  doc.set('id', id)
}

/** ENOENT 才表示不存在；权限、占用与读取失败继续传播。 */
export function modulePathExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function canonicalModulesRoot(root: string, allowMissing = false): string {
  const absoluteRoot = resolve(root)
  if (!modulePathExists(absoluteRoot)) {
    if (allowMissing) return absoluteRoot
    throw new Error(`预设根不存在：${absoluteRoot}`)
  }
  const rootStat = lstatSync(absoluteRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`预设根不是普通目录：${absoluteRoot}`)
  return realpathSync(absoluteRoot)
}

/** 根与目标先解析真实路径，拒绝链接目录及定义身份不一致。 */
export function assertModuleDirectory(root: string, id: string, allowMissing = false): string {
  assertModuleId(id)
  const canonicalRoot = canonicalModulesRoot(root, allowMissing)
  const target = join(canonicalRoot, id)
  if (!modulePathExists(target)) {
    if (allowMissing) return target
    throw new Error(`预设 ${id} 不存在`)
  }
  const stat = lstatSync(target)
  if (stat.isSymbolicLink() || !stat.isDirectory() || dirname(realpathSync(target)) !== canonicalRoot) {
    throw new Error(`预设路径包含链接或越界：${id}`)
  }
  // Windows 的文件查找不区分大小写，宿主发现规则区分大小写。
  if (!readdirSync(canonicalRoot).includes(id)) throw new Error(`预设目录身份不匹配：${id}`)
  const definition = join(target, MODULE_DEFINITION_FILE)
  const fileStat = lstatSync(definition)
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error(`预设定义不是普通文件：${id}`)
  const doc = parseDocument(readFileSync(definition, 'utf8'), { logLevel: 'silent' })
  if (doc.errors.length > 0 || !(doc.contents instanceof YAMLMap)) throw new Error(`预设定义无效：${id}`)
  const declared = doc.get('id')
  if (declared !== undefined && declared !== id) throw new Error(`预设定义身份不匹配：${id}`)
  return target
}

/** 复制和物化只接受自有普通文件；不跟随任意层级链接读取根外数据。 */
export function assertModuleTree(dir: string): void {
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink()) throw new Error(`预设包含链接：${dir}`)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(dir)) assertModuleTree(join(dir, entry))
  } else if (!stat.isFile()) throw new Error(`预设包含特殊文件：${dir}`)
}


/** 已发布的旧入口只在此处适配。 */

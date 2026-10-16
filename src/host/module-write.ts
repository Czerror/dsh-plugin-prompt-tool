/**
 * 本文件拥有 **YAML 写事务原语**：跨进程/进程内锁、字节版本摘要、共享引用守卫与写错误协议。
 *
 * 不拥有任何规则切片知识——切片投影在 `module-slices.ts`，依赖单向（那边 import 这边）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { parseDocument } from 'yaml'
import type { RuleRevisions } from '../shared/rules.ts'
import { assertModuleId, canonicalModulesRoot } from './module-install.ts'

/** 形状判据，与切片侧共用（见 `module-slices.ts`）。 */
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export const revisionOf = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

export class ModuleWriteError extends Error {
  readonly status: 400 | 403 | 409 | 500
  readonly code: string
  readonly persisted: boolean
  readonly revisions?: RuleRevisions
  createdRuleId?: string
  constructor(message: string, status: 400 | 403 | 409 | 500 = 400, code = 'rules-invalid', persisted = false, revisions?: RuleRevisions) {
    super(message); this.name = 'ModuleWriteError'; this.status = status; this.code = code
    this.persisted = persisted; this.revisions = revisions
  }
}

/**
 * 共享引用被连带改写时的统一错误码。
 *
 * 不变量（本文件是它唯一的家）：**调用方只声明自己要改的键，其余字段必须逐字不变**——
 * YAML 的 anchor/alias 会让一次「只改 A」的编辑同时改掉 B，静默改掉用户没打算动的字段。
 * 两种写法见 {@link serializeWithoutSharedAlias}（声明完整候选）与
 * {@link assertUnownedUnchanged}（改-后-比对）。
 */
export const SHARED_ALIAS_CODE = 'shared-alias'

/** 未拥有且值真的变了的顶层键（新增与删除都算），供拒绝文案点名。 */
function changedUnownedKeys(before: Record<string, unknown>, after: Record<string, unknown>, owns: readonly string[]): string[] {
  const owned = new Set(owns)
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter(key => !owned.has(key) && !isDeepStrictEqual(before[key], after[key]))
}

const sharedAliasError = (message: string, changed: readonly string[]): ModuleWriteError =>
  new ModuleWriteError(changed.length === 0 ? message : `${message}（连带改了 ${changed.join('、')}）`, 400, SHARED_ALIAS_CODE)

/**
 * 序列化并要求结果等于调用方声明的完整候选；不等即按共享引用拒绝。
 *
 * `doc.toString()` 与比对同包在一个 try 里是刻意的：别名锚点被移除时序列化本身就会抛，
 * 那同样属于「共享引用」，不能让它冒成 500。诊断（点名连带改动的键）自己也包在 try 里——
 * 文档已不可解析时只报固有文案。
 */
export function serializeWithoutSharedAlias(doc: ReturnType<typeof parseDocument>, expected: unknown, message: string): string {
  try {
    const text = doc.toString()
    if (!isDeepStrictEqual(doc.toJS(), expected)) throw new Error('shared alias changed')
    return text
  } catch {
    let changed: string[] = []
    try {
      changed = changedUnownedKeys(record(expected) ? expected : {}, doc.toJS() as Record<string, unknown>, [])
    } catch { /* 别名悬空：文档已不可解析，只报固有文案。 */ }
    throw sharedAliasError(message, changed)
  }
}

/**
 * 改-后-比对形态：`owns` 之外的顶层键必须逐字不变。
 *
 * `owns` 是调用方义务而不是类型能检查的东西——少声明的代价是**误拒**（fail-closed，用例会立刻红），
 * 多声明只是守卫变弱；拒绝文案点名被连带改动的键，让前者一眼可诊。`doc.toJS()` 的解析失败
 * （别名悬空）同样按共享引用拒绝。
 */
export function assertUnownedUnchanged(before: unknown, doc: ReturnType<typeof parseDocument>, owns: readonly string[], message: string): void {
  let after: Record<string, unknown>
  try {
    after = doc.toJS() as Record<string, unknown>
  } catch {
    throw sharedAliasError(message, [])
  }
  const changed = changedUnownedKeys(record(before) ? before : {}, after, owns)
  if (changed.length > 0) throw sharedAliasError(message, changed)
}

/** 父集合缺失时不触发 `deleteIn` 对不存在集合的异常。 */
export function deleteYamlPath(doc: ReturnType<typeof parseDocument>, path: string[]): void {
  if (doc.hasIn(path)) doc.deleteIn(path)
}

/** 路径判据与归一：两侧共用，归事务侧（`module-slices.ts` 只 import）。 */
export function assertPlain(path: string, directory = false): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new ModuleWriteError(`规则切片路径不是普通${directory ? '目录' : '文件'}：${path}`)
}
export function canonicalDirectory(directory: string): string {
  const absolute = resolve(directory)
  assertPlain(dirname(absolute), true)
  assertPlain(absolute, true)
  return realpathSync(absolute)
}
export function moduleLocation(directory: string): string {
  const absolute = resolve(directory)
  if (existsSync(absolute)) return canonicalDirectory(absolute)
  const id = process.platform === 'win32' ? basename(absolute).toLowerCase() : basename(absolute)
  assertModuleId(id)
  return join(canonicalModulesRoot(dirname(absolute)), id)
}

export const directoryKey = (directory: string): string => process.platform === 'win32' ? directory.toLowerCase() : directory
const lockDirectory = (directory: string): string => join(dirname(directory), '.' + basename(directory) + '.locks')
/** 进行中的进程内事务集合（按 directoryKey）；切片侧只读共享，判断写事务是否进行中。 */
/**
 * 进程内「正在写」的键集合：写侧负责增删，切片侧只读判断（`has`）。
 * 对外导出成 `ReadonlySet` 就是为了把这条归属写在类型上——跨模块只读不能靠约定。
 */
const activeKeys = new Set<string>()
export const active: ReadonlySet<string> = activeKeys
const busy = (): ModuleWriteError => new ModuleWriteError('模块保存或恢复正在进行，请重试', 409, 'rules-conflict')

/** 活 PID 永不按超时夺锁；每个进程文件有唯一 token，回收死锁不会误删新持有者。 */
export function processLocks(directory: string, own?: string, recover = false): boolean {
  const locks = lockDirectory(directory)
  let names: string[]
  try { assertPlain(locks, true); names = readdirSync(locks) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  let occupied = false
  for (const name of names) {
    if (name === own) continue
    const match = /^([1-9][0-9]*)-([a-f0-9-]{36})\.lock$/.exec(name)
    if (!match) throw new ModuleWriteError('模块锁目录含未知文件，拒绝自动清理', 409, 'rules-conflict')
    const path = join(locks, name)
    try { assertPlain(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    let live = true
    try { process.kill(Number(match[1]), 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') live = false }
    if (live) occupied = true
    else if (recover) rmSync(path, { force: true })
  }
  return occupied
}

/** 保存与目录安装共享 root/id 锁；目标可以尚未创建或暂时位于交换备份。 */
export function withModuleLock<T>(root: string, id: string, action: () => T): T {
  assertModuleId(id)
  const dir = join(canonicalModulesRoot(root), id), key = directoryKey(dir)
  if (active.has(key)) throw busy()
  const locks = lockDirectory(dir)
  const token = process.pid + '-' + randomUUID() + '.lock'
  const file = join(locks, token)
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(locks, { recursive: true })
      assertPlain(locks, true)
      writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', encoding: 'utf8' })
      break
    } catch (error) {
      // 其他持有者刚释放空目录；未创建 token 时安全重试，绝不递归删除锁目录。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt === 2) throw error
    }
  }
  try {
    if (processLocks(dir, token, true)) throw busy()
    activeKeys.add(key)
    return action()
  } finally {
    activeKeys.delete(key)
    rmSync(file, { force: true })
    try { rmdirSync(locks) } catch { /* 并发 token 或未知文件留下目录，不扩大清理范围。 */ }
  }
}

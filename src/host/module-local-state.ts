import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertPlain, canonicalDirectory, ModuleWriteError, record, revisionOf } from './module-write.ts'
import { RULES_DIR, RULES_SETTINGS_FILE, RULES_VARIABLES_FILE } from './paths.ts'
import { atomicWriteTextFile } from './text-file.ts'
import { assertRuleId } from '../../engine/rule-spec.mjs'
import { moduleDirectoryIdentity } from './module-install.ts'

export const MODULE_LOCAL_COMMIT_FILE = '_commit.json'
export const MODULE_LOCAL_INITIALIZED_FILE = '.prompt-tool-local-v1'
const OBJECTS_DIR = '.objects'
const VERSION = 1
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export interface ModuleLocalReferences {
  moduleId: string
  declaredKeys: string[]
  exportBase: string
  inputs: string
  ruleIds: string[]
  members: Record<string, string>
  hasSourceAliases?: true
  aliasRuleIds?: string[]
  hasProcessRules?: boolean
}

export interface ModuleLocalCommit extends ModuleLocalReferences {
  version: typeof VERSION
  generation: string
  previous?: string
}

function invalid(part: string): ModuleWriteError {
  return new ModuleWriteError(`本地模块提交无效：${part}`)
}

function present(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function list(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string') && new Set(value).size === value.length
}

function generation(references: ModuleLocalReferences): string {
  const { moduleId, declaredKeys, exportBase, inputs, ruleIds, members, hasSourceAliases, hasProcessRules, aliasRuleIds } = references
  return revisionOf(JSON.stringify({ version: VERSION, moduleId, declaredKeys, exportBase, inputs, ruleIds, members, hasSourceAliases, hasProcessRules, aliasRuleIds }))
}

function assertCommit(directory: string, value: unknown): asserts value is ModuleLocalCommit {
  if (!record(value) || value.version !== VERSION) throw invalid('version')
  if (value.moduleId !== basename(directory)) throw invalid('moduleId')
  if (!list(value.declaredKeys) || !digest(value.exportBase) || !digest(value.inputs)) throw invalid('inputs')
  const members = value.members
  const ruleIds = value.ruleIds
  if (!list(ruleIds) || new Set(ruleIds.map(id => id.toLowerCase())).size !== ruleIds.length
    || !record(members)) throw invalid('members')
  for (const id of ruleIds) assertRuleId(id)
  const files = [RULES_SETTINGS_FILE, RULES_VARIABLES_FILE, ...ruleIds.map(id => `${id}.yml`)]
  if (new Set(files).size !== files.length || Object.keys(members).length !== files.length
    || files.some(file => !Object.hasOwn(members, file) || !digest(members[file]))) throw invalid('members')
  if (value.previous !== undefined && !digest(value.previous)) throw invalid('previous')
  if (value.hasSourceAliases !== undefined && value.hasSourceAliases !== true) throw invalid('hasSourceAliases')
  if (value.aliasRuleIds !== undefined) {
    if (value.hasSourceAliases !== true || !list(value.aliasRuleIds)) throw invalid('aliasRuleIds')
    for (const id of value.aliasRuleIds) assertRuleId(id)
  }
  if (value.hasProcessRules !== undefined && typeof value.hasProcessRules !== 'boolean') throw invalid('hasProcessRules')
  if (value.generation !== generation(value as unknown as ModuleLocalReferences)) throw invalid('generation')
}

function parseCommit(directory: string, text: string): ModuleLocalCommit {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw invalid('JSON') }
  assertCommit(directory, value)
  return value
}

const commitCache = new Map<string, { text: string; commit: ModuleLocalCommit }>()
const MAX_CACHED_COMMITS = 8
const MAX_CACHED_COMMIT_LENGTH = 2 * 1024 * 1024

function freezeCommit(value: object): void {
  const pending = [value]
  while (pending.length) {
    const next = pending.pop()!
    for (const child of Object.values(next)) if (child !== null && typeof child === 'object') pending.push(child)
    Object.freeze(next)
  }
}

/** 读取一次原子指针。只在尚无提交时返回 undefined，坏提交由调用方诊断。 */
export function readModuleLocalCommit(directory: string): ModuleLocalCommit | undefined {
  const dir = canonicalDirectory(directory)
  const rules = join(dir, RULES_DIR)
  const file = join(rules, MODULE_LOCAL_COMMIT_FILE)
  if (present(rules)) assertPlain(rules, true)
  if (!present(file)) {
    const marker = join(dir, MODULE_LOCAL_INITIALIZED_FILE)
    if (present(marker)) throw invalid('已初始化模块缺少提交记录')
    return undefined
  }
  assertPlain(file)
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file))
  const cached = commitCache.get(dir)
  if (cached?.text === text) return cached.commit
  const commit = parseCommit(dir, text)
  freezeCommit(commit)
  commitCache.delete(dir)
  if (text.length <= MAX_CACHED_COMMIT_LENGTH) {
    if (commitCache.size >= MAX_CACHED_COMMITS) commitCache.delete(commitCache.keys().next().value!)
    commitCache.set(dir, { text, commit })
  }
  return commit
}

/** 记录已完成首次提交；放在模块根，整个 rules/ 被意外删除时也能诊断。 */
export function markModuleLocalInitialized(directory: string): void {
  const file = join(canonicalDirectory(directory), MODULE_LOCAL_INITIALIZED_FILE)
  if (present(file)) {
    assertPlain(file)
    if (readFileSync(file, 'utf8') !== `${VERSION}\n`) throw invalid('初始化标记')
  } else atomicWriteTextFile(file, `${VERSION}\n`)
}

function objectPath(directory: string, hash: string): string {
  if (!digest(hash)) throw invalid('object digest')
  const rules = join(canonicalDirectory(directory), RULES_DIR)
  assertPlain(rules, true)
  const objects = join(rules, OBJECTS_DIR)
  assertPlain(objects, true)
  return join(objects, hash)
}

export function readModuleLocalObject(directory: string, hash: string): string {
  const file = objectPath(directory, hash)
  assertPlain(file)
  const bytes = readFileSync(file)
  if (revisionOf(bytes) !== hash) throw invalid(`object ${hash}`)
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

/** 批量打开成员，返回前复核所有祖先仍是同一个普通目录。 */
export interface VerifiedModuleObjects {
  identity: string
  members: Map<string, { stamp: string; text: string }>
  changed: Set<string>
}

/** 只保留最近核验模块的身份及成员戳，不保留正文或历史代。 */
const objectProofs = new Map<string, { identity: string; stamps: Map<string, string> }>()
const MAX_PROOF_MODULES = 8
const MAX_PROOF_OBJECTS = 16_384

function verifyObjects(directory: string, hashes: readonly string[], readText: boolean, previous?: VerifiedModuleObjects): VerifiedModuleObjects {
  const dir = canonicalDirectory(directory)
  const rules = join(dir, RULES_DIR), objects = join(rules, OBJECTS_DIR)
  const paths = [dirname(dir), dir, rules, objects]
  const identity = paths.map(moduleDirectoryIdentity)
  if (identity.some(value => value === undefined)) throw invalid('objects')
  const owner = identity.join('|')
  const priorProof = objectProofs.get(dir)
  const stamps = new Map<string, string>()
  const members: VerifiedModuleObjects['members'] = new Map()
  const changed = new Set<string>()
  for (const hash of hashes) {
    if (stamps.has(hash)) continue
    if (!digest(hash)) throw invalid('object digest')
    const file = join(objects, hash)
    const stampOf = (): string => {
      const stat = lstatSync(file, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink()) throw invalid(`object path ${hash}`)
      return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`
    }
    const stamp = stampOf()
    stamps.set(hash, stamp)
    const cached = previous?.identity === owner ? previous.members.get(hash) : undefined
    if (cached?.stamp === stamp) { members.set(hash, cached); continue }
    if (!readText && priorProof?.identity === owner && priorProof.stamps.get(hash) === stamp) continue
    const bytes = readFileSync(file)
    if (revisionOf(bytes) !== hash || stampOf() !== stamp) throw invalid(`object ${hash}`)
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (readText) members.set(hash, { stamp, text })
    changed.add(hash)
  }
  if (paths.some((path, i) => moduleDirectoryIdentity(path) !== identity[i])) throw invalid('objects directory changed')
  // 局部读取替换缓存证明，额外保留导出基底等未读成员。完整校验会收掉旧代。
  if (readText && priorProof?.identity === owner) {
    for (const [hash, stamp] of priorProof.stamps) {
      if (stamps.size >= MAX_PROOF_OBJECTS) break
      if (!stamps.has(hash)) stamps.set(hash, stamp)
    }
  }
  objectProofs.delete(dir)
  if (stamps.size <= MAX_PROOF_OBJECTS) objectProofs.set(dir, { identity: owner, stamps })
  if (objectProofs.size > MAX_PROOF_MODULES) objectProofs.delete(objectProofs.keys().next().value!)
  return { identity: owner, members, changed }
}

export function readModuleLocalObjects(directory: string, hashes: readonly string[], previous?: VerifiedModuleObjects): VerifiedModuleObjects {
  return verifyObjects(directory, hashes, true, previous)
}

export function verifyModuleLocalGeneration(directory: string, commit: ModuleLocalReferences): void {
  verifyObjects(directory, [commit.exportBase, commit.inputs, ...Object.values(commit.members)], false)
}

export function readPreviousModuleLocalCommit(directory: string, commit: ModuleLocalCommit): ModuleLocalCommit | undefined {
  if (commit.previous === undefined) return undefined
  return parseCommit(canonicalDirectory(directory), readModuleLocalObject(directory, commit.previous))
}

/** 写者持有模块锁或拥有私有安装候选。旧提交仍可并发读取其不可变成员。 */
export function writeModuleLocalObject(directory: string, content: string): string {
  const rules = join(canonicalDirectory(directory), RULES_DIR)
  if (!present(rules)) mkdirSync(rules)
  assertPlain(rules, true)
  const objects = join(rules, OBJECTS_DIR)
  if (!present(objects)) mkdirSync(objects)
  const hash = revisionOf(content)
  const file = objectPath(directory, hash)
  if (present(file)) readModuleLocalObject(directory, hash)
  else atomicWriteTextFile(file, content)
  return hash
}

/** 调用方先验证整份候选；通过本模块写入的所有对象落盘后才发布引用。 */
export function publishModuleLocalCommit(directory: string, references: ModuleLocalReferences, beforePublish?: () => void): ModuleLocalCommit {
  const dir = canonicalDirectory(directory)
  const next = generation(references)
  const previous = readModuleLocalCommit(dir)
  if (previous?.generation === next) {
    verifyModuleLocalGeneration(dir, previous)
    return previous
  }
  const commit: ModuleLocalCommit = { ...references, version: VERSION, generation: next }
  assertCommit(dir, commit)
  if (previous !== undefined) commit.previous = writeModuleLocalObject(dir, JSON.stringify(previous))
  const file = join(dir, RULES_DIR, MODULE_LOCAL_COMMIT_FILE)
  assertPlain(join(dir, RULES_DIR), true)
  if (present(file)) assertPlain(file)
  atomicWriteTextFile(file, JSON.stringify(commit) + '\n', { beforeReplace: () => {
    beforePublish?.()
    verifyModuleLocalGeneration(dir, commit)
  } })
  if (previous === undefined) markModuleLocalInitialized(dir)
  return commit
}

export function writeModuleLocalCommit(directory: string, candidate: Omit<ModuleLocalReferences, 'members'> & { files: Record<string, string> }, beforePublish?: () => void): ModuleLocalCommit {
  const { files, exportBase, inputs, ...metadata } = candidate
  const write = (text: string) => writeModuleLocalObject(directory, text)
  return publishModuleLocalCommit(directory, { ...metadata, exportBase: write(exportBase), inputs: write(inputs),
    members: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, write(text)])) }, beforePublish)
}

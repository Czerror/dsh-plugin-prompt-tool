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

type Pointer = { version: 2; moduleId: string; generation: string } & (
  { base: string } | { parent: string; id: string; hash: string }
)
type CommitIndex = {
  token: string
  base: ModuleLocalCommit
  generation: string
  previous?: string
  members: Record<string, string>
  positions: Map<string, number>
  aliases: Set<string>
  snapshot?: ModuleLocalCommit
}
const indexes = new Map<string, { identity: string; index: CommitIndex }>()
const MAX_INDEXES = 8
const MAX_INDEXED_RULES = 16_384

function deltaGeneration(moduleId: string, parent: string, id: string, hash: string): string {
  return revisionOf(JSON.stringify([2, moduleId, parent, id, hash]))
}

function parsePointer(dir: string, text: string): Pointer | ModuleLocalCommit {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw invalid('JSON') }
  if (record(value) && value.version === 2) {
    if (value.moduleId !== basename(dir) || !digest(value.generation)) throw invalid('pointer')
    if (Object.hasOwn(value, 'base')) {
      if (Object.keys(value).length !== 4 || !digest(value.base)) throw invalid('baseline')
      return value as Pointer
    }
    if (Object.keys(value).length !== 6 || !digest(value.parent) || typeof value.id !== 'string' || !digest(value.hash)) throw invalid('delta')
    assertRuleId(value.id)
    if (deltaGeneration(value.moduleId, value.parent, value.id, value.hash) !== value.generation) throw invalid('delta generation')
    return value as Pointer
  }
  assertCommit(dir, value)
  return value
}

function freezeCommit(value: object): void {
  const pending = [value]
  while (pending.length) {
    const next = pending.pop()!
    for (const child of Object.values(next)) if (child !== null && typeof child === 'object') pending.push(child)
    Object.freeze(next)
  }
}

function readPointerText(dir: string): string | undefined {
  const rules = join(dir, RULES_DIR)
  const file = join(rules, MODULE_LOCAL_COMMIT_FILE)
  if (present(rules)) assertPlain(rules, true)
  if (!present(file)) {
    const marker = join(dir, MODULE_LOCAL_INITIALIZED_FILE)
    if (present(marker)) throw invalid('已初始化模块缺少提交记录')
    return undefined
  }
  assertPlain(file)
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file))
}

function indexAt(dir: string, text: string, cached?: CommitIndex): CommitIndex {
  let token = revisionOf(text)
  let pointer = parsePointer(dir, text)
  const deltas: Array<{ token: string; delta: Pointer & { parent: string; id: string; hash: string } }> = []
  while (cached?.token !== token && pointer.version === 2 && 'parent' in pointer) {
    deltas.push({ token, delta: pointer })
    token = pointer.parent
    if (cached?.token === token) break
    pointer = parsePointer(dir, readModuleLocalObject(dir, token))
  }
  let index = cached?.token === token ? cached : undefined
  if (index === undefined) {
    const base = pointer.version === 1 ? pointer : 'base' in pointer
      ? parseCommit(dir, readModuleLocalObject(dir, pointer.base))
      : undefined
    if (!base || base.generation !== pointer.generation) throw invalid('baseline generation')
    freezeCommit(base)
    index = {
      token, base, generation: base.generation, previous: base.previous, members: { ...base.members },
      positions: new Map(base.ruleIds.map((id, position) => [id, position])), aliases: new Set(base.aliasRuleIds),
    }
  }
  for (const { delta } of deltas) if (!index.positions.has(delta.id)) throw invalid('delta rule')
  for (let i = deltas.length - 1; i >= 0; i--) {
    const { token: current, delta } = deltas[i]!
    index.members[`${delta.id}.yml`] = delta.hash
    index.token = current
    index.generation = delta.generation
    index.previous = delta.parent
    index.snapshot = undefined
  }
  return index
}

function currentIndex(dir: string, text: string): CommitIndex {
  const paths = [dir, join(dir, RULES_DIR), join(dir, RULES_DIR, OBJECTS_DIR)]
  const stamps = paths.map(moduleDirectoryIdentity)
  if (stamps.some(stamp => stamp === undefined)) throw invalid('directory changed')
  const identity = stamps.join('|')
  const token = revisionOf(text)
  const entry = indexes.get(dir)
  const cached = entry?.identity === identity ? entry.index : undefined
  const index = cached?.token === token ? cached : indexAt(dir, text, cached)
  if (paths.some((path, i) => moduleDirectoryIdentity(path) !== stamps[i])) throw invalid('directory changed')
  indexes.delete(dir)
  if (index.base.ruleIds.length <= MAX_INDEXED_RULES) indexes.set(dir, { identity, index })
  if (indexes.size > MAX_INDEXES) indexes.delete(indexes.keys().next().value!)
  return index
}

function snapshot(index: CommitIndex): ModuleLocalCommit {
  return index.snapshot ??= Object.freeze({
    ...index.base, generation: index.generation, previous: index.previous, members: Object.freeze({ ...index.members }),
  })
}

/** 读取一次原子指针。只在尚无提交时返回 undefined，坏提交由调用方诊断。 */
export function readModuleLocalCommit(directory: string): ModuleLocalCommit | undefined {
  const dir = canonicalDirectory(directory)
  const text = readPointerText(dir)
  return text === undefined ? undefined : snapshot(currentIndex(dir, text))
}

export function readModuleLocalCommitInfo(directory: string): Pick<ModuleLocalCommit, 'generation' | 'hasProcessRules' | 'moduleId' | 'inputs' | 'declaredKeys'> | undefined {
  const dir = canonicalDirectory(directory)
  const text = readPointerText(dir)
  if (text === undefined) return undefined
  const index = currentIndex(dir, text)
  const { moduleId, inputs, declaredKeys, hasProcessRules } = index.base
  return { generation: index.generation, moduleId, inputs, declaredKeys, hasProcessRules }
}

export interface ModuleEditHead {
  moduleId: string
  generation: string
  inputs: string
  declaredKeys: string[]
  settingsHash: string
  ruleHash?: string
  ruleIndex?: number
  hasRuleAliases: boolean
}
const handles = new WeakMap<ModuleEditHead, { dir: string; identity: string; text: string; token: string; id: string }>()

export function readModuleEditHead(directory: string, id: string): ModuleEditHead | undefined {
  assertRuleId(id)
  const dir = canonicalDirectory(directory)
  const identity = moduleDirectoryIdentity(dir)
  const text = readPointerText(dir)
  if (text === undefined) return undefined
  const index = currentIndex(dir, text)
  if (identity === undefined || moduleDirectoryIdentity(dir) !== identity) throw invalid('directory changed')
  const head: ModuleEditHead = Object.freeze({
    moduleId: index.base.moduleId, generation: index.generation, inputs: index.base.inputs,
    declaredKeys: index.base.declaredKeys, settingsHash: index.members[RULES_SETTINGS_FILE]!,
    ruleHash: index.positions.has(id) ? index.members[`${id}.yml`] : undefined,
    ruleIndex: index.positions.get(id),
    hasRuleAliases: index.base.hasSourceAliases === true && (index.base.aliasRuleIds === undefined || index.aliases.has(id)),
  })
  handles.set(head, { dir, identity, text, token: index.token, id })
  return head
}

/** 调用方持有模块锁并已验证目标规则及其跨规则约束。 */
export function publishModuleRuleEdit(directory: string, head: ModuleEditHead, id: string, hash: string, beforePublish?: () => void): { generation: string } {
  const dir = canonicalDirectory(directory)
  const handle = handles.get(head)
  if (handle?.dir !== dir || handle.id !== id || head.ruleHash === undefined || !digest(hash)) throw invalid('edit head')
  const assertCurrent = () => {
    if (readPointerText(dir) !== handle.text || moduleDirectoryIdentity(dir) !== handle.identity) {
      throw new ModuleWriteError('写入前模块再次变化，请重新读取', 409, 'rules-conflict')
    }
  }
  assertCurrent()
  if (hash === head.ruleHash) {
    beforePublish?.()
    assertCurrent()
    return { generation: head.generation }
  }
  readModuleLocalObject(dir, hash)
  const parent = handle.token
  // v1 头原本没有对象副本。首次紧凑提交把它保存为不可变基线。
  const parentFile = objectPath(dir, parent)
  if (present(parentFile)) assertPlain(parentFile)
  else writeModuleLocalObject(dir, handle.text)
  const generation = deltaGeneration(head.moduleId, parent, id, hash)
  const text = JSON.stringify({ version: 2, moduleId: head.moduleId, generation, parent, id, hash }) + '\n'
  writeModuleLocalObject(dir, text)
  atomicWriteTextFile(join(dir, RULES_DIR, MODULE_LOCAL_COMMIT_FILE), text, { beforeReplace: () => {
    beforePublish?.()
    assertCurrent()
  } })
  return { generation }
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

export function moduleLocalObjectStamp(directory: string, hash: string): string {
  const stat = lstatSync(objectPath(directory, hash), { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalid(`object path ${hash}`)
  return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`
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
  const dir = canonicalDirectory(directory)
  return snapshot(indexAt(dir, readModuleLocalObject(dir, commit.previous)))
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
  const previousText = readPointerText(dir)
  const previous = previousText === undefined ? undefined : snapshot(currentIndex(dir, previousText))
  if (previous?.generation === next) {
    verifyModuleLocalGeneration(dir, previous)
    return previous
  }
  const commit: ModuleLocalCommit = { ...references, version: VERSION, generation: next }
  assertCommit(dir, commit)
  if (previousText !== undefined) commit.previous = writeModuleLocalObject(dir, previousText)
  const file = join(dir, RULES_DIR, MODULE_LOCAL_COMMIT_FILE)
  assertPlain(join(dir, RULES_DIR), true)
  if (present(file)) assertPlain(file)
  const base = writeModuleLocalObject(dir, JSON.stringify(commit))
  const text = JSON.stringify({ version: 2, moduleId: commit.moduleId, generation: next, base }) + '\n'
  writeModuleLocalObject(dir, text)
  atomicWriteTextFile(file, text, { beforeReplace: () => {
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

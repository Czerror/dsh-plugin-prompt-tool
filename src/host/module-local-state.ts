import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { assertPlain, canonicalDirectory, ModuleWriteError, record, revisionOf } from './module-write.ts'
import { RULES_DIR, RULES_SETTINGS_FILE, RULES_VARIABLES_FILE } from './paths.ts'
import { atomicWriteTextFile } from './text-file.ts'
import { assertRuleId } from '../../engine/rule-spec.mjs'

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
  const { moduleId, declaredKeys, exportBase, inputs, ruleIds, members } = references
  return revisionOf(JSON.stringify({ version: VERSION, moduleId, declaredKeys, exportBase, inputs, ruleIds, members }))
}

function assertCommit(directory: string, value: unknown): asserts value is ModuleLocalCommit {
  if (!record(value) || value.version !== VERSION) throw invalid('version')
  if (value.moduleId !== basename(directory)) throw invalid('moduleId')
  if (!list(value.declaredKeys) || !digest(value.exportBase) || !digest(value.inputs)) throw invalid('inputs')
  const members = value.members
  if (!list(value.ruleIds) || new Set(value.ruleIds.map(id => id.toLowerCase())).size !== value.ruleIds.length
    || !record(members)) throw invalid('members')
  for (const id of value.ruleIds) assertRuleId(id)
  const files = [RULES_SETTINGS_FILE, RULES_VARIABLES_FILE, ...value.ruleIds.map(id => `${id}.yml`)]
  if (new Set(files).size !== files.length || Object.keys(members).length !== files.length
    || files.some(file => !Object.hasOwn(members, file) || !digest(members[file]))) throw invalid('members')
  if (value.previous !== undefined && !digest(value.previous)) throw invalid('previous')
  if (value.generation !== generation(value as unknown as ModuleLocalReferences)) throw invalid('generation')
}

function parseCommit(directory: string, text: string): ModuleLocalCommit {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw invalid('JSON') }
  assertCommit(directory, value)
  return value
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
  return parseCommit(dir, readFileSync(file, 'utf8'))
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
export function publishModuleLocalCommit(directory: string, references: ModuleLocalReferences): ModuleLocalCommit {
  const dir = canonicalDirectory(directory)
  const next = generation(references)
  const previous = readModuleLocalCommit(dir)
  if (previous?.generation === next) return previous
  const commit: ModuleLocalCommit = { ...references, version: VERSION, generation: next }
  assertCommit(dir, commit)
  if (commit.exportBase !== previous?.exportBase) readModuleLocalObject(dir, commit.exportBase)
  if (commit.inputs !== previous?.inputs) readModuleLocalObject(dir, commit.inputs)
  for (const [name, hash] of Object.entries(commit.members)) {
    if (hash !== previous?.members[name]) readModuleLocalObject(dir, hash)
  }
  if (previous !== undefined) commit.previous = writeModuleLocalObject(dir, JSON.stringify(previous))
  const file = join(dir, RULES_DIR, MODULE_LOCAL_COMMIT_FILE)
  assertPlain(join(dir, RULES_DIR), true)
  if (present(file)) assertPlain(file)
  atomicWriteTextFile(file, JSON.stringify(commit) + '\n')
  if (previous === undefined) markModuleLocalInitialized(dir)
  return commit
}

export function writeModuleLocalCommit(directory: string, candidate: Omit<ModuleLocalReferences, 'members'> & { files: Record<string, string> }): ModuleLocalCommit {
  const { files, exportBase, inputs, ...metadata } = candidate
  const write = (text: string) => writeModuleLocalObject(directory, text)
  return publishModuleLocalCommit(directory, { ...metadata, exportBase: write(exportBase), inputs: write(inputs),
    members: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, write(text)])) })
}

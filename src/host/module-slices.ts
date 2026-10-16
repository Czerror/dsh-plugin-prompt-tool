/**
 * 本文件拥有**模块定义读写与规则切片投影**：完整定义是唯一提交点；切片仅从有效定义恢复，全部校验后才发布快照。
 *
 * 写事务原语（锁、版本摘要、共享引用守卫、错误协议）来自 `module-write.ts`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Document, parseDocument } from 'yaml'
import type { RuleContent, RuleDefinition, RuleRevisions, RuleSettings } from '../shared/rules.ts'
import { readPersonaSpec } from '../shared/persona-section.ts'
import { assertModuleDirectory } from './module-install.ts'
import { active, assertPlain, assertUnownedUnchanged, canonicalDirectory, directoryKey, ModuleWriteError, moduleLocation, processLocks, record, revisionOf, withModuleLock } from './module-write.ts'
import { MODULE_DEFINITION_FILE, RULES_DIR, RULES_SETTINGS_FILE, RULES_VARIABLES_FILE } from './paths.ts'
import { atomicTemporaryTarget, atomicWriteTextFile } from './text-file.ts'
import { readModuleLayerSettings } from './module-layer-settings.ts'
// 引擎是规则语义的唯一校验器。
import { assertRuleId, compileRules } from '../../engine/rule-spec.mjs'
// 保留名由插值器的内建与动态宏目录共同定义。
import { isReservedInterpolationName } from '../../engine/interpolate.mjs'

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  return record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
}
const digest = (value: unknown): string => revisionOf(JSON.stringify(stable(value)))
const yaml = (value: unknown): string => new Document(value).toString()

/** 两级持久变量共用边界；错误只标识键，不输出变量内容。 */
export function assertVariableValues(value: unknown): asserts value is Record<string, string> {
  if (!record(value)) throw new ModuleWriteError('variables 必须是平铺字符串对象')
  const entries = Object.entries(value)
  if (entries.length > 4096) throw new ModuleWriteError('variables 最多允许 4096 个键')
  let bytes = 0
  for (const [key, item] of entries) {
    if (typeof item !== 'string') throw new ModuleWriteError('variables 必须是平铺字符串对象')
    if (key.length === 0 || key !== key.trim() || Buffer.byteLength(key) > 256
      || ['__proto__', 'constructor', 'prototype'].includes(key) || isReservedInterpolationName(key)) throw new ModuleWriteError(`变量名非法或保留：${key}`)
    const size = Buffer.byteLength(item)
    if (size > 1024 * 1024) throw new ModuleWriteError(`变量值超过 1 MiB：${key}`)
    bytes += Buffer.byteLength(key) + size
  }
  if (bytes > 4 * 1024 * 1024) throw new ModuleWriteError('variables 总量超过 4 MiB')
}

/** 文件身份校验不依赖操作系统是否区分大小写。 */
export function assertRuleFileId(id: unknown): asserts id is string {
  assertRuleId(id)
  if (typeof id !== 'string' || id.startsWith('_') || id.toLowerCase() === 'variables'
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id) || /[. ]$/.test(id)) throw new ModuleWriteError(`规则标识是保留文件名：${String(id)}`)
}

/**
 * module.yml 的形状校验：**只拒绝结构错误**，旧内容按白名单加载。
 *
 * 旧格式（`promptConfigs` / `triggers` / 退役引擎名 / 旧规则快捷键 / 旧模型键）不再阻断加载：
 * 定义照常读取，未注册的参数由 `readModuleLayerSettings` 的键白名单过滤，旧内容不参与执行。
 * 语法迁移不在产品内提供——用户自行改写 `rules`，或交给内置技能由模型完成。
 */
export function assertCanonicalRuleSource(source: unknown): asserts source is Record<string, unknown> {
  if (!record(source)) throw new ModuleWriteError('module.yml 必须是对象')
  if (source.rules !== undefined && !Array.isArray(source.rules)) throw new ModuleWriteError('module.yml.rules 必须是数组')
  const retired = ['character-tools', 'world-book-tools', 'session-var-tools']
  const names = [...(Array.isArray(source.modules) ? source.modules : []), ...Object.keys(record(source.moduleConfigs) ? source.moduleConfigs : {})]
  if (names.some(name => retired.includes(String(name)))) throw new ModuleWriteError('旧角色/世界书/会话变量能力已退役；请重新导入或显式转换为模块工具')
}

export function rulePromptConfigOptions(directory: string, strategy?: unknown) {
  const templateBaseUrl = pathToFileURL(join(directory, MODULE_DEFINITION_FILE))
  const strategyDir = typeof strategy !== 'string' || strategy.length === 0 ? undefined
    : isAbsolute(strategy) ? pathToFileURL(strategy).href : new URL(strategy, templateBaseUrl).href
  return { templateBaseUrl, templateModuleRoot: pathToFileURL(directory.replace(/[\\/]?$/, '/')), strategyDir }
}

export interface ModuleDefinitionSnapshot {
  dir: string
  file: string
  text: string
  doc: ReturnType<typeof parseDocument>
  source: Record<string, unknown>
  revision: string
  revisions: RuleRevisions
  rules: RuleDefinition[]
  configOrder: Record<string, number>
  variables: Record<string, string>
  variablesEnabled: boolean
}
interface Projection {
  contents: RuleContent[]
  settings: Record<string, RuleSettings>
  variables: Record<string, string>
  variablesEnabled: boolean
  revisions: RuleRevisions
  files: Record<string, string>
}
export interface ModuleDefinitionValidationOptions {
  /** 交换预览只从已提供的文件集合读取模板，禁止回退访问真实目标目录。 */
  loadTemplate?: (file: unknown) => unknown
}

function projection(source: Record<string, unknown>, directory: string, sourceRevision: string, validation: ModuleDefinitionValidationOptions = {}): Projection {
  assertCanonicalRuleSource(source)
  const rules = (source.rules ?? []) as RuleDefinition[]
  const seen = new Set<string>()
  for (const rule of rules) {
    if (!record(rule)) throw new ModuleWriteError('规则必须是对象')
    assertRuleFileId(rule.id)
    const key = rule.id.toLowerCase()
    if (seen.has(key)) throw new ModuleWriteError(`规则文件名重复或大小写冲突：${rule.id}`)
    seen.add(key)
  }
  if (source.configOrder !== undefined && !record(source.configOrder)) throw new ModuleWriteError('configOrder 必须是对象')
  const order = (source.configOrder ?? {}) as Record<string, number>
  for (const [id, sequence] of Object.entries(order)) {
    assertRuleFileId(id)
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new ModuleWriteError(`规则 ${id} 的顺序必须是非负安全整数`)
  }
  if (source.variables !== undefined) assertVariableValues(source.variables)
  if (source.variablesEnabled !== undefined && typeof source.variablesEnabled !== 'boolean') throw new ModuleWriteError('variablesEnabled 必须是布尔值')
  if (source.stWorldBookRecursive !== undefined) throw new ModuleWriteError('stWorldBookRecursive 已退役；请重新导入或显式转换为 contextActivationRecursive')
  if (source.contextActivationRecursive !== undefined && typeof source.contextActivationRecursive !== 'boolean') throw new ModuleWriteError('contextActivationRecursive 必须是布尔值')
  const variables = structuredClone((source.variables ?? {}) as Record<string, string>)
  const variablesEnabled = source.variablesEnabled !== false
  const configs = record(source.moduleConfigs) ? source.moduleConfigs : {}
  const options = record(configs['rule-engine']) ? configs['rule-engine'] : {}
  let persona: ReturnType<typeof readPersonaSpec>
  try {
    persona = readPersonaSpec(source.persona)
    compileRules(rules, { moduleId: basename(directory), configOrder: order, variables, variablesEnabled,
      promptConfigOptions: { ...rulePromptConfigOptions(directory, options.strategyDir), ...(validation.loadTemplate === undefined ? {} : { loadTemplate: validation.loadTemplate }) } })
  } catch (error) { throw new ModuleWriteError(String((error as Error).message ?? error)) }
  const contents: RuleContent[] = []
  const settings: Record<string, RuleSettings> = Object.create(null)
  const files: Record<string, string> = Object.create(null)
  const ruleRevisions: Record<string, string> = Object.create(null)
  let tail = Math.max(-10, ...Object.values(order)) + 10
  for (const rule of rules) {
    const { enabled, group, exclusive, ...content } = structuredClone(rule)
    contents.push(content)
    const sequence = order[rule.id] ?? tail
    if (order[rule.id] === undefined) tail += 10
    if (!Number.isSafeInteger(sequence)) throw new ModuleWriteError('规则顺序超出安全整数范围')
    settings[rule.id] = { order: sequence, ...(enabled === undefined ? {} : { enabled }), ...(group === undefined ? {} : { group }), ...(exclusive === undefined ? {} : { exclusive }) }
    files[`${rule.id}.yml`] = yaml(content)
    ruleRevisions[rule.id] = digest(content)
  }
  files[RULES_VARIABLES_FILE] = yaml(variables)
  const state = { rules: settings, variablesEnabled }
  const revisions: RuleRevisions = { rules: ruleRevisions, settings: digest(state), variables: digest(variables) }
  // 人设投影受完整源版本与文件一致性校验保护，不占用规则状态的 CAS 版本。
  files[RULES_SETTINGS_FILE] = yaml({ ...state, ...(persona === undefined ? {} : { persona }), _integrity: { version: 1, module: sourceRevision, files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, revisionOf(text)])), settings: revisions.settings } })
  return { contents, settings, variables, variablesEnabled, revisions, files }
}

function snapshotFromText(dir: string, text: string, validation: ModuleDefinitionValidationOptions = {}): ModuleDefinitionSnapshot {
  const doc = parseDocument(text, { logLevel: 'silent' })
  if (doc.errors.length > 0) throw new ModuleWriteError(`模块 YAML 无法解析：${doc.errors[0]!.message}`)
  const source: unknown = doc.toJS()
  assertCanonicalRuleSource(source)
  if (source.id !== undefined && source.id !== basename(dir)) throw new ModuleWriteError('模块定义身份不匹配')
  readModuleLayerSettings(source)
  const revision = revisionOf(text)
  const projected = projection(source, dir, revision, validation)
  const configOrder = Object.fromEntries(Object.entries(projected.settings).map(([id, settings]) => [id, settings.order]))
  const rules = projected.contents.map(content => { const { order: _order, ...settings } = projected.settings[content.id]!; return { ...content, ...settings } }).sort((left, right) => configOrder[left.id]! - configOrder[right.id]!)
  return { dir, file: join(dir, MODULE_DEFINITION_FILE), text, doc, source, revision, revisions: projected.revisions, rules, configOrder, variables: projected.variables, variablesEnabled: projected.variablesEnabled }
}

/** 导入、预览与规则 validateOnly 复用同一完整定义校验，不访问或写入切片。 */
export const validateModuleDefinitionText = (directory: string, text: string, options: ModuleDefinitionValidationOptions = {}): ModuleDefinitionSnapshot => snapshotFromText(directory, text, options)

/** 纯读完整源；无效源绝不会触发分解或恢复。 */
export function loadModuleDefinition(directory: string): ModuleDefinitionSnapshot {
  let dir: string
  try { const canonical = canonicalDirectory(directory); dir = assertModuleDirectory(dirname(canonical), basename(canonical)) }
  catch (error) { throw new ModuleWriteError(String((error as Error).message ?? error)) }
  const bytes = readFileSync(join(dir, MODULE_DEFINITION_FILE))
  return snapshotFromText(dir, new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

function assertSource(snapshot: ModuleDefinitionSnapshot): void {
  if (assertModuleDirectory(dirname(snapshot.dir), basename(snapshot.dir)) !== snapshot.dir || revisionOf(readFileSync(snapshot.file)) !== snapshot.revision) throw new ModuleWriteError('写入前模块再次变化，请重新读取', 409, 'rules-conflict')
}
/** 与 removeInterruptedWrites 同源：只认 atomicWriteTextFile 的精确 UUID 临时名，不是用户素材。 */
function isRulesTemporary(filename: string): boolean {
  const target = atomicTemporaryTarget(filename)
  if (target === undefined) return false
  if (target === RULES_SETTINGS_FILE || target === RULES_VARIABLES_FILE) return true
  if (!target.endsWith('.yml')) return false
  try { assertRuleFileId(target.slice(0, -4)) } catch { return false }
  return true
}

function readProjection(snapshot: ModuleDefinitionSnapshot): Projection {
  const expected = projection(snapshot.source, snapshot.dir, snapshot.revision)
  const dir = join(snapshot.dir, RULES_DIR)
  assertPlain(dir, true)
  // 只认名单内切片：名单外文件不读、不校验，也不参与集合比对。
  const files = readdirSync(dir)
  for (const file of Object.keys(expected.files)) {
    const path = join(dir, file)
    if (!files.includes(file)) throw new ModuleWriteError(`规则切片缺失：${file}`, 409, 'rules-slices-invalid')
    assertPlain(path)
    if (readFileSync(path, 'utf8') !== expected.files[file]) throw new ModuleWriteError(`规则切片与完整定义失配：${file}`, 409, 'rules-slices-invalid')
  }
  // 中断写入残留的临时文件不是用户素材，仍触发恢复路径（清临时名 + 回收死锁目录）。
  if (files.some(isRulesTemporary)) throw new ModuleWriteError('规则目录含中断写入残留', 409, 'rules-slices-invalid')
  assertSource(snapshot)
  return expected
}

/** 纯读且校验三方一致，不补缺、不接纳手改切片。 */
export function readRulesDir(directory: string) {
  const snapshot = loadModuleDefinition(directory)
  const { files: _files, ...result } = readProjection(snapshot)
  result.contents.sort((left, right) => result.settings[left.id]!.order - result.settings[right.id]!.order)
  return result
}

// 仅保留不可变原文；调用方改动 doc/source/rules 不会污染最后已验证快照。
const published = new Map<string, { dir: string; text: string }>()
const publish = (snapshot: ModuleDefinitionSnapshot): void => { published.set(directoryKey(snapshot.dir), { dir: snapshot.dir, text: snapshot.text }) }

/** 运行贡献回退到最后验证通过的定义；路径安全仍现场校验，不接纳坏候选。 */
export function lastPublishedModuleDefinition(directory: string): ModuleDefinitionSnapshot | undefined {
  const dir = canonicalDirectory(directory)
  assertPlain(join(dir, MODULE_DEFINITION_FILE))
  const previous = published.get(directoryKey(dir))
  return previous === undefined ? undefined : snapshotFromText(previous.dir, previous.text)
}

function coordinated<T>(directory: string, action: () => T): T {
  const dir = canonicalDirectory(directory)
  return withModuleLock(dirname(dir), basename(dir), action)
}

/** 只认 atomicWriteTextFile 的精确 UUID 临时名，不碰普通点文件或用户素材。 */
function rootTemporaries(directory: string): string[] {
  return readdirSync(directory).filter(file => atomicTemporaryTarget(file) === MODULE_DEFINITION_FILE)
}
function removeInterruptedWrites(directory: string): void {
  const paths = rootTemporaries(directory).map(file => join(directory, file))
  const rules = join(directory, RULES_DIR)
  if (existsSync(rules)) {
    assertPlain(rules, true)
    for (const file of readdirSync(rules)) {
      if (!isRulesTemporary(file)) continue
      paths.push(join(rules, file))
    }
  }
  for (const path of paths) assertPlain(path)
  for (const path of paths) rmSync(path)
}

/** 旧 _settings.yml 名单里、新名单外的规则切片是插件自己的残留，需清理；其余名单外文件归用户。 */
function removedRuleSlices(dir: string, projected: Projection): string[] {
  const path = join(dir, RULES_SETTINGS_FILE)
  if (!existsSync(path)) return []
  const doc = parseDocument(readFileSync(path, 'utf8'), { logLevel: 'silent' })
  const source: unknown = doc.toJS()
  if (doc.errors.length > 0 || !record(source) || !record(source.rules)) return []
  return Object.keys(source.rules).filter(id => {
    try { assertRuleFileId(id) } catch { return false }
    return !Object.hasOwn(projected.settings, id)
  }).map(id => `${id}.yml`)
}

function writeProjection(snapshot: ModuleDefinitionSnapshot, phase: 'contents' | 'all'): void {
  const projected = projection(snapshot.source, snapshot.dir, snapshot.revision)
  const dir = join(snapshot.dir, RULES_DIR)
  if (existsSync(dir)) assertPlain(dir, true)
  else mkdirSync(dir)
  // 名单外文件归用户所有：不读、不校验、不写、不删；只清理旧名单里已移除的规则切片。
  const removed = phase === 'all' ? removedRuleSlices(dir, projected) : []
  for (const [file, text] of Object.entries(projected.files)) {
    if (phase === 'contents' && file === RULES_SETTINGS_FILE) continue
    const target = join(dir, file)
    if (existsSync(target)) { assertPlain(target); if (readFileSync(target, 'utf8') === text) continue }
    atomicWriteTextFile(target, text, { beforeReplace: () => { assertPlain(dir, true); if (existsSync(target)) assertPlain(target) } })
  }
  if (phase === 'all') for (const file of removed) {
    const target = join(dir, file)
    if (existsSync(target)) { assertPlain(target); rmSync(target) }
  }
}

function recoverCurrent(directory: string): ModuleDefinitionSnapshot {
  const snapshot = loadModuleDefinition(directory)
  removeInterruptedWrites(directory)
  writeProjection(snapshot, 'all')
  readProjection(snapshot)
  publish(snapshot)
  return snapshot
}

/** 有效源变化或切片失配才重切；只读模板仅在内存中投影。 */
export function ensureModuleSlices(directory: string, options: { writable?: boolean; force?: boolean } = {}): ModuleDefinitionSnapshot {
  const dir = moduleLocation(directory), key = directoryKey(dir)
  const inProgress = (): ModuleDefinitionSnapshot | undefined => {
    if (!active.has(key) && !processLocks(dir)) return undefined
    const previous = published.get(key)
    if (previous) return snapshotFromText(previous.dir, previous.text)
    throw new ModuleWriteError('模块尚无已验证快照，保存或恢复正在进行', 409, 'rules-conflict')
  }
  const running = inProgress()
  if (running) return running
  const snapshot = loadModuleDefinition(dir)
  if (options.writable === false) return snapshot
  if (!options.force && rootTemporaries(dir).length === 0) {
    try {
      readProjection(snapshot)
      const writing = inProgress()
      if (writing) return writing
      publish(snapshot)
      return snapshot
    } catch (error) {
      const writing = inProgress()
      if (writing) return writing
      if (error instanceof ModuleWriteError && error.code === 'rules-conflict') throw error
    }
  }
  return coordinated(snapshot.dir, () => {
    // 同步提交在进程内串行；外部源修改在发布前再次复核，最多重读一次。
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return recoverCurrent(snapshot.dir) }
      catch (error) { if (!(error instanceof ModuleWriteError) || error.code !== 'rules-conflict' || attempt === 1) throw error }
    }
    throw new ModuleWriteError('规则切片恢复失败')
  })
}

/** 唯一保存顺序：正文/变量 → module.yml 原子提交 → 状态清单 → 校验发布。 */
export function commitModuleDefinition(snapshot: ModuleDefinitionSnapshot, next: string | ReturnType<typeof parseDocument>): ModuleDefinitionSnapshot {
  const candidate = snapshotFromText(snapshot.dir, typeof next === 'string' ? next : next.toString())
  if (candidate.text === snapshot.text) return ensureModuleSlices(snapshot.dir)
  return coordinated(snapshot.dir, () => {
    let persisted = false
    try {
      assertSource(snapshot)
      writeProjection(candidate, 'contents')
      atomicWriteTextFile(snapshot.file, candidate.text, { mode: statSync(snapshot.file).mode, beforeReplace: () => assertSource(snapshot) })
      persisted = true
      writeProjection(candidate, 'all')
      readProjection(candidate)
      publish(candidate)
      return candidate
    } catch (error) {
      let recovered: ModuleDefinitionSnapshot | undefined
      try { recovered = recoverCurrent(snapshot.dir) } catch { /* 保留最后已验证运行快照；下次 ensure 继续单向恢复。 */ }
      if (persisted && recovered) return recovered
      if (error instanceof ModuleWriteError && !persisted) throw new ModuleWriteError(error.message, error.status, error.code, false, recovered?.revisions ?? snapshot.revisions)
      throw new ModuleWriteError(`${persisted ? '模块已保存，但规则切片发布失败' : '模块未保存，规则切片写入失败'}：${String((error as Error).message ?? error)}`, 500, 'rules-rebuild-failed', persisted, recovered?.revisions ?? (persisted ? candidate.revisions : snapshot.revisions))
    }
  })
}

/**
 * 模块文件读-改-写（parseDocument 保留注释与未知键；mutate 内 setIn/deleteIn）。
 *
 * `owns` 必填：调用方声明这次编辑**拥有**哪些顶层键，其余键必须逐字不变（见 `SHARED_ALIAS_CODE`）。
 */
export function withModuleDefinition(
  directory: string,
  mutate: (doc: ReturnType<typeof parseDocument>, source: Record<string, unknown>) => void,
  options: { owns: readonly string[] },
): ModuleDefinitionSnapshot {
  const snapshot = ensureModuleSlices(directory)
  const before = snapshot.doc.toJS()
  mutate(snapshot.doc, snapshot.source)
  assertUnownedUnchanged(before, snapshot.doc, options.owns, 'YAML 共享引用会改变其他定义；请先解除相关引用后再编辑')
  return commitModuleDefinition(snapshot, snapshot.doc)
}

/**
 * 本文件拥有**模块定义读写与规则切片投影**：完整定义是唯一提交点；切片仅从有效定义恢复，全部校验后才发布快照。
 *
 * 写事务原语（锁、版本摘要、共享引用守卫、错误协议）来自 `module-write.ts`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { Document, isAlias, isMap, isNode, isSeq, parseDocument, stringify, visit } from 'yaml'
import type { RuleContent, RuleDefinition, RuleRevisions, RuleSettings } from '../shared/rules.ts'
import { nextConfigSequence } from '../shared/module-config-order.ts'

/** host 侧尾部序号：shared 抛普通 Error，这里转 ModuleWriteError（路由按 400/409 处理）。 */
export function nextModuleConfigSequence(current: Record<string, number>, reserved: readonly number[] = []): number {
  try { return nextConfigSequence(current, reserved) } catch (error) { throw new ModuleWriteError(error instanceof Error ? error.message : String(error)) }
}
import { assertModuleId } from './module-install.ts'
import { active, assertPlain, assertUnownedUnchanged, canonicalDirectory, directoryKey, ModuleWriteError, moduleLocation, processLocks, record, revisionOf, withModuleLock } from './module-write.ts'
import { MODULE_DEFINITION_FILE, RULES_DIR, RULES_SETTINGS_FILE, RULES_VARIABLES_FILE } from './paths.ts'
import { atomicTemporaryTarget, atomicWriteTextFile } from './text-file.ts'
import { replaceVersionedText } from './versioned-text.ts'
import { readModuleLayerSettings } from './module-layer-settings.ts'
// 引擎是规则语义的唯一校验器。
import { assertRuleId, compileRules } from '../../engine/rule-spec.mjs'
// 保留名由插值器的内建与动态宏目录共同定义。
import { isReservedInterpolationName } from '../../engine/interpolate.mjs'
import { loadTemplate } from '../../engine/schema.mjs'
import { resolveModuleReadPath } from './module-file-path.ts'
import { assertNoModuleLinks } from './module-install.ts'

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
  if (Object.hasOwn(source, 'persona')) throw new ModuleWriteError('顶层 persona 已退役；请手工重建为 rules 中的 persona 动作', 400, 'persona-format-retired')
  if (source.rules !== undefined && !Array.isArray(source.rules)) throw new ModuleWriteError('module.yml.rules 必须是数组')
  const retired = ['character-tools', 'world-book-tools', 'session-var-tools']
  const names = [...(Array.isArray(source.modules) ? source.modules : []), ...Object.keys(record(source.moduleConfigs) ? source.moduleConfigs : {})]
  if (names.some(name => retired.includes(String(name)))) throw new ModuleWriteError('旧角色/世界书/会话变量能力已退役；请重新导入或显式转换为模块工具')
}

export function rulePromptConfigOptions(directory: string, strategy?: unknown, dependOn?: (file: string) => void) {
  const templateBaseUrl = pathToFileURL(join(directory, MODULE_DEFINITION_FILE))
  const strategyDir = typeof strategy !== 'string' || strategy.length === 0 ? undefined
    : isAbsolute(strategy) ? pathToFileURL(strategy).href : new URL(strategy, templateBaseUrl).href
  const templateModuleRoot = pathToFileURL(directory.replace(/[\\/]?$/, '/'))
  return { templateBaseUrl, templateModuleRoot, strategyDir, loadTemplate: (file: unknown): unknown => {
    if (typeof file !== 'string' || file.length === 0) return undefined
    const target = fileURLToPath(new URL(file, templateBaseUrl))
    const path = relative(directory, target).split(sep).join('/')
    if (path.startsWith('assets/')) {
      const resolved = resolveModuleReadPath(directory, path, ['assets'], {}, dependOn)
      return loadTemplate(pathToFileURL(resolved).href, templateBaseUrl, pathToFileURL(dirname(resolved) + '/'))
    }
    assertNoModuleLinks(target)
    if (path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path))) dependOn?.(target)
    return loadTemplate(file, templateBaseUrl, templateModuleRoot)
  } }
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
interface ReusableRuleContent { json: string; text: string; revision: string; fileRevision: string; content: RuleContent }
const reusableContents = new WeakMap<Projection, Map<string, ReusableRuleContent>>()
const ownedSnapshots = new WeakSet<ModuleDefinitionSnapshot>()
export interface ModuleDefinitionValidationOptions {
  /** 交换预览只从上传文件与可信包内资产读取模板，禁止访问真实用户目标目录。 */
  loadTemplate?: (file: unknown) => unknown
}

function projection(source: Record<string, unknown>, directory: string, sourceRevision: string, validation: ModuleDefinitionValidationOptions = {}, dependOn?: (file: string) => void, previous?: Projection, unchangedRules?: ReadonlySet<string>): Projection {
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
  try {
    compileRules(rules, { moduleId: basename(directory), configOrder: order, variables, variablesEnabled,
      promptConfigOptions: { ...rulePromptConfigOptions(directory, options.strategyDir, dependOn), ...(validation.loadTemplate === undefined ? {} : { loadTemplate: validation.loadTemplate }) } })
  } catch (error) { throw new ModuleWriteError(String((error as Error).message ?? error)) }
  const contents: RuleContent[] = []
  const settings: Record<string, RuleSettings> = Object.create(null)
  const files: Record<string, string> = Object.create(null)
  const fileRevisions: Record<string, string> = Object.create(null)
  const ruleRevisions: Record<string, string> = Object.create(null)
  const previousContents = previous === undefined ? undefined : reusableContents.get(previous)
  const reusable = new Map<string, ReusableRuleContent>()
  let tail: number | undefined
  for (const rule of rules) {
    const previousContent = previousContents?.get(rule.id)
    const trusted = unchangedRules?.has(rule.id) && previousContent !== undefined
    const { enabled, group, groupScope, exclusive, ...rawContent } = rule
    const content = trusted ? previousContent.content : structuredClone(rawContent)
    contents.push(content)
    let sequence = order[rule.id]
    if (sequence === undefined) {
      // 只有真正需要分配时才计算；所有卡都有号时，MAX_SAFE_INTEGER 的既有序号不会触发上限检查。
      tail ??= nextModuleConfigSequence(order)
      sequence = tail
      tail += 10
    }
    if (!Number.isSafeInteger(sequence)) throw new ModuleWriteError('规则顺序超出安全整数范围')
    settings[rule.id] = { order: sequence, ...(enabled === undefined ? {} : { enabled }), ...(group === undefined ? {} : { group }), ...(groupScope === undefined ? {} : { groupScope }), ...(exclusive === undefined ? {} : { exclusive }) }
    // 只复用不可变投影的纯内容产物；全局编译、模板依赖和状态仍逐次校验。
    const json = trusted ? previousContent.json : JSON.stringify(content)
    let entry = previousContent
    if (entry?.json !== json) {
      const text = yaml(content)
      entry = { json, text, revision: digest(content), fileRevision: revisionOf(text), content: structuredClone(content) }
    }
    const filename = `${rule.id}.yml`
    files[filename] = entry.text
    fileRevisions[filename] = entry.fileRevision
    ruleRevisions[rule.id] = entry.revision
    reusable.set(rule.id, entry)
  }
  files[RULES_VARIABLES_FILE] = yaml(variables)
  fileRevisions[RULES_VARIABLES_FILE] = revisionOf(files[RULES_VARIABLES_FILE])
  const state = { rules: settings, variablesEnabled }
  const revisions: RuleRevisions = { rules: ruleRevisions, settings: digest(state), variables: digest(variables) }
  files[RULES_SETTINGS_FILE] = yaml({ ...state, _integrity: { version: 1, module: sourceRevision, files: fileRevisions, settings: revisions.settings } })
  const projected = { contents, settings, variables, variablesEnabled, revisions, files }
  reusableContents.set(projected, reusable)
  return projected
}

// 投影仅对应不可变原文；调用方可编辑的 doc/source 不作为缓存键或缓存内容。
const projections = new WeakMap<ModuleDefinitionSnapshot, { text: string; dir: string; projected: Projection; dependencies: Map<string, string> }>()
const verifiedProjections = new WeakSet<ModuleDefinitionSnapshot>()
const plainRuleDocuments = new WeakSet<ModuleDefinitionSnapshot>()
function projectedSnapshot(snapshot: ModuleDefinitionSnapshot): Projection {
  const cached = projections.get(snapshot)!
  for (const [file, revision] of cached.dependencies) {
    assertNoModuleLinks(file)
    if (revisionOf(readFileSync(file)) !== revision) throw sourceConflict()
  }
  return cached.projected
}

function snapshotFromText(dir: string, text: string, validation: ModuleDefinitionValidationOptions = {}, previous?: Projection): ModuleDefinitionSnapshot {
  const doc = parseDocument(text, { logLevel: 'silent' })
  if (doc.errors.length > 0) throw new ModuleWriteError(`模块 YAML 无法解析：${doc.errors[0]!.message}`)
  const source: unknown = doc.toJS()
  return snapshotFromDocument(dir, text, doc, source, validation, previous)
}

function snapshotFromDocument(dir: string, text: string, doc: ReturnType<typeof parseDocument>, source: unknown, validation: ModuleDefinitionValidationOptions = {}, previous?: Projection, unchangedRules?: ReadonlySet<string>): ModuleDefinitionSnapshot {
  assertCanonicalRuleSource(source)
  if (source.id !== undefined && source.id !== basename(dir)) throw new ModuleWriteError('模块定义身份不匹配')
  readModuleLayerSettings(source)
  const revision = revisionOf(text)
  const dependencies = new Map<string, string>()
  const projected = projection(source, dir, revision, validation, file => {
    assertNoModuleLinks(file)
    const current = revisionOf(readFileSync(file))
    if (dependencies.has(file) && dependencies.get(file) !== current) throw sourceConflict()
    dependencies.set(file, current)
  }, previous, unchangedRules)
  const configOrder = Object.fromEntries(Object.entries(projected.settings).map(([id, settings]) => [id, settings.order]))
  const rules = projected.contents.map(content => { const { order: _order, ...settings } = projected.settings[content.id]!; return { ...content, ...settings } }).sort((left, right) => configOrder[left.id]! - configOrder[right.id]!)
  const snapshot = { dir, file: join(dir, MODULE_DEFINITION_FILE), text, doc, source, revision, revisions: projected.revisions, rules, configOrder, variables: projected.variables, variablesEnabled: projected.variablesEnabled }
  projections.set(snapshot, { text, dir, projected, dependencies })
  projectedSnapshot(snapshot)
  return snapshot
}

/** 导入、预览与规则 validateOnly 复用同一完整定义校验，不访问或写入切片。 */
export const validateModuleDefinitionText = (directory: string, text: string, options: ModuleDefinitionValidationOptions = {}, previous?: ModuleDefinitionSnapshot): ModuleDefinitionSnapshot => snapshotFromText(directory, text, options,
  previous?.dir === directory ? projectedSnapshot(previous) : undefined)

/** 单条块映射替换：独立解析实际缩进片段，并证明其余原文字节和声明不变。 */
export function validateModuleRuleText(snapshot: ModuleDefinitionSnapshot, expected: Record<string, unknown>, ruleId: string): ModuleDefinitionSnapshot | undefined {
  if (snapshot.doc.directives?.yaml.version !== '1.2') return undefined
  let unsafe = false
  if (!plainRuleDocuments.has(snapshot)) visit(snapshot.doc, (_key, node) => {
    if (isAlias(node) || isNode(node) && (node.anchor || node.tag || node.comment || node.commentBefore)) unsafe = true
  })
  if (unsafe || !Array.isArray(snapshot.source.rules) || !Array.isArray(expected.rules)) return undefined
  const before = snapshot.source.rules, after = expected.rules
  const index = before.findIndex(rule => record(rule) && rule.id === ruleId)
  if (index < 0 || before.length !== after.length || !record(after[index]) || after[index].id !== ruleId) return undefined
  if (!isDeepStrictEqual({ ...snapshot.source, rules: after }, expected)
    || before.some((rule, at) => at !== index && !isDeepStrictEqual(rule, after[at]))) return undefined
  const nodes = snapshot.doc.get('rules', true), node = isSeq(nodes) ? nodes.items[index] : undefined
  if (!isMap(node) || !node.range || nodes?.flow || node.flow) return undefined
  const [start, end] = node.range
  const prefix = snapshot.text.slice(0, start)
  const listIndent = /^( *)- *$/.exec(prefix.slice(prefix.lastIndexOf('\n') + 1))
  if (!listIndent || snapshot.text[end - 1] !== '\n') return undefined
  const serialized = stringify(after[index], { indent: 2, lineWidth: 0 }).trimEnd()
  const indent = listIndent[1] + '  '
  const replacement = serialized.split('\n').map((line, at) => at === 0 ? line : indent + line).join('\n') + '\n'
  const text = prefix + replacement + snapshot.text.slice(end)
  const fragment = parseDocument(listIndent[1] + '- ' + replacement, { logLevel: 'silent' })
  if (fragment.errors.length || !isDeepStrictEqual(fragment.toJS(), [after[index]])) return undefined
  visit(fragment, (_key, node) => {
    if (isAlias(node) || isNode(node) && (node.anchor || node.tag || node.comment || node.commentBefore)) unsafe = true
  })
  if (unsafe) return undefined
  const owned = ownedSnapshots.has(snapshot)
  // 独占文档的其余原文未变，被替换的节点用实际写入片段验证并重建。
  if (!owned && !isDeepStrictEqual(snapshot.doc.toJS(), expected)) return undefined
  const fragmentNodes = fragment.contents
  if (!isSeq(fragmentNodes) || !isSeq(nodes) || !isMap(fragmentNodes.items[0])) return undefined
  const replacementNode = fragmentNodes.items[0]
  const offset = start - replacementNode.range![0], delta = replacement.length - (end - start)
  shiftRanges(snapshot.doc.contents, end, delta)
  if (snapshot.doc.range) for (let at = 0; at < snapshot.doc.range.length; at++) if (snapshot.doc.range[at]! >= end) snapshot.doc.range[at]! += delta
  shiftRanges(replacementNode, 0, offset)
  nodes.items[index] = replacementNode
  // 只有从私有槽取走的独占源能以引用证明未改；普通调用仍逐条按内容比对。
  const unchangedRules = owned
    ? new Set(before.filter((rule, at) => rule === after[at]).map(rule => (rule as RuleDefinition).id)) : undefined
  const candidate = snapshotFromDocument(snapshot.dir, text, snapshot.doc, expected, {}, projectedSnapshot(snapshot), unchangedRules)
  plainRuleDocuments.add(candidate)
  return candidate
}

function shiftRanges(node: unknown, from: number, delta: number): void {
  if (!isNode(node)) return
  if (node.range) for (let at = 0; at < node.range.length; at++) if (node.range[at]! >= from) node.range[at]! += delta
  if (isMap(node)) for (const pair of node.items) { shiftRanges(pair.key, from, delta); shiftRanges(pair.value, from, delta) }
  else if (isSeq(node)) for (const item of node.items) shiftRanges(item, from, delta)
}

function readDefinitionText(directory: string): { dir: string; text: string } {
  let dir: string
  try { dir = canonicalDirectory(directory); assertModuleId(basename(dir)); assertPlain(join(dir, MODULE_DEFINITION_FILE)) }
  catch (error) { throw new ModuleWriteError(String((error as Error).message ?? error)) }
  const bytes = readFileSync(join(dir, MODULE_DEFINITION_FILE))
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return { dir, text }
}

// 模块实例仅保留最近一份实际源的格式摘要；不保留或外泄可变 AST，内容/依赖变化即失效。
let lastFormat: { dir: string; text: string; dependencies: ReadonlyMap<string, string> } | undefined

/** 归属门只核完整定义与层设置，不需要取得可编辑快照。每次仍读取实际字节与依赖。 */
export function assertModuleDefinitionFormat(directory: string): void {
  const { dir, text } = readDefinitionText(directory)
  if (lastFormat?.dir === dir && lastFormat.text === text) {
    let current = true
    for (const [file, revision] of lastFormat.dependencies) {
      assertNoModuleLinks(file)
      if (revisionOf(readFileSync(file)) !== revision) { current = false; break }
    }
    if (current) return
  }
  let snapshot: ModuleDefinitionSnapshot | undefined
  if (lastVerified?.dir === dir && lastVerified.text === text) {
    try { projectedSnapshot(lastVerified); snapshot = lastVerified }
    catch (error) { if (!(error instanceof ModuleWriteError) || error.code !== 'rules-conflict') throw error }
  }
  snapshot ??= snapshotFromText(dir, text)
  readModuleLayerSettings(snapshot.source)
  lastFormat = { dir, text, dependencies: new Map(projections.get(snapshot)!.dependencies) }
}

/** 纯读完整源；无效源绝不会触发分解或恢复。 */
export function loadModuleDefinition(directory: string, takeOwnership = false): ModuleDefinitionSnapshot {
  const { dir, text } = readDefinitionText(directory)
  if (lastVerified?.dir === dir && lastVerified.text === text) {
    try {
      projectedSnapshot(lastVerified)
      if (takeOwnership) {
        const snapshot = lastVerified
        lastVerified = undefined
        ownedSnapshots.add(snapshot)
        return snapshot
      }
      return cloneSnapshot(lastVerified)
    } catch (error) {
      if (!(error instanceof ModuleWriteError) || error.code !== 'rules-conflict') throw error
      lastVerified = undefined
    }
  }
  const snapshot = snapshotFromText(dir, text)
  if (takeOwnership) ownedSnapshots.add(snapshot)
  return snapshot
}

const sourceConflict = (): ModuleWriteError => new ModuleWriteError('写入前模块再次变化，请重新读取', 409, 'rules-conflict')

function assertSourcePath(snapshot: ModuleDefinitionSnapshot): void {
  if (canonicalDirectory(snapshot.dir) !== snapshot.dir) throw sourceConflict()
  assertModuleId(basename(snapshot.dir))
  assertPlain(snapshot.file)
}

function assertSource(snapshot: ModuleDefinitionSnapshot): void {
  assertSourcePath(snapshot)
  // 身份已由快照完整解析校验；相同字节版本无需再次解析整份 YAML。
  if (revisionOf(readFileSync(snapshot.file)) !== snapshot.revision) throw sourceConflict()
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
  const expected = projectedSnapshot(snapshot)
  const dir = join(snapshot.dir, RULES_DIR)
  assertPlain(dir, true)
  // 只认名单内切片：名单外文件不读、不校验，也不参与集合比对。
  const files = readdirSync(dir)
  const present = new Set(files)
  for (const file of Object.keys(expected.files)) {
    const path = join(dir, file)
    if (!present.has(file)) throw new ModuleWriteError(`规则切片缺失：${file}`, 409, 'rules-slices-invalid')
    assertPlain(path)
    if (readFileSync(path, 'utf8') !== expected.files[file]) throw new ModuleWriteError(`规则切片与完整定义失配：${file}`, 409, 'rules-slices-invalid')
  }
  // 中断写入残留的临时文件不是用户素材，仍触发恢复路径（清临时名 + 回收死锁目录）。
  if (files.some(isRulesTemporary)) throw new ModuleWriteError('规则目录含中断写入残留', 409, 'rules-slices-invalid')
  assertSource(snapshot)
  verifiedProjections.add(snapshot)
  return expected
}

/** 纯读且校验三方一致，不补缺、不接纳手改切片。 */
export function readRulesDir(directory: string) {
  const snapshot = loadModuleDefinition(directory)
  const { files: _files, ...projected } = readProjection(snapshot)
  const result = structuredClone(projected)
  result.contents.sort((left, right) => result.settings[left.id]!.order - result.settings[right.id]!.order)
  return result
}

// 仅保留不可变原文；调用方改动 doc/source/rules 不会污染最后已验证快照。
const published = new Map<string, { dir: string; text: string }>()
// 热编辑只保留最后一个已发布模块的私有 AST；调用方取得隔离副本，外部改写按完整解析处理。
let lastVerified: ModuleDefinitionSnapshot | undefined
function cloneSnapshot(snapshot: ModuleDefinitionSnapshot): ModuleDefinitionSnapshot {
  const copy = { ...snapshot, doc: snapshot.doc.clone(), source: structuredClone(snapshot.source),
    rules: structuredClone(snapshot.rules), revisions: structuredClone(snapshot.revisions),
    configOrder: { ...snapshot.configOrder }, variables: { ...snapshot.variables } }
  projections.set(copy, projections.get(snapshot)!)
  if (plainRuleDocuments.has(snapshot)) plainRuleDocuments.add(copy)
  return copy
}
const publish = (snapshot: ModuleDefinitionSnapshot, cache: 'clone' | 'take' | 'skip' = 'clone'): void => {
  published.set(directoryKey(snapshot.dir), { dir: snapshot.dir, text: snapshot.text })
  if (cache === 'take') lastVerified = snapshot
  else if (cache === 'clone' && (lastVerified?.dir !== snapshot.dir || lastVerified.text !== snapshot.text)) lastVerified = cloneSnapshot(snapshot)
}

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
function removedRuleSlices(dir: string, projected: Projection, previous?: Projection): string[] {
  const known = previous === undefined ? undefined : reusableContents.get(previous)
  if (known) return [...known.keys()].filter(id => !Object.hasOwn(projected.settings, id)).map(id => `${id}.yml`)
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

function writeProjection(snapshot: ModuleDefinitionSnapshot, phase: 'contents' | 'all', contentsPrepared = false, previous?: Projection): void {
  const projected = projectedSnapshot(snapshot)
  const dir = join(snapshot.dir, RULES_DIR)
  if (existsSync(dir)) assertPlain(dir, true)
  else mkdirSync(dir)
  // 名单外文件归用户所有：不读、不校验、不写、不删；只清理旧名单里已移除的规则切片。
  const removed = phase === 'all' ? removedRuleSlices(dir, projected, previous) : []
  for (const [file, text] of Object.entries(projected.files)) {
    if (phase === 'contents' && file === RULES_SETTINGS_FILE) continue
    if (contentsPrepared && file !== RULES_SETTINGS_FILE) continue
    // 旧切片已在 ensure 中完整读回；相同内容无需准备，提交后仍完整校验。
    if (phase === 'contents' && previous?.files[file] === text) continue
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
export function ensureModuleSlices(directory: string, options: { writable?: boolean; force?: boolean; takeOwnership?: boolean } = {}): ModuleDefinitionSnapshot {
  const dir = moduleLocation(directory), key = directoryKey(dir)
  const inProgress = (): ModuleDefinitionSnapshot | undefined => {
    if (!active.has(key) && !processLocks(dir)) return undefined
    const previous = published.get(key)
    if (previous) return snapshotFromText(previous.dir, previous.text)
    throw new ModuleWriteError('模块尚无已验证快照，保存或恢复正在进行', 409, 'rules-conflict')
  }
  const running = inProgress()
  if (running) return running
  const snapshot = loadModuleDefinition(dir, options.takeOwnership)
  if (options.writable === false) return snapshot
  if (!options.force && rootTemporaries(dir).length === 0) {
    try {
      readProjection(snapshot)
      const writing = inProgress()
      if (writing) return writing
      publish(snapshot, options.takeOwnership ? 'skip' : 'clone')
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
export function commitModuleDefinition(snapshot: ModuleDefinitionSnapshot, next: string | ReturnType<typeof parseDocument>, prepared?: ModuleDefinitionSnapshot, retainOwnership = false): ModuleDefinitionSnapshot {
  const text = typeof next === 'string' ? next : next.toString()
  const cached = prepared === undefined ? undefined : projections.get(prepared)
  const candidate = prepared?.dir === snapshot.dir && prepared.text === text && cached?.text === text && cached.dir === snapshot.dir
    ? prepared : snapshotFromText(snapshot.dir, text)
  if (candidate.text === snapshot.text) return ensureModuleSlices(snapshot.dir)
  return coordinated(snapshot.dir, () => {
    let persisted = false
    try {
      assertSource(snapshot)
      writeProjection(candidate, 'contents', false, verifiedProjections.has(snapshot) ? projectedSnapshot(snapshot) : undefined)
      replaceVersionedText({
        file: snapshot.file,
        expectedRevision: snapshot.revision,
        read: () => {
          assertSourcePath(snapshot)
          const mode = statSync(snapshot.file).mode
          return { revision: revisionOf(readFileSync(snapshot.file)), value: undefined, mode }
        },
        prepare: () => candidate.text,
        recheck: () => { assertSourcePath(snapshot); projectedSnapshot(candidate) },
        conflict: sourceConflict,
      })
      persisted = true
      writeProjection(candidate, 'all', true, verifiedProjections.has(snapshot) ? projectedSnapshot(snapshot) : undefined)
      readProjection(candidate)
      publish(candidate, retainOwnership ? 'take' : 'clone')
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

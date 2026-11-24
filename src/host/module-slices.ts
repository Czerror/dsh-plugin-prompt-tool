/**
 * 本文件拥有**模块定义读写与规则切片投影**：已安装模块由清单与规则成员组成，读取时验证同一提交的身份和摘要。
 *
 * 写事务原语（锁、版本摘要、共享引用守卫、错误协议）来自 `module-write.ts`。
 */
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packageModulesDir } from './module-dirs.ts'
import { isDeepStrictEqual } from 'node:util'
import { Document, isAlias, isMap, isNode, isPair, isScalar, isSeq, parseDocument, visit } from 'yaml'
import type { RuleContent, RuleDefinition, RuleRevisions, RuleSettings } from '../shared/rules.ts'
import { nextConfigSequence } from '../shared/module-config-order.ts'

/** host 侧尾部序号：shared 抛普通 Error，这里转 ModuleWriteError（路由按 400/409 处理）。 */
export function nextModuleConfigSequence(current: Record<string, number>, reserved: readonly number[] = []): number {
  try { return nextConfigSequence(current, reserved) } catch (error) { throw new ModuleWriteError(error instanceof Error ? error.message : String(error)) }
}
import { assertModuleId, assertModuleDefinitionSource, moduleDirectoryIdentity } from './module-install.ts'
import { serializeWithoutSharedAlias, assertPlain, assertUnownedUnchanged, canonicalDirectory, ModuleWriteError, record, revisionOf, SHARED_ALIAS_CODE, withModuleLock } from './module-write.ts'
import { markModuleLocalInitialized, moduleLocalObjectStamp, readModuleLocalCommit, readModuleLocalCommitInfo, readModuleLocalObject, readModuleLocalObjects, readPreviousModuleLocalCommit, MODULE_LOCAL_COMMIT_FILE, publishModuleLocalCommit, writeModuleLocalObject, writeModuleLocalCommit } from './module-local-state.ts'
import type { ModuleLocalCommit, VerifiedModuleObjects } from './module-local-state.ts'
import { MODULE_DEFINITION_FILE, RULES_DIR, RULES_SETTINGS_FILE, RULES_VARIABLES_FILE } from './paths.ts'
import { readModuleLayerSettings } from './module-layer-settings.ts'
// 引擎是规则语义的唯一校验器。
import { assertRuleId, compileRules } from '../../engine/rule-spec.mjs'
// 保留名由插值器的内建与动态宏目录共同定义。
import { isReservedInterpolationName } from '../../engine/interpolate.mjs'
import { loadTemplate } from '../../engine/schema.mjs'
import { assertModuleAssetReference, resolveModuleReadPath } from './module-file-path.ts'
import { assertNoModuleLinks } from './module-install.ts'

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  return record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
}
export const ruleValueRevision = (value: unknown): string => revisionOf(JSON.stringify(stable(value)))
const digest = ruleValueRevision
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
  if (typeof source.composition === 'string' && source.composition.startsWith('./') && !source.composition.includes('\n')) {
    assertModuleAssetReference(source.composition, 'composition')
  }
  const retired = ['character-tools', 'world-book-tools', 'session-var-tools']
  const names = [...(Array.isArray(source.modules) ? source.modules : []), ...Object.keys(record(source.moduleConfigs) ? source.moduleConfigs : {})]
  if (names.some(name => retired.includes(String(name)))) throw new ModuleWriteError('旧角色/世界书/会话变量能力已退役；请重新导入或显式转换为模块工具')
}

export function rulePromptConfigOptions(directory: string, strategy?: unknown, dependOn?: (file: string) => void, fromPackage?: (file: unknown) => unknown) {
  const templateBaseUrl = pathToFileURL(join(directory, MODULE_DEFINITION_FILE))
  const strategyDir = typeof strategy !== 'string' || strategy.length === 0 ? undefined
    : isAbsolute(strategy) ? pathToFileURL(strategy).href : new URL(strategy, templateBaseUrl).href
  const templateModuleRoot = pathToFileURL(directory.replace(/[\\/]?$/, '/'))
  return { templateBaseUrl, templateModuleRoot, strategyDir, loadTemplate: (file: unknown): unknown => {
    if (typeof file !== 'string' || file.length === 0) return fromPackage?.(file)
    const target = fileURLToPath(new URL(file, templateBaseUrl))
    const path = relative(directory, target).split(sep).join('/')
    assertModuleAssetReference(path, 'templateFile')
    if (fromPackage) return fromPackage(file)
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
export interface ModuleDefinitionValidationOptions {
  /** 交换预览只从上传文件与可信包内资产读取模板，禁止访问真实用户目标目录。 */
  loadTemplate?: (file: unknown) => unknown
}

function projection(source: Record<string, unknown>, directory: string, validation: ModuleDefinitionValidationOptions = {}, dependOn?: (file: string) => void): Projection {
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
      promptConfigOptions: rulePromptConfigOptions(directory, options.strategyDir, dependOn, validation.loadTemplate) })
  } catch (error) { throw new ModuleWriteError(String((error as Error).message ?? error)) }
  const contents: RuleContent[] = []
  const settings: Record<string, RuleSettings> = Object.create(null)
  const ruleRevisions: Record<string, string> = Object.create(null)
  let tail: number | undefined
  for (const rule of rules) {
    const { enabled, group, groupScope, exclusive, ...content } = rule
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
    ruleRevisions[rule.id] = digest(content)
  }
  const state = { rules: settings, variablesEnabled }
  const revisions: RuleRevisions = { rules: ruleRevisions, settings: digest(state), variables: digest(variables) }
  return { contents, settings, variables, variablesEnabled, revisions, get files() {
    const files: Record<string, string> = Object.create(null)
    for (const content of contents) files[content.id + '.yml'] = yaml(content)
    files[RULES_VARIABLES_FILE] = yaml(variables)
    files[RULES_SETTINGS_FILE] = JSON.stringify({ ...state, settingsRevision: revisions.settings, variablesRevision: revisions.variables }) + '\n'
    return files
  } }
}

// 同名包内资产回退时，用户资产的缺失也是快照依赖。
export function templateDependencyRevision(file: string): string | undefined {
  assertNoModuleLinks(file)
  try { return revisionOf(readFileSync(file)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// 投影仅对应不可变原文；调用方可编辑的 doc/source 不作为缓存键或缓存内容。
const projections = new WeakMap<ModuleDefinitionSnapshot, { text: string; dir: string; projected: Projection; dependencies: Map<string, string | undefined> }>()
function recordDependency(dependencies: Map<string, string | undefined>, file: string, revision: string | undefined): void {
  if (dependencies.has(file) && dependencies.get(file) !== revision) throw sourceConflict()
  dependencies.set(file, revision)
}

function projectedSnapshot(snapshot: ModuleDefinitionSnapshot): Projection {
  const cached = projections.get(snapshot)!
  for (const [file, revision] of cached.dependencies) {
    if (templateDependencyRevision(file) !== revision) throw sourceConflict()
  }
  return cached.projected
}

function snapshotFromText(dir: string, text: string, validation: ModuleDefinitionValidationOptions = {}): ModuleDefinitionSnapshot {
  const doc = parseDocument(text, { logLevel: 'silent' })
  if (doc.errors.length > 0) throw new ModuleWriteError(`模块 YAML 无法解析：${doc.errors[0]!.message}`)
  const source: unknown = doc.toJS()
  return snapshotFromDocument(dir, text, doc, source, validation)
}

function snapshotFromDocument(dir: string, raw: string | undefined, doc: ReturnType<typeof parseDocument>, source: unknown, validation: ModuleDefinitionValidationOptions = {}, commit?: ModuleLocalCommit): ModuleDefinitionSnapshot {
  assertCanonicalRuleSource(source)
  if (source.id !== undefined && source.id !== basename(dir)) throw new ModuleWriteError('模块定义身份不匹配')
  readModuleLayerSettings(source)
  const revision = commit?.generation ?? revisionOf(raw!)
  const dependencies = new Map<string, string | undefined>()
  const projected = projection(source, dir, validation, file => {
    recordDependency(dependencies, file, templateDependencyRevision(file))
  })
  const configOrder = Object.fromEntries(Object.entries(projected.settings).map(([id, settings]) => [id, settings.order]))
  const rules = projected.contents.map(content => { const { order: _order, ...settings } = projected.settings[content.id]!; return { ...content, ...settings } }).sort((left, right) => configOrder[left.id]! - configOrder[right.id]!)
  let document: typeof doc | undefined = raw === undefined ? undefined : doc
  let text = raw
  const snapshot = { dir, file: commit === undefined ? join(dir, MODULE_DEFINITION_FILE) : join(dir, RULES_DIR, MODULE_LOCAL_COMMIT_FILE),
    get doc() {
      if (document === undefined) {
        document = doc
        if (commit?.declaredKeys.includes('rules')) document.set('rules', document.createNode(source.rules))
        text = document.toString()
      }
      return document
    },
    get text() { return text ??= this.doc.toString() },
    source, revision, revisions: projected.revisions, rules, configOrder, variables: projected.variables, variablesEnabled: projected.variablesEnabled }
  projections.set(snapshot, { dir, projected, dependencies, get text() { return snapshot.text } })
  projectedSnapshot(snapshot)
  return snapshot
}

/** 导入、预览与规则 validateOnly 复用同一完整定义校验，不访问或写入切片。 */
export function validateModuleDefinitionText(directory: string, text: string, options: ModuleDefinitionValidationOptions = {}, previous?: ModuleDefinitionSnapshot): ModuleDefinitionSnapshot {
  if (previous?.dir === directory) projectedSnapshot(previous)
  return snapshotFromText(directory, text, options)
}

export function assertSlicableAliases(doc: ModuleDefinitionSnapshot['doc']): Pick<ModuleLocalCommit, 'hasSourceAliases' | 'aliasRuleIds'> {
  const anchors = new Map<string, { field: string; id?: string }>()
  const ruleIds = new Set<string>()
  let found = false
  let unclassified = false
  visit(doc, (_key, node, parents) => {
    const pair = parents[2]
    if (!isPair(pair) || !isScalar(pair.key)) return
    const field = String(pair.key.value)
    const rule = field === 'rules' && isSeq(parents[3]) ? parents[4] ?? node : undefined
    const ruleId = isMap(rule) ? rule.get('id') : undefined
    const id = typeof ruleId === 'string' ? ruleId : undefined
    if (isNode(node) && !isAlias(node) && node.anchor) anchors.set(node.anchor, { field, id })
    if (!isAlias(node)) return
    found = true
    const anchor = anchors.get(node.source)
    if (anchor !== undefined && (field === 'rules') !== (anchor.field === 'rules')) {
      throw new ModuleWriteError(`模块定义的 YAML 引用跨越规则与模块字段：${anchor.field} → ${field}`, 400, SHARED_ALIAS_CODE)
    }
    if (field === 'rules') {
      if (id && anchor?.id) { ruleIds.add(id); ruleIds.add(anchor.id) }
      else unclassified = true
    }
  })
  if (!found) return {}
  return { hasSourceAliases: true, ...(unclassified ? {} : { aliasRuleIds: [...ruleIds] }) }
}

/** 首次迁移已验证的完整定义。已有提交的模块不再读取交换源。 */
export function materializeModuleDefinition(directory: string, validate?: (snapshot: ModuleDefinitionSnapshot, read: (file: string, encoding: 'utf8') => string) => void): ModuleLocalCommit {
  const dir = canonicalDirectory(directory)
  const ensure = (): ModuleLocalCommit => {
    const existing = readModuleLocalCommit(dir)
    if (existing) {
      markModuleLocalInitialized(dir)
      return existing
    }
    const source = readDefinitionText(dir)
    const snapshot = snapshotFromText(source.dir, source.text)
    validate?.(snapshot, (file, encoding) => {
      const bytes = readFileSync(file)
      recordDependency(projections.get(snapshot)!.dependencies, file, revisionOf(bytes))
      return bytes.toString(encoding)
    })
    const aliases = assertSlicableAliases(snapshot.doc)
    const projected = projectedSnapshot(snapshot)
    const packageRoot = canonicalDirectory(packageModulesDir())
    const fallback = join(packageRoot, basename(dir)) + sep
    if ([...projections.get(snapshot)!.dependencies.keys()].some(file => file.startsWith(fallback))) {
      assertModuleDefinitionSource(packageRoot, basename(dir))
    }
    const inputs = snapshot.doc.clone()
    inputs.delete('rules')
    assertSource(snapshot)
    return writeModuleLocalCommit(dir, { moduleId: basename(dir), declaredKeys: Object.keys(snapshot.source),
      exportBase: snapshot.text, inputs: inputs.toString(), files: projected.files, ruleIds: projected.contents.map(rule => rule.id),
      hasProcessRules: snapshot.rules.some(rule => rule.executionScope === 'process'),
      ...aliases }, () => { assertSource(snapshot); projectedSnapshot(snapshot) })
  }
  return withModuleLock(dirname(dir), basename(dir), ensure)
}

function readDefinitionText(directory: string): { dir: string; text: string } {
  let dir: string
  try { dir = canonicalDirectory(directory); assertModuleId(basename(dir)); assertPlain(join(dir, MODULE_DEFINITION_FILE)) }
  catch (error) { throw new ModuleWriteError(String((error as Error).message ?? error)) }
  const bytes = readFileSync(join(dir, MODULE_DEFINITION_FILE))
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  return { dir, text }
}

const sourceConflict = (): ModuleWriteError => new ModuleWriteError('写入前模块再次变化，请重新读取', 409, 'rules-conflict')
function assertSource(snapshot: ModuleDefinitionSnapshot): void {
  assertPlain(snapshot.file)
  if (revisionOf(readFileSync(snapshot.file)) !== snapshot.revision) throw sourceConflict()
}

function parseLocal(text: string) {
  const doc = parseDocument(text, { logLevel: 'silent' })
  if (doc.errors.length) throw new ModuleWriteError(doc.errors[0]!.message)
  return doc
}

function committedSnapshot(dir: string, commit: ModuleLocalCommit, data = readModuleLocalObjects(dir, [commit.inputs, ...Object.values(commit.members)])): ModuleDefinitionSnapshot {
  const object = (hash: string) => data.members.get(hash)!.text
  const inputs = parseLocal(object(commit.inputs))
  const source = inputs.toJS()
  assertCanonicalRuleSource(source)
  const settingsHash = commit.members[RULES_SETTINGS_FILE]!
  const state = parseCommittedState(object(settingsHash))
  const variables = parseLocal(object(commit.members[RULES_VARIABLES_FILE]!)).toJS()
  if (!record(state) || !record(state.rules) || !isDeepStrictEqual(source.variables ?? {}, variables)
    || (source.variablesEnabled !== false) !== state.variablesEnabled) throw new ModuleWriteError('模块清单与状态不一致')
  const settings = state.rules
  const rules = commit.ruleIds.map(id => {
    assertRuleFileId(id)
    const content = parseLocal(object(commit.members[id + '.yml']!)).toJS()
    const item = settings[id]
    if (!record(content) || content.id !== id || !record(item)) throw new ModuleWriteError('规则提交成员身份无效：' + id)
    const { order: _order, ...fields } = item
    return { ...content, ...fields }
  })
  if (commit.hasProcessRules !== undefined && commit.hasProcessRules !== rules.some(rule => rule.executionScope === 'process')) {
    throw new ModuleWriteError('模块提交的进程规则标记不一致')
  }
  if (commit.declaredKeys.includes('rules')) {
    source.rules = rules
  } else if (rules.length) throw new ModuleWriteError('未声明规则的模块含有规则成员')
  if (Object.keys(source).length !== commit.declaredKeys.length || commit.declaredKeys.some(k => !Object.hasOwn(source,k))) {
    throw new ModuleWriteError('模块提交的声明与输入不一致')
  }
  const snapshot = snapshotFromDocument(dir, undefined, inputs, source, {}, commit)
  if (state.variablesRevision !== snapshot.revisions.variables || state.settingsRevision !== snapshot.revisions.settings
    || !isDeepStrictEqual(Object.entries(settings), Object.entries(projectedSnapshot(snapshot).settings))) {
    throw new ModuleWriteError('模块提交的规则状态或顺序无效')
  }
  rememberRuleSettings(dir, settingsHash, data.members.get(settingsHash)!.stamp, state)
  return snapshot
}

function installed(dir: string): ModuleLocalCommit {
  const commit = readModuleLocalCommit(dir)
  if (!commit) throw new ModuleWriteError('缺少本地模块提交；请先安装或迁移模块')
  return commit
}

/** 普通读只认已发布的代。包自身的只读模板仍是安装输入。 */
export function loadModuleDefinition(directory: string): ModuleDefinitionSnapshot {
  return readCommittedDefinition(directory, (dir, commit) => committedSnapshot(dir, commit), snapshot => snapshot, true)
}

type RuntimeDefinition = Omit<ModuleDefinitionSnapshot, 'doc' | 'text'>
type RuntimeRead = { commit: ModuleLocalCommit; objects: VerifiedModuleObjects; snapshot: RuntimeDefinition; dependencies: ReadonlyMap<string, string | undefined>; deltas: number }
type RuntimeDelta = { previous: string; generation: string; id: string; dependencies: ReadonlyMap<string, string | undefined> }
const runtimeDeltas = new Map<string, RuntimeDelta>()

export function rememberRuntimeRuleEdit(directory: string, delta: RuntimeDelta): void {
  if (runtimeDeltas.size >= 128) runtimeDeltas.delete(runtimeDeltas.keys().next().value!)
  runtimeDeltas.set(directory, delta)
}

const currentDependencies = (dependencies: ReadonlyMap<string, string | undefined>): boolean =>
  [...dependencies].every(([file, revision]) => templateDependencyRevision(file) === revision)

export function createModuleRuntimeSnapshotReader() {
  const modules = new Map<string, RuntimeRead>()
  return {
    read(directory: string): RuntimeDefinition {
      return readCommittedDefinition(directory, (dir, commit) => {
        const previous = modules.get(dir)
        const data = readModuleLocalObjects(dir, [commit.inputs, ...Object.values(commit.members)], previous?.objects)
        const store = (snapshot: RuntimeDefinition, dependencies: RuntimeRead['dependencies'], deltas = 0): void => {
          if (!modules.has(dir) && modules.size >= 32) modules.delete(modules.keys().next().value!)
          modules.set(dir, { commit, objects: data, snapshot, dependencies, deltas })
        }
        if (previous?.commit.generation === commit.generation && data.changed.size === 0 && currentDependencies(previous.dependencies)) {
          return previous.snapshot
        }
        const delta = runtimeDeltas.get(dir)
        if (previous !== undefined && previous.deltas < 32 && delta?.previous === previous.commit.generation && delta.generation === commit.generation
          && data.changed.size === 1 && data.changed.has(commit.members[delta.id + '.yml']!)
          && commit.inputs === previous.commit.inputs
          && Object.keys(commit.members).length === Object.keys(previous.commit.members).length
          && Object.entries(commit.members).every(([file, hash]) => file === delta.id + '.yml' || hash === previous.commit.members[file])
          && isDeepStrictEqual(commit.ruleIds, previous.commit.ruleIds) && isDeepStrictEqual(commit.declaredKeys, previous.commit.declaredKeys)
          && currentDependencies(previous.dependencies) && currentDependencies(delta.dependencies)) {
          const before = previous.snapshot
          const content: unknown = parseLocal(data.members.get(commit.members[delta.id + '.yml']!)!.text).toJS()
          const prior = before.rules.find(rule => rule.id === delta.id)
          if (!record(content) || content.id !== delta.id || prior === undefined) throw new ModuleWriteError('规则提交成员身份无效：' + delta.id)
          const { enabled, group, groupScope, exclusive } = prior
          const rule = { ...content, ...(enabled === undefined ? {} : { enabled }), ...(group === undefined ? {} : { group }),
            ...(groupScope === undefined ? {} : { groupScope }), ...(exclusive === undefined ? {} : { exclusive }) } as RuleDefinition
          const rules = before.rules.map(current => current.id === delta.id ? rule : current)
          const revisions = { ...before.revisions, rules: { ...before.revisions.rules, [delta.id]: digest(content) } }
          const { dir, file, configOrder, variables, variablesEnabled } = before
          const snapshot = { dir, file, configOrder, variables, variablesEnabled, rules, revisions, revision: commit.generation,
            source: { ...before.source, rules: ((before.source.rules ?? []) as RuleDefinition[]).map(current => current.id === delta.id ? rule : current) } }
          store(snapshot, new Map([...previous.dependencies, ...delta.dependencies]), previous.deltas + 1)
          return snapshot
        }
        const snapshot = committedSnapshot(dir, commit, data)
        store(snapshot, projections.get(snapshot)!.dependencies)
        return snapshot
      }, snapshot => snapshot, true)
    },
    retain(directories: readonly string[]) {
      const current = new Set(directories)
      for (const key of modules.keys()) if (!current.has(key)) modules.delete(key)
    },
    dispose() { modules.clear() },
  }
}

// 规则装配已验证的降级代也约束同一 head 的按需变量读取。
const degradedHeads = new Map<string, { identity: string; generation: string }>()

function readCommittedDefinition<T>(
  directory: string, read: (dir: string, commit: ModuleLocalCommit) => T, fallback: (snapshot: ModuleDefinitionSnapshot) => T,
  fullRead = false,
): T {
  const dir = canonicalDirectory(directory)
  if (dirname(dir) === canonicalDirectory(packageModulesDir())) {
    const {text} = readDefinitionText(dir)
    return fallback(snapshotFromText(dir, text))
  }
  const identity = moduleDirectoryIdentity(dir)
  try {
    const commit = installed(dir)
    let value: T
    try {
      const degraded = degradedHeads.get(dir)
      const knownDegraded = degraded?.identity === identity && degraded?.generation === commit.generation
      if (!fullRead && knownDegraded) {
        value = fallback(committedSnapshot(dir, commit))
      } else {
        value = read(dir, commit)
      }
      degradedHeads.delete(dir)
    }
    catch (error) {
      const previous = readPreviousModuleLocalCommit(dir, commit)
      if (!previous) throw error
      value = fullRead ? read(dir, previous) : fallback(committedSnapshot(dir, previous))
      if (identity !== undefined) {
        if (degradedHeads.size >= 128) degradedHeads.delete(degradedHeads.keys().next().value!)
        degradedHeads.set(dir, { identity, generation: commit.generation })
      }
    }
    if (identity === undefined || moduleDirectoryIdentity(dir) !== identity) throw sourceConflict()
    return value
  } catch (error) {
    if (error instanceof ModuleWriteError && error.code === 'rules-conflict') throw error
    if (moduleDirectoryIdentity(dir) !== identity) throw sourceConflict()
    throw new ModuleWriteError(String((error as Error).message), 400, 'module-broken')
  }
}

const verifiedInputs = new Map<string, { stamp: string; source: Readonly<Record<string, unknown>> }>()
const verifiedRuleSettings = new Map<string, { stamp: string; state: unknown }>()

export function freezeModuleValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) freezeModuleValue(item)
  }
  return value
}

export function getVerifiedModuleInputs(dir: string, commit: Pick<ModuleLocalCommit, 'moduleId' | 'inputs' | 'declaredKeys'>): Readonly<Record<string, unknown>> {
  const stamp = moduleLocalObjectStamp(dir, commit.inputs)
  const key = JSON.stringify([dir, commit.inputs, commit.moduleId, commit.declaredKeys])
  const cached = verifiedInputs.get(key)
  if (cached?.stamp === stamp) {
    verifiedInputs.delete(key)
    verifiedInputs.set(key, cached)
    return cached.source
  }
  const source = parseLocal(readModuleLocalObject(dir, commit.inputs)).toJS()
  if (moduleLocalObjectStamp(dir, commit.inputs) !== stamp) throw sourceConflict()
  assertCanonicalRuleSource(source)
  if (source.id !== undefined && source.id !== commit.moduleId) throw new ModuleWriteError('模块身份不匹配')
  const keys = Object.keys(source)
  if (Object.hasOwn(source, 'rules') || keys.length !== commit.declaredKeys.length - Number(commit.declaredKeys.includes('rules'))
    || keys.some(key => !commit.declaredKeys.includes(key))) throw new ModuleWriteError('模块提交的声明与输入不一致')
  readModuleLayerSettings(source)
  if (source.variables !== undefined) assertVariableValues(source.variables)
  if (source.variablesEnabled !== undefined && typeof source.variablesEnabled !== 'boolean') throw new ModuleWriteError('variablesEnabled 必须是布尔值')
  if (verifiedInputs.size >= 32) verifiedInputs.delete(verifiedInputs.keys().next().value!)
  verifiedInputs.set(key, { stamp, source: freezeModuleValue(source) })
  return source
}

function parseCommittedState(text: string): unknown {
  return text.startsWith('{') ? JSON.parse(text) : parseLocal(text).toJS()
}

export function readModuleRuleEditSettings(dir: string, hash: string): unknown {
  const key = JSON.stringify([dir, hash])
  const stamp = moduleLocalObjectStamp(dir, hash)
  const cached = verifiedRuleSettings.get(key)
  if (cached?.stamp === stamp) return cached.state
  const state = parseCommittedState(readModuleLocalObject(dir, hash))
  if (moduleLocalObjectStamp(dir, hash) !== stamp) throw sourceConflict()
  return rememberRuleSettings(dir, hash, stamp, state)
}

function rememberRuleSettings(dir: string, hash: string, stamp: string, state: unknown): unknown {
  const key = JSON.stringify([dir, hash])
  verifiedRuleSettings.delete(key)
  if (verifiedRuleSettings.size >= 8) verifiedRuleSettings.delete(verifiedRuleSettings.keys().next().value!)
  verifiedRuleSettings.set(key, { stamp, state: freezeModuleValue(state) })
  return state
}
export function readModuleDeclaredKeys(directory: string): Set<string> {
  return readCommittedDefinition(directory, (dir, commit) => {
    getVerifiedModuleInputs(dir, commit)
    return new Set(commit.declaredKeys)
  }, snapshot => new Set(Object.keys(snapshot.source)))
}

export function readCommittedVariables(directory: string): Pick<ModuleDefinitionSnapshot, 'variables' | 'variablesEnabled'> & { revisions: Pick<RuleRevisions, 'variables' | 'settings'> } {
  return readCommittedDefinition(directory, (dir, commit) => {
    const source = getVerifiedModuleInputs(dir, commit)
    const state = parseCommittedState(readModuleLocalObject(dir, commit.members[RULES_SETTINGS_FILE]!))
    const variables = parseLocal(readModuleLocalObject(dir, commit.members[RULES_VARIABLES_FILE]!)).toJS()
    assertVariableValues(variables)
    const variablesEnabled = source.variablesEnabled !== false
    if (!record(state) || !record(state.rules) || !isDeepStrictEqual(source.variables ?? {}, variables)
      || (source.variablesEnabled !== undefined && typeof source.variablesEnabled !== 'boolean') || state.variablesEnabled !== variablesEnabled) {
      throw new ModuleWriteError('模块清单与变量状态不一致')
    }
    const revisions = { variables: digest(variables), settings: digest({ rules: state.rules, variablesEnabled }) }
    if (state.variablesRevision !== revisions.variables || state.settingsRevision !== revisions.settings) throw new ModuleWriteError('模块变量状态版本无效')
    return { variables, variablesEnabled, revisions }
  }, snapshot => snapshot)
}

export function assertModuleDefinitionFormat(directory: string, writing = false): void {
  if (!writing) {
    readCommittedDefinition(directory, (dir, commit) => { getVerifiedModuleInputs(dir, commit) }, () => undefined)
    return
  }
  const dir = canonicalDirectory(directory)
  if (dirname(dir) === canonicalDirectory(packageModulesDir())) { loadModuleDefinition(dir); return }
  const head = readModuleLocalCommitInfo(dir)
  if (!head) throw new ModuleWriteError('缺少本地模块提交；请先安装或迁移模块')
  getVerifiedModuleInputs(dir, head)
}

export function readRulesDir(directory: string) {
  const snapshot = loadModuleDefinition(directory)
  const { contents, settings, variables, variablesEnabled, revisions } = projectedSnapshot(snapshot)
  const result = structuredClone({ contents, settings, variables, variablesEnabled, revisions })
  result.contents.sort((a,b) => result.settings[a.id]!.order - result.settings[b.id]!.order)
  return result
}

export function ensureModuleSlices(directory: string, _options: { writable?: boolean; force?: boolean; takeOwnership?: boolean } = {}): ModuleDefinitionSnapshot {
  return loadModuleDefinition(directory)
}

/** 从保留的来源 AST 投影当前代；未编辑节点（包括 alias 和注释）逐节点保留。 */
export function readModuleDefinitionExport(directory: string): {text: string; revision: string} {
  const identity = moduleDirectoryIdentity(directory)
  const snapshot = loadModuleDefinition(directory)
  if (basename(snapshot.file) === MODULE_DEFINITION_FILE) return {text: snapshot.text, revision: snapshot.revision}
  const head = installed(snapshot.dir)
  const commit = head.generation === snapshot.revision ? head : readPreviousModuleLocalCommit(snapshot.dir, head)
  if (commit?.generation !== snapshot.revision) throw sourceConflict()
  const doc = parseLocal(readModuleLocalObject(snapshot.dir, commit.exportBase))
  const original = doc.toJS()
  reconcileYaml(doc, doc.contents, original, snapshot.source)
  const text = serializeWithoutSharedAlias(doc, snapshot.source, '导出会改变 YAML 共享引用')
  if (moduleDirectoryIdentity(snapshot.dir) !== identity || installed(snapshot.dir).generation !== head.generation) throw sourceConflict()
  return {text, revision: snapshot.revision}
}

export function exportModuleDefinitionText(directory: string): string {
  return readModuleDefinitionExport(directory).text
}

function reconcileYaml(doc: ModuleDefinitionSnapshot['doc'], node: unknown, before: unknown, after: unknown): unknown {
  if (isDeepStrictEqual(before, after)) return node
  if (isMap(node) && record(before) && record(after)) {
    for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) node.delete(key)
    for (const [key, child] of Object.entries(after)) node.set(key, reconcileYaml(doc, node.get(key, true), before[key], child))
    return node
  }
  if (isSeq(node) && Array.isArray(before) && Array.isArray(after)) {
    const byId = new Map(before.flatMap((v, i) => record(v) && typeof v.id === 'string' ? [[v.id, i] as const] : []))
    const items = node.items
    node.items = after.map((v,i) => {
      const at = record(v) && typeof v.id === 'string' ? byId.get(v.id) : i
      return reconcileYaml(doc, at === undefined ? undefined : items[at], at === undefined ? undefined : before[at], v)
    })
    return node
  }
  const replacement = doc.createNode(after)
  if (isNode(node)) {
    replacement.comment = node.comment
    replacement.commentBefore = node.commentBefore
    if (isScalar(node) && isScalar(replacement)) {
      replacement.type = node.type
      replacement.anchor = node.anchor
    }
  }
  return replacement
}

export function commitModuleDefinition(snapshot: ModuleDefinitionSnapshot, next: string | ModuleDefinitionSnapshot['doc'], prepared?: ModuleDefinitionSnapshot): ModuleDefinitionSnapshot {
  const text = typeof next === 'string' ? next : next.toString()
  const candidate = prepared?.dir === snapshot.dir && prepared.text === text ? prepared : snapshotFromText(snapshot.dir, text)
  const projected = projectedSnapshot(candidate)
  return withModuleLock(dirname(snapshot.dir), basename(snapshot.dir), () => {
    const previous = installed(snapshot.dir)
    if (previous.generation !== snapshot.revision) throw sourceConflict()
    if (isDeepStrictEqual(candidate.source, snapshot.source)) return snapshot
    // 切片源内的别名在导出时必须仍能表达本次修改。
    let aliases: Pick<ModuleLocalCommit, 'hasSourceAliases' | 'aliasRuleIds'> = {}
    if (previous.hasSourceAliases) {
      const base = parseLocal(readModuleLocalObject(snapshot.dir, previous.exportBase))
      aliases = assertSlicableAliases(base)
      reconcileYaml(base, base.contents, base.toJS(), candidate.source)
      serializeWithoutSharedAlias(base, candidate.source, '保存会改变 YAML 共享引用')
    }
    const inputs = candidate.doc.clone()
    inputs.delete('rules')
    const members = Object.fromEntries(Object.entries(projected.files).map(([name,text]) => {
      const hash = revisionOf(text)
      return [name, previous.members[name] === hash ? hash : writeModuleLocalObject(snapshot.dir, text)]
    }))
    const commit = publishModuleLocalCommit(snapshot.dir, {
      moduleId: previous.moduleId, ...aliases, exportBase: previous.exportBase, declaredKeys: Object.keys(candidate.source),
      inputs: writeModuleLocalObject(snapshot.dir, inputs.toString()), ruleIds: projected.contents.map(rule => rule.id), members,
      hasProcessRules: candidate.rules.some(rule => rule.executionScope === 'process'),
    }, () => {
      if (installed(snapshot.dir).generation !== previous.generation) throw sourceConflict()
      projectedSnapshot(candidate)
    })
    candidate.revision = commit.generation
    candidate.file = snapshot.file
    return candidate
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

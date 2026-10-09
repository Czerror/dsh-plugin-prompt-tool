/** 旧规则只在显式离线迁移或外部导入时转换；运行时不调用此模块。 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { RuleAction, RuleCondition, RuleDefinition } from '../shared/rules.ts'
import { RULE_OWNED_MODEL_PARAMS } from '../shared/rules.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'
import { mergePromptConfigs, modelRequestConfigs } from './prompt-configs.ts'
import { readLegacyPromptParams, resolveLegacyPromptConfigs } from './legacy-prompt-params.ts'
import { readModuleLayerSettings } from './module-layer-settings.ts'
import { readConfigOrder } from './module-config-order.ts'
import { fillMissing, legacyPolicyDefaults, promptConfigToRule } from './rule-builder.ts'
import { rulePromptConfigOptions } from './module-rules.ts'
import { decomposeModule, validateModuleDefinitionText, withModuleLock } from './module-storage.ts'
import { assertModuleDirectory, assertModuleTree, canonicalModulesRoot } from './module-install.ts'
import { atomicWriteTextFile } from './text-file.ts'
import { MODULE_DEFINITION_FILE } from './paths.ts'
import { invalidateModuleSpec } from './manifest.ts'
import { isMap, isSeq, parseDocument } from 'yaml'
import { LEGACY_PROMPT_PARAM_KEYS } from '../shared/legacy-prompt-params.ts'
// @ts-expect-error 引擎是所有新规则的唯一校验器。
import { compileRules, injectionConfigSpec } from '../../engine/rule-spec.mjs'
// @ts-expect-error 离线转换读取旧声明的真实执行点。
import { actionExecutionPoint } from '../../engine/actions.mjs'
// @ts-expect-error 与旧条件层的缺省匹配对象同源；patch / unset 的合法键集也由引擎校验器派生。
import { createPromptConfigs, loadPromptConfigFiles, assertLlmCallPatch } from '../../engine/schema.mjs'
// @ts-expect-error 「固定注册效果」判据只在引擎实现一份。
import { isFixedRegistration } from '../../engine/rule-spec.mjs'
// @ts-expect-error 旧物化文件的顺序只在离线预检时读取。
import { FILE_SEQUENCE } from '../../engine/order.mjs'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const condition = (items: RuleCondition[]): RuleCondition | undefined => items.length === 0 ? undefined : items.length === 1 ? items[0] : { all: items }

/** 只递归条件语法树；正文、正则字符串及未知对象字段均不扫描或改写。 */
function migrateConditionDefaults(value: unknown): unknown {
  if (!record(value)) return value
  if (Object.keys(value).length !== 1) return value
  if (record(value.phase) && value.phase.promoteGate === true) {
    const phase = structuredClone(value.phase)
    fillMissing(phase, legacyPolicyDefaults().promotionGate)
    return { phase }
  }
  for (const key of ['all', 'any', 'notAny']) if (Array.isArray(value[key])) return { [key]: value[key].map(migrateConditionDefaults) }
  if (Object.hasOwn(value, 'not')) return { not: migrateConditionDefaults(value.not) }
  return value
}

/** 参数桥优先于行配置；仅旧定义里确已打开的指令提示才携入旧非空模板。 */
function instructionHintPolicyPatch(source: Record<string, unknown>): Record<string, unknown> | undefined {
  const params = readModuleLayerSettings(source)
  const modules = record(source.moduleConfigs) ? source.moduleConfigs : {}
  const current = record(modules['instruction-hint']) ? modules['instruction-hint'] : {}
  const enabled = Object.hasOwn(params, 'instructionHint') ? params.instructionHint === true : current.enabled === true
  if (!enabled) return undefined
  const patched = { ...current }
  fillMissing(patched, legacyPolicyDefaults().instructionHint)
  return JSON.stringify(current) === JSON.stringify(patched) ? undefined : patched
}

function rebaseTemplate(config: PromptConfigSpec, directory: string, previousBase: URL): PromptConfigSpec {
  if (typeof config.templateFile !== 'string' || config.templateFile.length === 0) return config
  const resolved = isAbsolute(config.templateFile) ? resolve(config.templateFile) : fileURLToPath(new URL(config.templateFile, previousBase))
  const path = relative(directory, resolved)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error(`模板路径不在模块目录，无法安全迁移：${config.templateFile}`)
  if (!existsSync(resolved)) throw new Error(`模板文件缺失，无法验证迁移：${config.templateFile}`)
  return { ...config, templateFile: `./${path.replaceAll(sep, '/')}` }
}

/** 旧 patch / unset 里不属于 LlmCallConfig 的键在迁移期剔除：新动作层白名单对这些键出现即拒，
 *  而它们在旧运行时本就不生效。合法键集与值规则都问引擎的 assertLlmCallPatch，不另抄一份名单。 */
function stripForeignLlmCallKeys(action: Record<string, unknown>, label: string): void {
  for (const field of ['patch', 'unset']) {
    if (!record(action[field])) continue
    const kept: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(action[field] as Record<string, unknown>)) {
      try { assertLlmCallPatch({ [key]: value }, `${label}.${field}`) } catch (error) {
        // ponytail: 靠引擎报错文本区分「非成员键」与「非法值」（文案改了只会退化成两者一起 fail loud）；
        // 引擎导出 LlmCallConfig 键集后改用 has 检查。这里不另抄名单——两份会漂移成误剔/漏剔。
        if (!(error instanceof Error) || !error.message.endsWith('is not a LlmCallConfig field')) throw error
        continue
      }
      kept[key] = value
    }
    action[field] = kept
  }
}

export function convertLegacyModuleRules(source: Record<string, unknown>, options: { directory?: string } = {}): { rules: RuleDefinition[]; configOrder: Record<string, number>; consumedLegacyKeys: string[] } {
  if (!record(source)) throw new TypeError('模块定义必须是对象')
  const directory = options.directory
  const legacy = resolveLegacyPromptConfigs(source, { moduleDir: directory })
  if (legacy.warnings.length > 0) throw new Error(`旧快捷参数没有无损承接规则：${legacy.warnings.join('; ')}`)
  if (source.promptConfigs !== undefined && !Array.isArray(source.promptConfigs)) throw new Error('promptConfigs 必须是数组')
  if (source.triggers !== undefined && !Array.isArray(source.triggers)) throw new Error('triggers 必须是数组')
  if (source.rules !== undefined && !Array.isArray(source.rules)) throw new Error('rules 必须是数组')
  const root = directory === undefined ? undefined : dirname(directory)
  let configs = mergePromptConfigs(modelRequestConfigs(readModuleLayerSettings(source)), legacy.configs)
  const rules: RuleDefinition[] = structuredClone((source.rules ?? []) as RuleDefinition[])
  const configOrder = readConfigOrder(source.configOrder)
  if (directory !== undefined && existsSync(join(directory, 'configs'))) {
    const actual = loadPromptConfigFiles(pathToFileURL(join(directory, 'configs') + sep)) as Array<PromptConfigSpec & Record<symbol, number>>
    for (const [index, config] of actual.entries()) if (configOrder[config.id] === undefined) configOrder[config.id] = config[FILE_SEQUENCE] ?? index * 10
    if (!Object.hasOwn(source, 'promptConfigs') && configs.length === 0) configs = actual
    else {
      const options = { sourceModuleId: source.id, configOrder, templateBaseUrl: pathToFileURL(join(root!, '.engine', 'prompt-config-engine.mjs')), templateModuleRoot: pathToFileURL(root! + sep) }
      const prepared = configs.map(config => injectionConfigSpec({ id: config.id }, { id: 'inject', kind: 'inject-text', config }, source))
      // 只对比结构，不恢复已退出的旧资格执行器；两侧同时替换策略名后参数/身份仍逐项比较。
      const comparable = (config: PromptConfigSpec): PromptConfigSpec => config.strategy === 'custom-fallback' ? { ...config, strategy: 'anchor-notice' } : config
      const expected = createPromptConfigs(prepared.map(comparable), options) as Array<Record<string, unknown>>
      const running = createPromptConfigs(actual.map(comparable), options) as Array<Record<string, unknown>>
      const fingerprint = (entries: Array<Record<string, unknown>>) => contentHash(entries.map(config => {
        const value = { ...config }
        // 禁用大文本曾在物化时瘦身；其正文从定义保留，不借迁移重新启用。
        if (value.enabled === false) delete value.texts
        return value
      }))
      if (fingerprint(expected) !== fingerprint(running)) throw new Error(`模块 ${String(source.id ?? directory)} 的定义与旧实际物化内容不一致，无法无损迁移；请先明确选择来源`)
    }
  }
  const append = (rule: RuleDefinition, sequence: number) => {
    if (rules.some(item => item.id === rule.id)) throw new Error(`规则身份冲突，须先明确改名：${rule.id}`)
    rules.push(rule)
    if (configOrder[rule.id] === undefined) configOrder[rule.id] = sequence
  }
  for (const [index, config] of configs.entries()) {
    const rebased = directory === undefined ? config : rebaseTemplate(config, directory, pathToFileURL(join(root!, '.engine', 'prompt-config-engine.mjs')))
    const rule = promptConfigToRule(rebased)
    for (const action of rule.then) stripForeignLlmCallKeys(action as Record<string, unknown>, `action ${String(action.id)}`)
    append(rule, index * 10)
  }
  for (const [index, raw] of ((source.triggers ?? []) as unknown[]).entries()) {
    if (!record(raw) || typeof raw.id !== 'string' || raw.id.length === 0) throw new Error('旧声明必须有唯一 id')
    const rawActions = Array.isArray(raw.do) ? raw.do : [raw.do]
    let enabled: boolean | undefined
    const gates: RuleCondition[] = raw.when == null ? [] : [migrateConditionDefaults(raw.when) as RuleCondition]
    const liftCondition = (gate: RuleCondition | undefined): void => {
      if (gate === undefined) return
      if (rawActions.length !== 1) throw new Error(`声明 ${raw.id} 的动作局部条件不能无损提升为整卡条件；请先拆分声明`)
      gates.push(gate)
    }
    const actions = rawActions.map((action, actionIndex): RuleAction => {
      if (!record(action) || typeof action.kind !== 'string') throw new Error(`旧声明 ${raw.id} 的动作不合法`)
      const point = actionExecutionPoint(action)
      if (raw.channel !== point.channel || (raw.phase !== undefined && raw.phase !== point.phase)) throw new Error(`旧声明 ${raw.id} 的执行点不合法`)
      const next = structuredClone(action)
      const actionId = typeof next.id === 'string' && next.id.length > 0 ? next.id : `action-${actionIndex + 1}`
      if (next.kind === 'inject-text' && record(next.config)) {
        const converted = promptConfigToRule(next.config as unknown as PromptConfigSpec)
        if (converted.enabled === false && rawActions.length !== 1) throw new Error(`声明 ${raw.id} 的动作局部停用不能无损提升为整卡开关；请先拆分声明`)
        if (rawActions.length === 1) enabled = converted.enabled
        liftCondition(converted.if)
        const payload = converted.then[0]?.config
        const config = { ...next.config, ...(record(payload) ? payload : {}) }
        delete config.enabled
        if (!isFixedRegistration(config)) {
          for (const key of ['audience', 'modelScope', 'promotion', 'subject', 'match']) delete config[key]
        }
        next.config = config
      }
      if (next.kind === 'request-params') {
        stripForeignLlmCallKeys(next, `action ${actionId}`)
        const modelScope = Object.hasOwn(next, 'modelScope') ? next.modelScope : 'pro'
        const scope = { ...(next.audience == null || next.audience === '' ? {} : { audience: next.audience }), ...(modelScope == null || modelScope === '' || modelScope === 'all' ? {} : { modelScope }) }
        if (Object.keys(scope).length > 0) liftCondition({ scope })
        delete next.audience; delete next.modelScope
      }
      if (next.kind === 'inject-text' && record(next.config) && directory !== undefined) next.config = rebaseTemplate(next.config as unknown as PromptConfigSpec, directory, pathToFileURL(join(directory, 'triggers.yml')))
      return { ...next, id: actionId, kind: action.kind, channelOrder: typeof raw.channelOrder === 'number' ? raw.channelOrder : 0, ...(raw.waterfallPosition === undefined ? {} : { waterfallPosition: raw.waterfallPosition as RuleAction['waterfallPosition'] }) }
    })
    // 旧声明逐动作注册，after-next 的执行次序受宿主 listener 次序影响；不能静默假定数组顺序等价。
    if (actions.length > 1 && actions.some(action => actionExecutionPoint(action).phase === 'after-next')) throw new Error(`声明 ${raw.id} 含多个 after-next 动作，须先核对实际执行顺序再迁移`)
    const layer = actions.find(action => action.kind === 'inject-text' && record(action.config))?.config as PromptConfigSpec | undefined
    append({ id: raw.id, ...(enabled === undefined ? {} : { enabled }), ...(layer?.layer === undefined ? {} : { layer: layer.layer as RuleDefinition['layer'] }), ...(condition(gates) === undefined ? {} : { if: condition(gates) }), then: actions }, (configs.length + index) * 10)
  }
  // 所有规则预检，互斥多启用不能由迁移命令擅自选择赢家。
  compileRules(rules, { configOrder, ...(directory === undefined ? {} : { moduleId: source.id, promptConfigOptions: rulePromptConfigOptions(directory) }) })
  return { rules, configOrder, consumedLegacyKeys: Object.keys(readLegacyPromptParams(source)) }
}

const MODEL_KEYS = RULE_OWNED_MODEL_PARAMS
const OLD_ENGINES = new Set(['prompt-config-engine', 'declared-triggers'])
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const sortedValue = (value: unknown): unknown => Array.isArray(value) ? value.map(sortedValue) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedValue(value[key])])) : value
const contentHash = (value: unknown): string => digest(JSON.stringify(sortedValue(value)))

/** 原证明仍匹配旧卡时才推进角色记忆哈希；用户改过的卡保持未认领。 */
function migrateMemoryProofs(doc: ReturnType<typeof parseDocument>, source: Record<string, unknown>, rules: RuleDefinition[]): void {
  const proofs = record(source.meta) && record(source.meta.characterMemories) ? source.meta.characterMemories : {}
  const configs = Array.isArray(source.promptConfigs) ? source.promptConfigs : []
  for (const [cardId, proof] of Object.entries(proofs)) {
    if (!record(proof) || typeof proof.configId !== 'string') continue
    const old = configs.find(config => record(config) && config.id === proof.configId)
    const rule = rules.find(item => item.id === proof.configId)
    if (old !== undefined && rule !== undefined && proof.contentHash === contentHash(old)) doc.setIn(['meta', 'characterMemories', cardId, 'contentHash'], contentHash(rule))
  }
}

/** 旧字段移入动作后仍把原注释保留在所属规则上，不把用户说明随旧段删除。 */
function setMigratedRules(doc: ReturnType<typeof parseDocument>, rules: RuleDefinition[]): void {
  const comments = (node: unknown): string[] => {
    const own = record(node) ? [node.commentBefore, node.comment].filter((value): value is string => typeof value === 'string' && value.length > 0) : []
    if (isMap(node)) return [...own, ...node.items.flatMap(pair => [...comments(pair.key), ...comments(pair.value)])]
    if (isSeq(node)) return [...own, ...node.items.flatMap(comments)]
    return own
  }
  const previous = ['rules', 'promptConfigs', 'triggers'].map(key => doc.get(key, true)).filter(isSeq)
  const nodes = doc.createNode(rules)
  if (isSeq(nodes)) {
    const groupComments = previous.flatMap(node => [node.commentBefore, node.comment].filter((value): value is string => typeof value === 'string'))
    if (groupComments.length > 0) nodes.commentBefore = groupComments.join('\n')
    for (const node of nodes.items) if (isMap(node)) {
      const original = previous.flatMap(item => item.items).find(item => isMap(item) && item.get('id') === node.get('id'))
      const text = comments(original).join('\n')
      if (text.length > 0) node.commentBefore = text
    }
  }
  doc.set('rules', nodes)
}

type DefinitionFile = typeof MODULE_DEFINITION_FILE
export interface RulesMigrationItem { moduleId: string; directory: string; definitionFile: DefinitionFile; originalHash: string; sourceHash: string; nextDefinition: string }
export interface RulesMigrationPlan { root: string; kind: 'modules'; items: RulesMigrationItem[] }

function assertAssetDirectory(root: string, id: string, definitionFile: DefinitionFile): string {
  if (definitionFile !== MODULE_DEFINITION_FILE) throw new Error('迁移只接受模块定义')
  return assertModuleDirectory(root, id)
}

/** 包括资产和生成物的整个模块指纹；回滚不覆盖迁移后出现的任意用户改动。 */
function treeHash(directory: string): string {
  assertModuleTree(directory)
  const hash = createHash('sha256')
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = join(dir, entry.name)
      const key = relative(directory, file).replaceAll(sep, '/')
      hash.update(JSON.stringify([key, entry.isDirectory() ? 'directory' : 'file', lstatSync(file).mode]))
      if (entry.isDirectory()) visit(file)
      else hash.update(readFileSync(file))
    }
  }
  visit(directory)
  return hash.digest('hex')
}

/** 全量只读预检。root 必须显式提供，不从真实 DSH_HOME 推断。 */
export function planRulesMigration(root: string, options: { decompose?: boolean } = {}): RulesMigrationPlan {
  if (typeof root !== 'string' || root.trim().length === 0 || !isAbsolute(root)) throw new Error('迁移必须显式指定绝对 --root（模块根目录）')
  const canonical = canonicalModulesRoot(root)
  const definitionFile = MODULE_DEFINITION_FILE
  const items: RulesMigrationItem[] = []
  for (const entry of readdirSync(canonical, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    if (entry.isSymbolicLink() && existsSync(join(canonical, entry.name, definitionFile))) throw new Error(`迁移目录不能是链接：${entry.name}`)
    if (!entry.isDirectory()) continue
    if (!existsSync(join(canonical, entry.name, definitionFile))) continue
    const directory = assertAssetDirectory(canonical, entry.name, definitionFile)
    assertModuleTree(directory)
    const bytes = readFileSync(join(directory, definitionFile))
    const doc = parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { logLevel: 'silent' })
    if (doc.errors.length > 0) throw new Error(`模块 ${entry.name} YAML 无效：${doc.errors[0]!.message}`)
    const source: unknown = doc.toJS()
    if (!record(source)) throw new Error(`模块 ${entry.name} 定义必须是对象`)
    const layerParams = readModuleLayerSettings(source)
    const oldModules = Array.isArray(source.modules) && source.modules.some(id => OLD_ENGINES.has(String(id)))
    const oldRules = Object.hasOwn(source, 'promptConfigs') || Object.hasOwn(source, 'triggers') || Object.keys(readLegacyPromptParams(source)).length > 0 || MODEL_KEYS.some(key => Object.hasOwn(layerParams, key)) || oldModules
    const hintPatch = oldRules || !Object.hasOwn(source, 'rules') ? instructionHintPolicyPatch(source) : undefined
    const needs = oldRules || hintPatch !== undefined
    if (!needs) {
      validateModuleDefinitionText(directory, doc.toString())
      if (options.decompose) items.push({ moduleId: entry.name, directory, definitionFile, originalHash: treeHash(directory), sourceHash: digest(bytes), nextDefinition: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })
      continue
    }
    if (options.decompose) throw new Error(`模块 ${entry.name} 仍含旧规则来源，请先运行 --apply 迁移再分解`)
    if (!Array.isArray(source.modules)) throw new Error(`模块 ${entry.name} 使用手写组合，无法证明旧引擎装配替换；请先显式整理 modules`)
    if (record(source.params) && LEGACY_PROMPT_PARAM_KEYS.some(key => Object.hasOwn(source.params!, key))) throw new Error(`模块 ${entry.name} 含曾被运行时忽略的顶层旧参数，无法推测激活语义`)
    const converted = convertLegacyModuleRules(source, { directory })
    if (hintPatch !== undefined) for (const [key, value] of Object.entries(hintPatch)) {
      if (!doc.hasIn(['moduleConfigs', 'instruction-hint', key])) doc.setIn(['moduleConfigs', 'instruction-hint', key], value)
    }
    migrateMemoryProofs(doc, source, converted.rules)
    setMigratedRules(doc, converted.rules)
    doc.set('configOrder', converted.configOrder)
    doc.delete('promptConfigs'); doc.delete('triggers')
    if (Array.isArray(source.modules)) doc.set('modules', [...new Set(source.modules.map(id => OLD_ENGINES.has(String(id)) ? 'rule-engine' : id))])
    if (record(source.layerSettings)) for (const [layer, values] of Object.entries(source.layerSettings)) if (record(values)) {
      for (const key of [...converted.consumedLegacyKeys, ...MODEL_KEYS]) if (Object.hasOwn(values, key)) doc.deleteIn(['layerSettings', layer, key])
    }
    if (record(source.moduleConfigs)) {
      const strategies = [source.moduleConfigs['prompt-config-engine'], source.moduleConfigs['declared-triggers']].filter(record).map(value => value.strategyDir).filter(value => typeof value === 'string' && value.length > 0)
      if (strategies.length > 0) throw new Error(`模块 ${entry.name} 使用自定义策略目录，需先确认统一基准后迁移`)
      for (const id of OLD_ENGINES) doc.deleteIn(['moduleConfigs', id])
    }
    validateModuleDefinitionText(directory, doc.toString())
    items.push({ moduleId: entry.name, directory, definitionFile, originalHash: treeHash(directory), sourceHash: digest(bytes), nextDefinition: doc.toString() })
  }
  return { root: canonical, kind: 'modules', items }
}

interface BackupEntry { moduleId: string; definitionFile: DefinitionFile; before: string; after: string; written: boolean }
interface BackupManifest { version: 1; root: string; status: 'applying' | 'applied' | 'rolled-back'; entries: BackupEntry[] }
const BACKUP_DIR = '.rules-migration-backup'

/** 先完整生成所有候选，再复核全根；每个模块以目录 rename 原子交换并保留原树备份。 */
export async function applyRulesMigration(plan: RulesMigrationPlan): Promise<{ changed: string[]; backup?: string }> {
  if (canonicalModulesRoot(plan.root) !== plan.root) throw new Error('迁移根目录身份已变化')
  if (plan.items.length === 0) return { changed: [] }
  const backup = join(plan.root, BACKUP_DIR)
  if (existsSync(backup)) throw new Error(`已存在迁移备份，请先处理：${backup}`)
  const workspace = mkdtempSync(join(plan.root, '.rules-migration-stage-'))
  const staged = new Map<string, string>()
  const manifest: BackupManifest = { version: 1, root: plan.root, status: 'applying', entries: [] }
  const manifestFile = join(backup, 'manifest.json')
  const verify = (item: RulesMigrationItem) => {
    if (assertAssetDirectory(plan.root, item.moduleId, item.definitionFile) !== item.directory || treeHash(item.directory) !== item.originalHash
      || digest(readFileSync(join(item.directory, item.definitionFile))) !== item.sourceHash) throw new Error(`来源 ${item.moduleId} 在预检后已变化，未覆盖`)
  }
  try {
    for (const item of plan.items) {
      verify(item)
      const source = join(workspace, item.moduleId)
      cpSync(item.directory, source, { recursive: true, errorOnExist: true, force: false })
      atomicWriteTextFile(join(source, item.definitionFile), item.nextDefinition)
      decomposeModule(source)
      for (const path of ['rules.yml', 'configs', 'agent.cordis.yml', 'custom-tools', 'subagent-tools']) rmSync(join(source, path), { recursive: true, force: true })
      const generated = source
      staged.set(item.moduleId, generated)
      manifest.entries.push({ moduleId: item.moduleId, definitionFile: item.definitionFile, before: item.originalHash, after: treeHash(generated), written: false })
    }
    for (const item of plan.items) verify(item)
    mkdirSync(backup)
    atomicWriteTextFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
    for (const item of plan.items) {
      withModuleLock(plan.root, item.moduleId, () => {
        verify(item)
        const old = join(backup, item.moduleId)
        renameSync(item.directory, old)
        try { renameSync(staged.get(item.moduleId)!, item.directory) }
        catch (error) { if (!existsSync(item.directory)) renameSync(old, item.directory); throw error }
        manifest.entries.find(entry => entry.moduleId === item.moduleId)!.written = true
        invalidateModuleSpec(item.directory)
        atomicWriteTextFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
      })
    }
    manifest.status = 'applied'
    atomicWriteTextFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
    return { changed: plan.items.map(item => item.moduleId), backup }
  } catch (error) {
    // 只恢复仍与本次生成指纹完全相同的模块；外部更改发生时保留备份供人工处理。
    for (const entry of [...manifest.entries].reverse()) if (entry.written) {
      const current = join(plan.root, entry.moduleId)
      const original = join(backup, entry.moduleId)
      withModuleLock(plan.root, entry.moduleId, () => {
        if (existsSync(current) && treeHash(current) === entry.after && existsSync(original)) {
          const retired = join(workspace, `failed-${entry.moduleId}`)
          renameSync(current, retired); renameSync(original, current); entry.written = false
          invalidateModuleSpec(current)
        }
      })
    }
    if (existsSync(manifestFile)) atomicWriteTextFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
    throw error
  } finally {
    if (dirname(workspace) === plan.root && workspace.startsWith(join(plan.root, '.rules-migration-stage-'))) rmSync(workspace, { recursive: true, force: true })
  }
}

export function rollbackRulesMigration(root: string, options: { checkOnly?: boolean } = {}): { restored: string[] } {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('回滚必须显式指定绝对 --root')
  const canonical = canonicalModulesRoot(root)
  const backup = join(canonical, BACKUP_DIR)
  if (lstatSync(backup).isSymbolicLink()) throw new Error('迁移备份不能是链接')
  const file = join(backup, 'manifest.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as BackupManifest
  if (manifest.version !== 1 || manifest.root !== canonical || !Array.isArray(manifest.entries)) throw new Error('迁移备份不属于当前根')
  if (manifest.status === 'rolled-back') return { restored: [] }
  const targets = manifest.entries.filter(entry => entry.written)
  // 回滚前先校验所有目标及备份，任一外部改动都不启动交换。
  for (const entry of targets) {
    if (entry.definitionFile !== MODULE_DEFINITION_FILE) throw new Error('迁移备份定义类型无效')
    const current = assertAssetDirectory(canonical, entry.moduleId, entry.definitionFile)
    const original = assertAssetDirectory(backup, entry.moduleId, entry.definitionFile)
    if (treeHash(current) !== entry.after || treeHash(original) !== entry.before) throw new Error(`模块 ${entry.moduleId} 或备份已变化，拒绝回滚覆盖`)
    if (existsSync(join(backup, `${entry.moduleId}.migrated`))) throw new Error(`模块 ${entry.moduleId} 的回滚保留目录已存在`)
  }
  if (options.checkOnly === true) return { restored: targets.map(entry => entry.moduleId) }
  for (const entry of targets) {
    const current = join(canonical, entry.moduleId)
    const retired = join(backup, `${entry.moduleId}.migrated`)
    withModuleLock(canonical, entry.moduleId, () => {
      if (treeHash(current) !== entry.after || treeHash(join(backup, entry.moduleId)) !== entry.before) throw new Error(`模块 ${entry.moduleId} 在回滚期间变化，未覆盖`)
      renameSync(current, retired)
      try { renameSync(join(backup, entry.moduleId), current) }
      catch (error) { if (!existsSync(current)) renameSync(retired, current); throw error }
      entry.written = false
      invalidateModuleSpec(current)
      atomicWriteTextFile(file, JSON.stringify(manifest, null, 2) + '\n')
    })
  }
  manifest.status = 'rolled-back'
  atomicWriteTextFile(file, JSON.stringify(manifest, null, 2) + '\n')
  return { restored: targets.map(entry => entry.moduleId) }
}

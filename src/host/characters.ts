/** 角色卡只是普通模块的导入来源；历史角色库仅用于分享过滤的只读核验。 */
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parse as parseYaml, parseDocument, YAMLSeq } from 'yaml'
import type { StConversionOptions } from './sillytavern.ts'
import { prepareImport, validateCharacterSpec } from './import-source.ts'
import { assertModuleDirectory, assertModuleId, assertNoModuleLinks as assertNoLinks, modulePathExists } from './module-install.ts'
import { readModuleMemory } from './module-memory.ts'
import { MODULE_DEFINITION_FILE } from './paths.ts'
import { appendModuleCapabilities } from './module-capabilities.ts'
import { withModuleDefinition } from './module-definition-edit.ts'
import { assertCanonicalRuleSource, rulePromptConfigOptions } from './module-storage.ts'
import { mapRuleInjections, ruleInjections } from './rule-content.ts'
// 共享规则编译器校验模块并入候选。
import { compileRules } from '../../engine/rule-spec.mjs'
import { engineParamPath, readModuleLayerSettings } from './module-layer-settings.ts'
import type { ModuleSpec } from './module-spec.ts'
import type { AssetFile, ImportChoices } from '../shared/asset-transfer.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function loadSpecFile(file: string): ModuleSpec | undefined {
  assertNoLinks(file)
  if (!modulePathExists(file)) return undefined
  const parsed = parseYaml(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  if (!isRecord(parsed)) throw new Error(`模块定义不是对象：${file}`)
  assertCanonicalRuleSource(parsed)
  return parsed as unknown as ModuleSpec
}

function loadModuleSource(root: string, id: string): ModuleSpec | undefined {
  assertModuleId(id)
  const dir = join(root, id)
  assertNoLinks(dir)
  if (!modulePathExists(dir)) return undefined
  return loadSpecFile(join(assertModuleDirectory(root, id), MODULE_DEFINITION_FILE))
}

function importPrefixes(id: string): readonly string[] {
  return [`module-${id}-`]
}

/** 私有记忆归独立文件；无法证明安全的旧定义必须显式转换后才能分享。 */
export function projectCharacterMemories(
  source: ReturnType<typeof parseDocument>,
  _choices: Record<string, 'include' | 'exclude'> = {},
  moduleRoot?: string,
): { doc: ReturnType<typeof parseDocument>; excludedMemoryCount: number; memoryConflicts: Array<{ id: string; name: string }> } {
  const doc = source.clone()
  const spec = doc.toJS() as ModuleSpec
  if (isRecord(spec.meta) && ['characterMemories', 'importedCharacters', 'characterModules'].some(key => Object.hasOwn(spec.meta!, key))) {
    throw new Error('模块含旧私有记忆或角色来源标记；请重新导入或显式转换并核对记忆归属后再导出')
  }
  const imported = Object.keys(readMergedModules(spec.meta))
  assertCanonicalRuleSource(spec)
  for (const config of spec.rules ?? []) {
    if (!isRecord(config) || typeof config.id !== 'string') continue
    const id = config.id
    const cardId = imported.find(card => importPrefixes(card).some(base => id === `${base}memory` || id.startsWith(`${base}memory-`)))
    if (cardId === undefined) continue
    if (moduleRoot !== undefined) {
      assertModuleId(cardId)
      const original = loadModuleSource(moduleRoot, cardId)
      if (original?.rules?.some(entry => importPrefixes(cardId).some(base => `${base}${entry.id}` === id))) continue
    }
    throw new Error(`无法证明规则 ${id} 的旧记忆来源；请显式转换并核对私有内容后再导出`)
  }
  return { doc, excludedMemoryCount: 0, memoryConflicts: [] }
}

type CharacterImportOptions = StConversionOptions & ImportChoices
type CharacterImportResult = { ok: true; id: string; name: string; warning?: string } | { ok: false; message: string }
function importChoices(options: CharacterImportOptions): ImportChoices {
  return { ...options, promptOrderCharacterId: options.promptOrderCharacterId ?? options.characterId }
}

/** 复用普通模块候选校验、版本保护和目录交换，不生成角色专属存储。 */
export async function importCharacterCard(root: string, files: AssetFile[], options: CharacterImportOptions = {}): Promise<CharacterImportResult> {
  try {
    const prepared = prepareImport(files, 'character', importChoices(options))
    if (prepared.state !== 'ready') return { ok: false, message: '请先选择角色内容类型或提示顺序组' }
    const moduleFiles = prepared.files
    // 分享过滤引用本文件，动态加载安装器避免初始化阶段循环。
    const { moduleImportPreview, installModulePackage } = await import('./module-package.ts')
    const request = { ...importChoices(options), sourceKind: 'native-character' as const }
    const preview = moduleImportPreview(root, moduleFiles, request)
    if (!('prepared' in preview)) return { ok: false, message: '请先选择角色内容类型或提示顺序组' }
    if (preview.summary.exists && options.overwrite === true) readModuleMemory(join(root, preview.summary.targetId))
    const installed = await installModulePackage(root, moduleFiles, { ...request, expectedSourceDigest: preview.sourceDigest, expectedPreviewRevision: preview.previewRevision }, { preserveAssets: true })
    return { ok: true, id: installed.id, name: preview.summary.targetName, ...(installed.backupPath === undefined ? {} : { warning: `模块已安装；旧备份保留在 ${installed.backupPath}` }) }
  } catch (error) { return { ok: false, message: `角色卡导入失败：${error instanceof Error ? error.message : String(error)}` } }
}

export async function importCharacterCardFile(root: string, filePath: string, fileName = basename(filePath), options: CharacterImportOptions = {}): Promise<CharacterImportResult> {
  try {
    const buffer = readFileSync(filePath)
    return await importCharacterCard(root, [{ path: basename(fileName), content: buffer.toString('base64'), encoding: 'base64' }], options)
  } catch (error) { return { ok: false, message: `角色卡转换失败：${error instanceof Error ? error.message : String(error)}` } }
}

interface MergedModule { active: boolean; capabilities: string[]; variables?: Record<string, string> }

/** 并入登记只属于原生模块；不推断旧角色库所有权。 */
function readMergedModules(meta: unknown): Record<string, MergedModule> {
  if (!isRecord(meta)) return {}
  if (meta.importedCharacters !== undefined || meta.characterModules !== undefined) throw new Error('旧角色来源登记已退役，请显式转换为原生模块')
  if (isRecord(meta.mergedModules)) return Object.fromEntries(Object.entries(meta.mergedModules).filter(([, value]) =>
    isRecord(value) && typeof value.active === 'boolean' && Array.isArray(value.capabilities)).map(([id, value]) => {
    const row = value as Record<string, unknown>
    return [id, { active: row.active === true, capabilities: (row.capabilities as unknown[]).filter((item): item is string => typeof item === 'string'),
      ...(isRecord(row.variables) ? { variables: Object.fromEntries(Object.entries(row.variables).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}) }]
  }))
  return {}
}

function writeMergedModules(doc: ReturnType<typeof parseDocument>, records: Record<string, MergedModule>): void {
  doc.setIn(['meta', 'mergedModules'], records)
}

function declaredCapabilities(spec: ModuleSpec): string[] {
  return Array.isArray(spec.modules) ? [...new Set(spec.modules.filter((item): item is string => typeof item === 'string' && item.length > 0))] : []
}

function readCapabilities(doc: ReturnType<typeof parseDocument>): string[] {
  return declaredCapabilities(doc.toJS() as ModuleSpec)
}

function capabilityStillNeeded(capability: string, spec: ModuleSpec, active: readonly string[]): boolean {
  const configs = ruleInjections(spec.rules ?? []).map(({ config }) => config)
  switch (capability) {
    case 'rule-engine': return (spec.rules?.length ?? 0) > 0
    case 'module-rule-tools': return configs.some(config => config.strategy === 'context-activation')
    case 'module-variable-tools': return configs.some(config => isRecord(config.params) && config.params.templateEvaluation === true)
    case 'module-memory-tools': return active.length > 0
    case 'tool-config-engine': return (spec.customTools?.length ?? 0) > 0
    case 'module-import-tools': return active.length > 0 || configs.some(config => String(config.id ?? '').startsWith('module-'))
    default: return true
  }
}

/** 通用并入保留既有带前缀往返行为，不复制本地记忆。 */
export function mergeModuleIntoModule(root: string, targetId: string, sourceId: string):
  { ok: true; count: number; personaOpened?: boolean } | { ok: false; message: string } {
  try {
    if (sourceId === targetId) throw new Error('不能把模块并入自身')
    const dir = assertModuleDirectory(root, targetId)
    const spec = loadModuleSource(root, sourceId)
    if (spec === undefined) throw new Error(`模块 ${sourceId} 不存在`)
    validateCharacterSpec(spec)
    const prefix = `module-${sourceId}-`
    let count = 0
    let personaOpened = false
    withModuleDefinition(dir, doc => {
      const current = doc.toJS() as ModuleSpec
      assertCanonicalRuleSource(current)
      if (ruleInjections(spec.rules).some(({ config }) => config.layer === 'system-section')) {
        for (const audience of ['main', 'subagent'] as const) if (current.persona?.[audience]?.complete === true) {
          doc.setIn(['persona', audience, 'complete'], false)
          personaOpened = true
        }
      }
      const existing = (current.rules ?? []).filter(rule => !importPrefixes(sourceId).some(base => rule.id.startsWith(base)))
      const records = readMergedModules(current.meta)
      const introducedVariables = { ...records[sourceId]?.variables }
      for (const [key, value] of Object.entries(spec.variablesEnabled === false ? {} : spec.variables ?? {})) {
        if (Object.hasOwn(current.variables ?? {}, key) && current.variables![key] !== value) throw new Error(`模块变量 ${key} 存在不同值，请先显式改名再并入`)
        if (!Object.hasOwn(current.variables ?? {}, key)) { doc.setIn(['variables', key], value); introducedVariables[key] = value }
      }
      const added = (spec.rules ?? []).map(rule => mapRuleInjections({ ...rule, id: `${prefix}${rule.id}` }, config => ({
        ...config, ...(typeof config.id === 'string' ? { id: `${prefix}${config.id}` } : {}),
      })))
      for (const [key, value] of Object.entries(readModuleLayerSettings(spec))) doc.setIn(engineParamPath(key), value)
      const merged = [...existing, ...added]
      compileRules(merged, { promptConfigOptions: rulePromptConfigOptions(dir) })
      const before = readCapabilities(doc)
      const required = ['rule-engine', ...(ruleInjections(merged).some(({ config }) => config.strategy === 'context-activation') ? ['module-rule-tools', 'module-memory-tools'] : [])]
      appendModuleCapabilities(doc, [...new Set([...declaredCapabilities(spec), ...required])])
      records[sourceId] = { active: true, capabilities: [...new Set([...(records[sourceId]?.capabilities ?? []), ...readCapabilities(doc).filter(capability => !before.includes(capability))])], variables: introducedVariables }
      writeMergedModules(doc, records)
      const ruleNodes = doc.get('rules', true)
      if (ruleNodes instanceof YAMLSeq) {
        ruleNodes.items = ruleNodes.items.filter((_, index) => existing.includes(current.rules![index]!))
        for (const rule of added) ruleNodes.add(doc.createNode(rule))
      } else doc.set('rules', merged)
      if (Array.isArray(spec.meta?.stWarnings) && spec.meta.stWarnings.length > 0) {
        const warnings = Array.isArray(current.meta?.stWarnings) ? current.meta.stWarnings : []
        doc.setIn(['meta', 'stWarnings'], [...new Set([...warnings, ...spec.meta.stWarnings].filter(value => typeof value === 'string'))])
      }
      count = added.length
    }, { owns: ['rules', 'configOrder', 'variables', 'layerSettings', 'modules', 'meta', 'persona'] })
    return { ok: true, count, ...(personaOpened ? { personaOpened: true } : {}) }
  } catch (error) { return { ok: false, message: `并入失败：${error instanceof Error ? error.message : String(error)}` } }
}

/** 撤销来源规则及仍未被修改、也未被其它来源依赖的自有变量。 */
export function removeMergedModule(root: string, targetId: string, sourceId: string): { ok: true; count: number } | { ok: false; message: string } {
  try {
    assertModuleId(sourceId)
    const dir = assertModuleDirectory(root, targetId)
    const spec = loadModuleSource(root, sourceId)
    let removed = 0
    withModuleDefinition(dir, doc => {
      const current = doc.toJS() as ModuleSpec
      assertCanonicalRuleSource(current)
      const kept = (current.rules ?? []).filter(rule => !importPrefixes(sourceId).some(base => rule.id.startsWith(base)))
      removed = (current.rules?.length ?? 0) - kept.length
      compileRules(kept, { promptConfigOptions: rulePromptConfigOptions(dir) })
      const ruleNodes = doc.get('rules', true)
      if (ruleNodes instanceof YAMLSeq) ruleNodes.items = ruleNodes.items.filter((_, index) => kept.includes(current.rules![index]!))
      else doc.set('rules', kept)
      for (const rule of current.rules ?? []) if (!kept.some(item => item.id === rule.id) && doc.hasIn(['configOrder', rule.id])) doc.deleteIn(['configOrder', rule.id])
      for (const [key, value] of Object.entries(spec === undefined ? {} : readModuleLayerSettings(spec))) {
        const path = engineParamPath(key)
        if (doc.getIn(path) === value) doc.deleteIn(path)
      }
      const records = readMergedModules(current.meta)
      if (records[sourceId] !== undefined) records[sourceId]!.active = false
      const active = Object.keys(records).filter(id => records[id]!.active)
      const others = active.map(id => loadModuleSource(root, id))
      for (const [key, value] of Object.entries(records[sourceId]?.variables ?? {})) {
        if (current.variables?.[key] === value && others.every(other => other !== undefined && !Object.hasOwn(other.variables ?? {}, key))) doc.deleteIn(['variables', key])
      }
      const claimed = new Set<string>()
      for (const id of active) {
        for (const capability of records[id]!.capabilities) claimed.add(capability)
        const other = loadModuleSource(root, id)
        if (other !== undefined) for (const capability of declaredCapabilities(other)) claimed.add(capability)
      }
      const introduced = new Set(Object.values(records).flatMap(record => record.capabilities))
      const next = readCapabilities(doc).filter(capability => !introduced.has(capability) || claimed.has(capability)
        || capabilityStillNeeded(capability, doc.toJS() as ModuleSpec, active))
      doc.set('modules', next)
      for (const [id, record] of Object.entries(records)) {
        record.capabilities = record.capabilities.filter(capability => next.includes(capability))
        if (!record.active && record.capabilities.length === 0) delete records[id]
      }
      writeMergedModules(doc, records)
    }, { owns: ['rules', 'configOrder', 'variables', 'layerSettings', 'modules', 'meta'] })
    return { ok: true, count: removed }
  } catch (error) { return { ok: false, message: `移除失败：${error instanceof Error ? error.message : String(error)}` } }
}

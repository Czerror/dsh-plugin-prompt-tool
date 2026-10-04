/** 角色卡只是普通模块的导入来源；历史角色库仅用于分享过滤的只读核验。 */
import { readFileSync, writeFileSync, appendFileSync, lstatSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { parse as parseYaml, parseDocument, YAMLSeq } from 'yaml'
import { createHash } from 'node:crypto'
import type { StConversionOptions, StOrderGroupSummary } from './sillytavern.ts'
import { prepareImport, assetSourceDigest, normalizeAssetFiles, validateCharacterSpec } from './import-source.ts'
import { assertModuleDirectory, assertModuleId, modulePathExists } from './module-install.ts'
import { MODULE_DEFINITION_FILE } from './paths.ts'
import { appendModuleCapabilities, withModuleDefinition } from './manifest.ts'
import { assertCanonicalRuleSource, rulePromptConfigOptions } from './module-rules.ts'
import { promptConfigToRule } from './rules-migration.ts'
import { mapRuleInjections, ruleInjections } from './rule-content.ts'
// @ts-expect-error 共享规则编译器校验模块并入候选。
import { compileRules } from '../../engine/rule-spec.mjs'
import { engineParamPath, readModuleLayerSettings } from './module-layer-settings.ts'
import { buildWorldBookEntry } from './worldbook.ts'
import type { ModuleSpec } from './manifest.ts'
import type { StConversionReport } from '../shared/bridge-contract.ts'
import type { AssetFile, ImportChoices, ImportKind } from '../shared/asset-transfer.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 检查祖先与最终文件，避免 junction 或单文件链接越界。 */
function assertNoLinks(path: string): void {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  if (parent !== absolute) assertNoLinks(parent)
  if (modulePathExists(absolute) && lstatSync(absolute).isSymbolicLink()) throw new Error(`模块路径包含链接：${absolute}`)
}

function memoryFile(moduleDir: string): string {
  assertNoLinks(moduleDir)
  return join(assertModuleDirectory(dirname(moduleDir), basename(moduleDir)), 'memory.md')
}

/** 模块记忆与条目同归当前模块；来源和 id 前缀不改变位置。 */
export function appendModuleMemory(moduleDir: string, note: string): void {
  const content = note.trim()
  if (content.length === 0) return
  const file = memoryFile(moduleDir)
  assertNoLinks(file)
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const line = `\n- [${stamp}] ${content}\n`
  if (modulePathExists(file)) appendFileSync(file, line, 'utf8')
  else writeFileSync(file, `# 本地记忆\n${line}`, 'utf8')
}

/** 每次显式读取最新字节；缺失为空，链接与读取失败原样报错。 */
export function readModuleMemory(moduleDir: string): string {
  const file = memoryFile(moduleDir)
  assertNoLinks(file)
  return modulePathExists(file) ? readFileSync(file, 'utf8') : ''
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

const CHARACTER_MEMORIES_KEY = 'characterMemories'
interface CharacterMemoryRecord { characterId: string; configId: string; contentHash: string }

function contentHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : isRecord(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function memoryRecords(meta: unknown): Record<string, CharacterMemoryRecord> {
  if (!isRecord(meta) || !isRecord(meta[CHARACTER_MEMORIES_KEY])) return {}
  return Object.fromEntries(Object.entries(meta[CHARACTER_MEMORIES_KEY]).filter(([id, record]) => isRecord(record)
    && record.characterId === id && typeof record.configId === 'string' && typeof record.contentHash === 'string')) as Record<string, CharacterMemoryRecord>
}

function importPrefixes(id: string): readonly string[] {
  return [`module-${id}-`, `chara-${id}-`]
}

/** 分享副本只排除可核验的历史自动记忆；来源缺失或被编辑时须明确选择。 */
export function projectCharacterMemories(
  source: ReturnType<typeof parseDocument>,
  choices: Record<string, 'include' | 'exclude'> = {},
  moduleRoot?: string,
): { doc: ReturnType<typeof parseDocument>; excludedMemoryCount: number; memoryConflicts: Array<{ id: string; name: string }> } {
  const doc = source.clone()
  const spec = doc.toJS() as ModuleSpec
  const records = memoryRecords(spec.meta)
  const imported = [...new Set([
    ...(Array.isArray(spec.meta?.importedCharacters) ? spec.meta.importedCharacters.filter((id): id is string => typeof id === 'string') : []),
    ...Object.keys(readMergedModules(spec.meta)),
  ])]
  const conflicts: Array<{ id: string; name: string }> = []
  const excluded = new Set<number>()
  assertCanonicalRuleSource(spec)
  for (const [index, config] of (spec.rules ?? []).entries()) {
    if (!isRecord(config) || typeof config.id !== 'string') continue
    const id = config.id
    const proof = Object.values(records).find(record => record.configId === id)
    if (proof !== undefined && proof.contentHash === contentHash(config)) { excluded.add(index); continue }
    const cardId = imported.find(card => importPrefixes(card).some(base => id === `${base}memory` || id.startsWith(`${base}memory-`))) ?? proof?.characterId
    if (cardId === undefined) continue
    if (moduleRoot !== undefined) {
      assertModuleId(cardId)
      const legacyDir = join(dirname(moduleRoot), '.characters', cardId)
      const normal = loadModuleSource(moduleRoot, cardId)
      const original = normal ?? loadSpecFile(join(legacyDir, 'converted.yml'))
      if (original?.rules?.some(entry => importPrefixes(cardId).some(base => `${base}${entry.id}` === id))) continue
      const file = join(normal === undefined ? legacyDir : join(moduleRoot, cardId), 'memory.md')
      assertNoLinks(file)
      const memory = modulePathExists(file) ? readFileSync(file, 'utf8').trim() : ''
      if (original !== undefined && memory.length > 0) {
        const entry = buildWorldBookEntry({ name: '角色记忆', enabled: true, order: 3000, text: `【${original.name} 的关系记忆】\n${memory}`, constant: true })
        if (contentHash(promptConfigToRule({ ...entry, id })) === contentHash(config)) { excluded.add(index); continue }
      }
    }
    if (choices[id] === 'exclude') excluded.add(index)
    else if (choices[id] !== 'include') conflicts.push({ id, name: String(config.name ?? id) })
  }
  const configs = doc.get('rules', true)
  if (configs instanceof YAMLSeq) for (const index of [...excluded].sort((a, b) => b - a)) configs.delete(index)
  else if (excluded.size > 0) doc.set('rules', (spec.rules ?? []).filter((_, index) => !excluded.has(index)))
  if (doc.hasIn(['meta', CHARACTER_MEMORIES_KEY])) doc.deleteIn(['meta', CHARACTER_MEMORIES_KEY])
  return { doc, excludedMemoryCount: excluded.size, memoryConflicts: conflicts }
}

type CharacterImportOptions = StConversionOptions & ImportChoices
type CharacterImportResult = { ok: true; id: string; name: string; warning?: string } | { ok: false; message: string }
function importChoices(options: CharacterImportOptions): ImportChoices {
  return { ...options, promptOrderCharacterId: options.promptOrderCharacterId ?? options.characterId }
}

export function characterOrderSelectionState(files: AssetFile[], options: CharacterImportOptions = {}):
  { needsSelection: true; candidates: StOrderGroupSummary[] } | { needsSelection: false; error?: string } {
  try {
    const prepared = prepareImport(files, 'character', importChoices(options))
    return prepared.state === 'needs-order-selection' ? { needsSelection: true, candidates: prepared.candidates } : { needsSelection: false }
  } catch (error) { return { needsSelection: false, error: error instanceof Error ? error.message : String(error) } }
}

export function characterImportDigest(files: AssetFile[]): string {
  return assetSourceDigest(normalizeAssetFiles(files))
}

export function previewCharacterCard(files: AssetFile[], options: CharacterImportOptions = {}):
  { ok: true; name: string; id: string; sourceDigest: string; report?: StConversionReport; kind: ImportKind; files: AssetFile[]; sourceName: string } | { ok: false; message: string } {
  try {
    const prepared = prepareImport(files, 'character', importChoices(options))
    if (prepared.state !== 'ready') return { ok: false, message: '请先选择角色内容类型或提示顺序组' }
    return { ok: true, name: prepared.spec.name, id: prepared.spec.id, sourceDigest: prepared.sourceDigest, report: prepared.report, kind: prepared.kind, files: prepared.files, sourceName: prepared.sourceName }
  } catch (error) { return { ok: false, message: `角色卡转换失败：${error instanceof Error ? error.message : String(error)}` } }
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

interface MergedModule { active: boolean; capabilities: string[] }

/** 旧登记仅在此读边界转换，新写入只落 mergedModules。 */
function readMergedModules(meta: unknown): Record<string, MergedModule> {
  if (!isRecord(meta)) return {}
  if (isRecord(meta.mergedModules)) return Object.fromEntries(Object.entries(meta.mergedModules).filter(([, value]) =>
    isRecord(value) && typeof value.active === 'boolean' && Array.isArray(value.capabilities)).map(([id, value]) => {
    const row = value as Record<string, unknown>
    return [id, { active: row.active === true, capabilities: (row.capabilities as unknown[]).filter((item): item is string => typeof item === 'string') }]
  }))
  const active = Array.isArray(meta.importedCharacters) ? meta.importedCharacters.filter((id): id is string => typeof id === 'string') : []
  const old = isRecord(meta.characterModules) ? meta.characterModules : {}
  return Object.fromEntries([...new Set([...active, ...Object.keys(old)])].map(id => [id, {
    active: active.includes(id), capabilities: Array.isArray(old[id]) ? old[id].filter((item): item is string => typeof item === 'string') : [],
  }]))
}

function writeMergedModules(doc: ReturnType<typeof parseDocument>, records: Record<string, MergedModule>): void {
  doc.setIn(['meta', 'mergedModules'], records)
  for (const key of ['importedCharacters', 'characterModules']) if (doc.hasIn(['meta', key])) doc.deleteIn(['meta', key])
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
    case 'prompt-config-engine': return configs.length > 0
    case 'world-book-tools': return configs.some(config => config.strategy === 'world-book')
    case 'session-var-tools': return configs.some(config => isRecord(config.params) && config.params.stMacros === true)
    case 'tool-config-engine': return (spec.customTools?.length ?? 0) > 0
    case 'character-tools': return active.length > 0 || configs.some(config => /^(module|chara)-/.test(String(config.id ?? '')))
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
      if (ruleInjections(spec.rules).some(({ config }) => config.layer === 'system-section') && current.persona?.complete === true) {
        doc.setIn(['persona', 'complete'], false)
        personaOpened = true
      }
      const existing = (current.rules ?? []).filter(rule => !importPrefixes(sourceId).some(base => rule.id.startsWith(base)))
      const added = (spec.rules ?? []).map(rule => mapRuleInjections({ ...rule, id: `${prefix}${rule.id}` }, config => ({
        ...config, id: `${prefix}${config.id}`, variables: { ...(spec.variablesEnabled === false ? {} : spec.variables), ...config.variables },
      })))
      for (const [key, value] of Object.entries(readModuleLayerSettings(spec))) doc.setIn(engineParamPath(key), value)
      const merged = [...existing, ...added]
      compileRules(merged, { promptConfigOptions: rulePromptConfigOptions(dir) })
      const before = readCapabilities(doc)
      const required = ['rule-engine', ...(ruleInjections(merged).some(({ config }) => config.strategy === 'world-book') ? ['world-book-tools'] : [])]
      appendModuleCapabilities(doc, [...new Set([...declaredCapabilities(spec), ...required])])
      const records = readMergedModules(current.meta)
      records[sourceId] = { active: true, capabilities: [...new Set([...(records[sourceId]?.capabilities ?? []), ...readCapabilities(doc).filter(capability => !before.includes(capability))])] }
      writeMergedModules(doc, records)
      doc.set('rules', merged)
      if (Array.isArray(spec.meta?.stWarnings) && spec.meta.stWarnings.length > 0) {
        const warnings = Array.isArray(current.meta?.stWarnings) ? current.meta.stWarnings : []
        doc.setIn(['meta', 'stWarnings'], [...new Set([...warnings, ...spec.meta.stWarnings].filter(value => typeof value === 'string'))])
      }
      count = added.length
    })
    return { ok: true, count, ...(personaOpened ? { personaOpened: true } : {}) }
  } catch (error) { return { ok: false, message: `并入失败：${error instanceof Error ? error.message : String(error)}` } }
}

/** 撤销并入内容；旧 chara 前缀可撤销，能力归属只写一份登记。 */
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
      doc.set('rules', kept)
      for (const rule of current.rules ?? []) if (!kept.some(item => item.id === rule.id) && doc.hasIn(['configOrder', rule.id])) doc.deleteIn(['configOrder', rule.id])
      if (doc.hasIn(['meta', CHARACTER_MEMORIES_KEY, sourceId])) doc.deleteIn(['meta', CHARACTER_MEMORIES_KEY, sourceId])
      for (const [key, value] of Object.entries(spec === undefined ? {} : readModuleLayerSettings(spec))) {
        const path = engineParamPath(key)
        if (doc.getIn(path) === value) doc.deleteIn(path)
      }
      const records = readMergedModules(current.meta)
      if (records[sourceId] !== undefined) records[sourceId]!.active = false
      const active = Object.keys(records).filter(id => records[id]!.active)
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
    })
    return { ok: true, count: removed }
  } catch (error) { return { ok: false, message: `移除失败：${error instanceof Error ? error.message : String(error)}` } }
}

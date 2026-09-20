/** 角色卡库：独立于预设根的素材+参数存储（预设根下点前缀目录，官方 discovery 跳过）。
 *  角色卡参数（converted.yml = convertStToPreset 产物）不直接生成预设，而是
 *  由用户按需「导入到当前预设」合并进激活预设 preset.yml（promptConfigs 带
 *  chara-<cardId>- 前缀防冲突，params 合并，meta.importedCharacters 记录来源），
 *  并可一键移除。 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, existsSync, readdirSync, appendFileSync, lstatSync, cpSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { parse as parseYaml, parseDocument, stringify as stringifyYaml, YAMLSeq } from 'yaml'
import { createHash, randomUUID } from 'node:crypto'
import type { StConversionOptions, StOrderGroupSummary } from './sillytavern.ts'
import { prepareImport, assetSourceDigest, normalizeAssetFiles, validateCharacterSpec } from './import-source.ts'
import { assertPresetId, assertPresetTree, presetPathExists } from './preset-install.ts'
import { appendPresetModules, withPresetDoc } from './manifest.ts'
import { buildWorldBookEntry } from './worldbook.ts'
import type { PresetSpec } from './manifest.ts'
import { ENGINE_LAYER_ORDER } from '../shared/engine-capabilities.ts'
import type { StConversionReport } from '../shared/bridge-contract.ts'
import type { AssetFile, ImportChoices, ImportKind } from '../shared/asset-transfer.ts'

/** 合并写盘时按九层顺序排序（数组序 = 引擎序）：层序只由共享契约提供，这里不再维护第二份。 */
function sortConfigs(configs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...configs].sort((a, b) => {
    const rank = (config: Record<string, unknown>): number => {
      const index = ENGINE_LAYER_ORDER.indexOf(String(config.layer ?? 'pre-step') as typeof ENGINE_LAYER_ORDER[number])
      return index < 0 ? ENGINE_LAYER_ORDER.length : index
    }
    const byLayer = rank(a) - rank(b)
    if (byLayer !== 0) return byLayer
    return (Number(a.order) || 0) - (Number(b.order) || 0)
  })
}

/** 角色卡记忆条目字段（不含 id；id 由调用方加 chara-<卡>- 前缀）。 */
function buildCharacterMemoryEntry(spec: PresetSpec, memory: string): Record<string, unknown> | undefined {
  if (memory.trim().length === 0) return undefined
  // 结构经世界书条目工厂（与 ST 导入/模型工具同源，strategy/layer/position 单一权威）。
  return buildWorldBookEntry({
    name: '角色记忆',
    enabled: true,
    // alpha.1 官方工具提示占用 1000-2900；角色素材放工具后、SDK 前。
    order: 3000,
    text: `【${spec.name} 的关系记忆】\n${memory}`,
    constant: true,
  })
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

function recordMemory(doc: ReturnType<typeof parseDocument>, cardId: string, config: Record<string, unknown>): void {
  doc.setIn(['meta', CHARACTER_MEMORIES_KEY, cardId], { characterId: cardId, configId: String(config.id), contentHash: contentHash(config) })
}

function availableMemoryId(configs: readonly Record<string, unknown>[], cardId: string): string {
  const base = `chara-${cardId}-memory`
  const used = new Set(configs.map(config => config.id))
  let id = base
  for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`
  return id
}

/** 分享副本：只排除本机生成证明仍匹配的记忆；旧项与已编辑项须明确选择。 */
export function projectCharacterMemories(
  source: ReturnType<typeof parseDocument>,
  choices: Record<string, 'include' | 'exclude'> = {},
  presetRoot?: string,
): { doc: ReturnType<typeof parseDocument>; excludedMemoryCount: number; memoryConflicts: Array<{ id: string; name: string }> } {
  const doc = source.clone()
  const spec = doc.toJS() as PresetSpec
  const records = memoryRecords(spec.meta)
  const imported = Array.isArray(spec.meta?.importedCharacters) ? spec.meta.importedCharacters.filter((id): id is string => typeof id === 'string') : []
  const conflicts: Array<{ id: string; name: string }> = []
  const excluded = new Set<number>()
  for (const [index, config] of (spec.promptConfigs ?? []).entries()) {
    if (!isRecord(config) || typeof config.id !== 'string') continue
    const id = config.id
    const proof = Object.values(records).find(record => record.configId === id)
    if (proof !== undefined && proof.contentHash === contentHash(config)) { excluded.add(index); continue }
    const cardId = imported.find(card => id === `chara-${card}-memory` || id.startsWith(`chara-${card}-memory-`)) ?? proof?.characterId
    if (cardId === undefined) continue
    // 原生卡定义的同名普通配置是独立内容，不按 ID 猜作记忆。
    if (presetRoot !== undefined && validCardId(cardId)) {
      const original = loadConverted(cardDir(presetRoot, cardId))
      if (original?.promptConfigs?.some(entry => isRecord(entry) && `chara-${cardId}-${String(entry.id)}` === id)) continue
      const memory = original === undefined ? undefined : buildCharacterMemoryEntry(original, readCharacterMemory(presetRoot, cardId))
      if (memory !== undefined && contentHash({ ...memory, id }) === contentHash(config)) { excluded.add(index); continue }
    }
    if (choices[id] === 'exclude') excluded.add(index)
    else if (choices[id] !== 'include') conflicts.push({ id, name: String(config.name ?? id) })
  }
  const configs = doc.get('promptConfigs', true)
  if (configs instanceof YAMLSeq) for (const index of [...excluded].sort((a, b) => b - a)) configs.delete(index)
  else if (excluded.size > 0) doc.set('promptConfigs', (spec.promptConfigs ?? []).filter((_, index) => !excluded.has(index)))
  if (doc.hasIn(['meta', CHARACTER_MEMORIES_KEY])) doc.deleteIn(['meta', CHARACTER_MEMORIES_KEY])
  return { doc, excludedMemoryCount: excluded.size, memoryConflicts: conflicts }
}

/** meta 下记录「每张卡引入了哪些模块」的键；来源保留到模块不再被消费并完成回退。 */
export const CHARACTER_MODULES_KEY = 'characterModules'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 读取 preset.yml `meta.modules` 之外的模块来源记录；非法形状一律视为无记录（老卡与手改文件不报错）。 */
export function recordedCharacterModules(meta: unknown): Record<string, string[]> {
  if (!isRecord(meta)) return {}
  const raw = meta[CHARACTER_MODULES_KEY]
  if (!isRecord(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [cardId, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue
    const modules = [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
    if (modules.length > 0) out[cardId] = modules
  }
  return out
}

/** 卡自身声明的模块（声明优先：ST 转换产物自带六件套声明，行为因此不变）。
 *  只丢弃非字符串与空串；模块名合法性仍由 appendPresetModules 校验（非法名 fail loud）。 */
export function declaredCharacterModules(spec: PresetSpec): string[] {
  const list = Array.isArray(spec.modules) ? spec.modules : []
  return [...new Set(list.filter((item): item is string => typeof item === 'string' && item.length > 0))]
}

/** 必需模块：`prompt-config-engine` 缺失会让 promptConfigs 静默失效，因此始终补齐；
 *  卡内含 world-book 策略配置时另需 `world-book-tools`（与旧实现同判据）。 */
export function requiredCharacterModules(configs: readonly unknown[]): string[] {
  const required = ['prompt-config-engine']
  if (configs.some((config) => isRecord(config) && config.strategy === 'world-book')) required.push('world-book-tools')
  return required
}

/** 移除一张卡之后，某个模块是否仍被预设内容或其他卡需要（需要则不回退）。 */
export interface CharacterModuleContext {
  /** 移除本卡前缀配置之后的提示词配置。 */
  configs: readonly Record<string, unknown>[]
  /** 移除本卡声明的 params 键之后的预设参数。 */
  params: Record<string, unknown>
  /** 预设顶层是否仍有自定义工具。 */
  customTools: boolean
  /** 移除本卡之后仍标记为已导入的角色卡 id。 */
  importedCharacters: readonly string[]
}

/** `string | string[]` 形态的引擎参数是否非空（空串 / 空列表 = 删键语义，视为未设置）。 */
function nonEmptyParam(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.trim().length > 0
  return value !== undefined && value !== null
}

/** 模块的消费者判据。未知模块保守保留：宁可留一个无消费者的模块，也不误删用户或引擎要用的装配。 */
export function characterModuleStillNeeded(module: string, context: CharacterModuleContext): boolean {
  switch (module) {
    case 'prompt-config-engine':
      return context.configs.length > 0
    case 'world-book-tools':
      return context.configs.some((config) => config.strategy === 'world-book')
    case 'session-var-tools':
      return context.configs.some((config) => isRecord(config.params) && config.params.stMacros === true)
    case 'tool-config-engine':
      return context.customTools
    case 'tool-filter':
      return nonEmptyParam(context.params.toolFilterAllow) || nonEmptyParam(context.params.toolFilterDeny)
    case 'character-tools':
      return context.importedCharacters.length > 0
        || context.configs.some((config) => String(config.id ?? '').startsWith('chara-'))
    default:
      return true
  }
}

/** 其他已导入卡「引入过」或「声明过」的模块：移除本卡时不得夺走别人要用的模块。
 *  声明这一路必须读卡库的 converted.yml——第二张卡声明同一模块时差集为空、不会留下引入记录。 */
function modulesClaimedByOtherCards(
  presetRoot: string,
  importedCards: readonly string[],
  meta: unknown,
  cardId: string,
): Set<string> {
  const claimed = new Set<string>()
  for (const [id, modules] of Object.entries(recordedCharacterModules(meta))) {
    if (id === cardId || !importedCards.includes(id)) continue
    for (const module of modules) claimed.add(module)
  }
  for (const id of importedCards) {
    if (id === cardId || !validCardId(id)) continue
    const spec = loadConverted(cardDir(presetRoot, id))
    if (spec === undefined) continue
    for (const module of declaredCharacterModules(spec)) claimed.add(module)
  }
  return claimed
}

/** 读 preset.yml 顶层 modules（非数组或含非字符串项时按已过滤结果处理）。 */
function readPresetModules(doc: ReturnType<typeof parseDocument>): string[] {
  const source = doc.toJS() as { modules?: unknown }
  return Array.isArray(source.modules) ? source.modules.filter((item): item is string => typeof item === 'string') : []
}

/** 角色卡记忆变更后同步已导入预设的 chara-<id>-memory 注入条目
 *  （world_book note 写入卡记忆后调用；未导入当前预设的卡返回 synced=false）。 */
export function syncImportedCharacterMemory(
  presetRoot: string,
  templateName: string,
  cardId: string,
): { ok: true; synced: boolean } | { ok: false; message: string } {
  if (!validCardId(cardId)) return { ok: false, message: `非法角色卡 id：${cardId}` }
  let synced = false
  try {
    const spec = loadConverted(cardDir(presetRoot, cardId))
    if (spec === undefined) return { ok: false, message: `角色卡 ${cardId} 不存在或参数损坏` }
    const memory = readCharacterMemory(presetRoot, cardId)
    withPresetDoc(join(presetRoot, templateName), (doc) => {
      const current = doc.toJS() as { promptConfigs?: unknown[]; meta?: { importedCharacters?: unknown[] } }
      const imported = Array.isArray(current.meta?.importedCharacters)
        ? current.meta.importedCharacters.map(String)
        : []
      if (!imported.includes(cardId)) return // 卡未导入当前预设，无需同步
      const configs = Array.isArray(current.promptConfigs)
        ? current.promptConfigs as Array<Record<string, unknown>>
        : []
      const entry = buildCharacterMemoryEntry(spec, memory)
      const proof = memoryRecords(current.meta)[cardId]
      const at = configs.findIndex(config => proof !== undefined && config.id === proof.configId && contentHash(config) === proof.contentHash)
      if (entry === undefined) {
        if (at >= 0) {
          configs.splice(at, 1)
          doc.deleteIn(['meta', CHARACTER_MEMORIES_KEY, cardId])
          synced = true
        }
      } else {
        const config = { ...entry, id: at >= 0 ? configs[at]!.id : availableMemoryId(configs, cardId) }
        if (at >= 0) configs[at] = config
        else configs.push(config)
        recordMemory(doc, cardId, config)
        synced = true
      }
      if (synced) doc.setIn(['promptConfigs'], sortConfigs(configs))
    })
    return { ok: true, synced }
  } catch (error) {
    return { ok: false, message: `同步失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 角色卡库根：预设根下的点前缀目录（官方 roster 扫描跳过，与 .engine 同机制）。 */
export function charactersDir(presetRoot: string): string {
  return join(presetRoot, '.characters')
}

function cardDir(presetRoot: string, id: string): string {
  return join(charactersDir(presetRoot), id)
}

function loadConverted(dir: string): PresetSpec | undefined {
  const file = join(dir, 'converted.yml')
  assertNoLinks(file)
  if (!presetPathExists(file)) return undefined
  const parsed = parseYaml(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  if (!isRecord(parsed)) throw new Error(`角色定义不是对象：${file}`)
  return parsed as unknown as PresetSpec
}

/** 追加角色卡本地记忆（.characters/<id>/memory.md，跟随角色卡跨预设）。 */
export function appendCharacterMemory(presetRoot: string, cardId: string, note: string): void {
  assertPresetId(cardId)
  appendMemoryFile(join(cardDir(presetRoot, cardId), 'memory.md'), note, '# 角色记忆')
}

/** 检查现有祖先和最终文件，不能通过角色目录 junction 或单文件链接越界。 */
function assertNoLinks(path: string): void {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  if (parent !== absolute) assertNoLinks(parent)
  if (presetPathExists(absolute) && lstatSync(absolute).isSymbolicLink()) throw new Error(`角色路径包含链接：${absolute}`)
}

/** 追加记忆文件（时间戳列表格式；header 标注文件类型）。世界书工具与角色卡共用。 */
export function appendMemoryFile(file: string, note: string, header = '# 本地记忆'): void {
  const content = note.trim()
  if (content.length === 0) return
  assertNoLinks(file)
  mkdirSync(dirname(file), { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const line = `\n- [${stamp}] ${content}\n`
  if (existsSync(file)) appendFileSync(file, line, 'utf8')
  else writeFileSync(file, `${header}\n${line}`, 'utf8')
}

/** 读角色卡本地记忆文本（无记忆返回空串）。 */
export function readCharacterMemory(presetRoot: string, cardId: string): string {
  assertPresetId(cardId)
  const file = join(cardDir(presetRoot, cardId), 'memory.md')
  assertNoLinks(file)
  return presetPathExists(file) ? readFileSync(file, 'utf8').trim() : ''
}

/** 校验角色卡 id 可作目录名（防路径穿越）。 */
function validCardId(id: string): boolean {
  try { assertPresetId(id); return true } catch { return false }
}

type CharacterImportOptions = StConversionOptions & ImportChoices
type CharacterImportResult = { ok: true; id: string; name: string; warning?: string } | { ok: false; message: string }
function importChoices(options: CharacterImportOptions): ImportChoices {
  return { ...options, promptOrderCharacterId: options.promptOrderCharacterId ?? options.characterId }
}

/** 角色卡 JSON 的选组状态：与预设包共用同一实现，预览用候选、提交用拒绝。 */
export function characterOrderSelectionState(files: AssetFile[], options: CharacterImportOptions = {}):
  { needsSelection: true; candidates: StOrderGroupSummary[] }
  | { needsSelection: false; error?: string } {
  try {
    const prepared = prepareImport(files, 'character', importChoices(options))
    return prepared.state === 'needs-order-selection' ? { needsSelection: true, candidates: prepared.candidates } : { needsSelection: false }
  } catch (error) { return { needsSelection: false, error: error instanceof Error ? error.message : String(error) } }
}

/** 角色卡导入来源摘要：提交时由服务端按本次上传内容重算，预览身份不构成写入凭证。 */
export function characterImportDigest(files: AssetFile[]): string {
  return assetSourceDigest(normalizeAssetFiles(files))
}

/** 角色卡预览：与入库共用同一转换实现（含同一选组选项），只返回报告、不写角色库。 */
export function previewCharacterCard(
  files: AssetFile[],
  options: CharacterImportOptions = {},
): { ok: true; name: string; id: string; sourceDigest: string; report?: StConversionReport; kind: ImportKind; files: AssetFile[]; sourceName: string } | { ok: false; message: string } {
  try {
    const prepared = prepareImport(files, 'character', importChoices(options))
    if (prepared.state !== 'ready') return { ok: false, message: '请先选择角色内容类型或提示顺序组' }
    return { ok: true, name: prepared.spec.name, id: prepared.spec.id, sourceDigest: prepared.sourceDigest, report: prepared.report, kind: prepared.kind, files: prepared.files, sourceName: prepared.sourceName }
  } catch (error) {
    return { ok: false, message: `角色卡转换失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

function persistCharacterCard(
  presetRoot: string,
  converted: PresetSpec,
  sourceText: string,
  avatar?: Buffer,
  convertedYaml = stringifyYaml(converted, { lineWidth: 0 }),
): CharacterImportResult {
  if (!validCardId(converted.id)) return { ok: false, message: `非法角色卡 id：${converted.id}` }
  const parent = charactersDir(presetRoot)
  const dir = cardDir(presetRoot, converted.id)
  let tmp: string | undefined
  let installed = false
  try {
    assertNoLinks(dir)
    const before = characterDirectoryDigest(dir)
    if (presetPathExists(join(dir, 'memory.md'))) readCharacterMemory(presetRoot, converted.id)
    mkdirSync(parent, { recursive: true })
    tmp = mkdtempSync(join(parent, `.${converted.id}.tmp-`))
    // 同步调用在当前进程与记忆追加串行；保留未知资产，交换前再次核对所有字节。
    if (before !== undefined) {
      cpSync(dir, tmp, { recursive: true })
      assertPresetTree(tmp)
    }
    if (avatar !== undefined) writeFileSync(join(tmp, 'avatar.png'), avatar)
    let sourceFile = 'card.json'
    try { JSON.parse(sourceText) } catch { sourceFile = 'card.yml' }
    for (const name of ['card.json', 'card.yml']) if (name !== sourceFile && presetPathExists(join(tmp, name))) rmSync(join(tmp, name))
    writeFileSync(join(tmp, sourceFile), sourceText, 'utf8')
    writeFileSync(join(tmp, 'converted.yml'), convertedYaml, 'utf8')
    if (characterDirectoryDigest(dir) !== before) throw new Error('角色卡或记忆在准备期间改变，请重新预览')
    const backup = join(parent, `.${converted.id}.bak-${randomUUID()}`)
    let hadOld = false
    if (before !== undefined) {
      renameSync(dir, backup)
      hadOld = true
    }
    try {
      renameSync(tmp, dir)
      installed = true
    } catch (error) {
      if (hadOld) {
        try { renameSync(backup, dir) } catch (restoreError) {
          throw new Error(`安装与恢复均失败；旧数据保留在 ${backup}：${String(error)}；恢复：${String(restoreError)}`)
        }
      }
      throw error
    }
    if (hadOld) {
      try { rmSync(backup, { recursive: true, force: true }) } catch (error) {
        return { ok: true, id: converted.id, name: converted.name, warning: `角色卡已安装；旧备份清理失败，保留在 ${backup}：${String(error)}` }
      }
    }
    return { ok: true, id: converted.id, name: converted.name }
  } catch (error) {
    if (tmp !== undefined && !installed) rmSync(tmp, { recursive: true, force: true })
    return { ok: false, message: `角色卡写入失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

function characterDirectoryDigest(dir: string): string | undefined {
  if (!presetPathExists(dir)) return undefined
  assertPresetTree(dir)
  const hash = createHash('sha256')
  const visit = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name)
      hash.update(JSON.stringify(file.slice(dir.length)))
      if (lstatSync(file).isDirectory()) visit(file)
      else hash.update(readFileSync(file))
    }
  }
  visit(dir)
  return hash.digest('hex')
}

/** 角色卡入库：PNG 原图（可选）+ 角色卡 JSON → 转换参数存 converted.yml。 */
export function importCharacterCard(
  presetRoot: string,
  files: AssetFile[],
  options: CharacterImportOptions = {},
): CharacterImportResult {
  try {
    const prepared = prepareImport(files, 'character', importChoices(options))
    if (prepared.state !== 'ready') return { ok: false, message: '请先选择角色内容类型或提示顺序组' }
    return persistCharacterCard(presetRoot, prepared.spec, prepared.sourceText ?? prepared.yaml, prepared.avatar, prepared.yaml)
  } catch (error) {
    return { ok: false, message: `角色卡转换失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 原始文件流导入：识别 PNG 魔数后在 host 侧提取角色卡，避免客户端 base64 膨胀 JSON。 */
export function importCharacterCardFile(
  presetRoot: string,
  filePath: string,
  fileName = basename(filePath),
  options: CharacterImportOptions = {},
): CharacterImportResult {
  try {
    const buffer = readFileSync(filePath)
    return importCharacterCard(presetRoot, [{ path: basename(fileName), content: buffer.toString('base64'), encoding: 'base64' }], options)
  } catch (error) {
    return { ok: false, message: `角色卡转换失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export interface CharacterCardListItem {
  id: string
  name: string
  description?: string
  hasAvatar: boolean
  /** 是否已导入当前预设（激活预设 meta.importedCharacters 含该 id）。 */
  imported: boolean
}

/** 角色卡库清单 + 各卡在当前预设的导入状态。 */
export function listCharacterCards(
  presetRoot: string,
  activeTemplate: string | undefined,
): CharacterCardListItem[] {
  const root = charactersDir(presetRoot)
  let importedIds: Set<string>
  try {
    const presetFile = activeTemplate !== undefined && activeTemplate.length > 0
      ? join(presetRoot, activeTemplate, 'preset.yml')
      : ''
    const meta = existsSync(presetFile)
      ? (parseDocument(readFileSync(presetFile, 'utf8'), { logLevel: 'silent' }).toJS() as { meta?: Record<string, unknown> }).meta
      : undefined
    const list = meta?.importedCharacters
    importedIds = new Set(Array.isArray(list) ? list.map(String) : [])
  } catch (error) { throw new Error(`读取当前预设角色状态失败：${String(error)}`) }
  if (!presetPathExists(root)) return []
  assertNoLinks(root)
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap((entry) => {
      const spec = loadConverted(join(root, entry.name))
      if (spec === undefined) return []
      return [{
        id: entry.name,
        name: spec.name,
        ...(typeof spec.description === 'string' && spec.description.length > 0 ? { description: spec.description } : {}),
        hasAvatar: existsSync(join(root, entry.name, 'avatar.png')),
        imported: importedIds.has(entry.name),
      }]
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** 删除角色卡库条目。 */
export function deleteCharacterCard(presetRoot: string, id: string): { ok: true } | { ok: false; message: string } {
  if (!validCardId(id)) return { ok: false, message: `非法角色卡 id：${id}` }
  const dir = cardDir(presetRoot, id)
  if (!existsSync(dir)) return { ok: false, message: `角色卡 ${id} 不存在` }
  try {
    assertNoLinks(dir)
    rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `删除失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 角色卡参数导入当前预设：promptConfigs 合并（chara-<id>- 前缀防冲突）、
 *  params 合并（角色卡覆盖同键）、meta.importedCharacters 记录来源。 */
export function applyCharacterToPreset(
  presetRoot: string,
  templateName: string,
  cardId: string,
): { ok: true; count: number; personaOpened?: boolean } | { ok: false; message: string } {
  if (!validCardId(cardId)) return { ok: false, message: `非法角色卡 id：${cardId}` }
  const prefix = `chara-${cardId}-`
  // ST system-section 开放：导入卡含 system-section 段（角色设定/系统提示/后续指令）
  // 时，激活预设 persona.complete: true 会在 assembly 抑制这些段（官方 complete
  // 只保留 persona 段）——自动置 complete: false 开放（与 ST 转换自身的
  // persona.complete = false 语义对齐）。
  let personaOpened = false
  try {
    const spec = loadConverted(cardDir(presetRoot, cardId))
    if (spec === undefined) return { ok: false, message: `角色卡 ${cardId} 不存在或参数损坏` }
    validateCharacterSpec(spec)
    const hasSystemSections = (spec.promptConfigs ?? []).some(config => isRecord(config) && config.layer === 'system-section')
    let count = 0
    withPresetDoc(join(presetRoot, templateName), (doc) => {
      const current = doc.toJS() as { persona?: unknown; promptConfigs?: unknown[]; meta?: { importedCharacters?: unknown[]; stWarnings?: unknown[] } }
      if (hasSystemSections) {
        const persona = current.persona
        if (persona !== null && typeof persona === 'object' && !Array.isArray(persona)
          && (persona as Record<string, unknown>).complete === true) {
          doc.setIn(['persona', 'complete'], false)
          personaOpened = true
        }
      }
      const existing = Array.isArray(current.promptConfigs)
        ? (current.promptConfigs as Array<Record<string, unknown>>).filter((config) => {
          return config !== null && typeof config === 'object' && !String(config.id ?? '').startsWith(prefix)
        })
        : []
      const added = (spec.promptConfigs ?? []).flatMap((config) => {
        if (config === null || typeof config !== 'object' || Array.isArray(config)) return []
        const entry = config as Record<string, unknown>
        // 已经权威校验的内嵌 text/texts 与控制配置全部保留。
        return [{ ...entry, id: `${prefix}${String(entry.id ?? '')}`, variables: {
          ...(spec.variablesEnabled === false ? {} : spec.variables),
          ...entry.variables as Record<string, string> | undefined,
        } }]
      })
      for (const [key, value] of Object.entries(spec.params ?? {})) {
        doc.setIn(['params', key], value)
      }
      // 角色卡本地记忆（memory.md）合并为 world-book constant 配置（chara-<卡>-memory）。
      const memory = readCharacterMemory(presetRoot, cardId)
      const memoryEntry = buildCharacterMemoryEntry(spec, memory)
      const memoryConfig = memoryEntry === undefined ? undefined : { ...memoryEntry, id: availableMemoryId([...existing, ...added], cardId) }
      if (memoryConfig !== undefined) recordMemory(doc, cardId, memoryConfig)
      else if (doc.hasIn(['meta', CHARACTER_MEMORIES_KEY, cardId])) doc.deleteIn(['meta', CHARACTER_MEMORIES_KEY, cardId])
      // 合并后按（层序, order）排序写盘：UI 列表与引擎注入顺序一致。
      const merged = sortConfigs([
        ...existing,
        ...added,
        ...(memoryConfig === undefined ? [] : [memoryConfig]),
      ])
      count = added.length + (memoryConfig === undefined ? 0 : 1)
      // 模块按卡的实际需要装配：卡声明优先（ST 产物自带六件套声明，行为不变），必需项兜底
      // （prompt-config-engine 缺失会让 promptConfigs 静默失效）。只把「追加前没有、追加后
      // 有」的差集写进 meta.characterModules[cardId]，移除时按此回退，不误删预设自带模块。
      const before = readPresetModules(doc)
      appendPresetModules(doc, [...new Set([
        ...declaredCharacterModules(spec),
        ...requiredCharacterModules(merged),
      ])])
      const addedModules = readPresetModules(doc).filter((module) => !before.includes(module))
      if (addedModules.length > 0) {
        const recorded = recordedCharacterModules(current.meta)[cardId] ?? []
        doc.setIn(['meta', CHARACTER_MODULES_KEY, cardId], [...new Set([...recorded, ...addedModules])])
      }
      doc.setIn(['promptConfigs'], merged)
      if (Array.isArray(spec.meta?.stWarnings) && spec.meta.stWarnings.length > 0) {
        const warnings = Array.isArray(current.meta?.stWarnings) ? current.meta.stWarnings : []
        doc.setIn(['meta', 'stWarnings'], [...new Set([...warnings, ...spec.meta.stWarnings].filter(value => typeof value === 'string'))])
      }
      const list = Array.isArray(current.meta?.importedCharacters) ? current.meta.importedCharacters : []
      if (!list.map(String).includes(cardId)) list.push(cardId)
      doc.setIn(['meta', 'importedCharacters'], list)
    })
    return { ok: true, count, ...(personaOpened ? { personaOpened: true } : {}) }
  } catch (error) {
    return { ok: false, message: `导入失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 从当前预设移除角色卡参数：删前缀 promptConfigs、删该卡声明的 params 键、
 *  meta.importedCharacters 除名。 */
export function removeCharacterFromPreset(
  presetRoot: string,
  templateName: string,
  cardId: string,
): { ok: true; count: number } | { ok: false; message: string } {
  if (!validCardId(cardId)) return { ok: false, message: `非法角色卡 id：${cardId}` }
  const prefix = `chara-${cardId}-`
  try {
    const spec = loadConverted(cardDir(presetRoot, cardId))
    let removed = 0
    withPresetDoc(join(presetRoot, templateName), (doc) => {
      const current = doc.toJS() as { promptConfigs?: unknown[]; meta?: { importedCharacters?: unknown[] } }
      const kept = (Array.isArray(current.promptConfigs) ? current.promptConfigs as Array<Record<string, unknown>> : []).filter((config) => {
        const isCard = config !== null && typeof config === 'object'
          && String(config.id ?? '').startsWith(prefix)
        if (isCard) removed += 1
        return !isCard
      })
      doc.setIn(['promptConfigs'], kept)
      if (doc.hasIn(['meta', CHARACTER_MEMORIES_KEY, cardId])) doc.deleteIn(['meta', CHARACTER_MEMORIES_KEY, cardId])
      // 删除该卡声明的 params 键（若曾覆盖预设原值无法恢复——文档说明）。
      // 现值判断：仅当当前值仍等于卡声明值才删——用户手改过或他卡同键覆盖过的值不误删。
      for (const [key, value] of Object.entries(spec?.params ?? {})) {
        if (doc.getIn(['params', key]) === value) doc.deleteIn(['params', key])
      }
      const list = Array.isArray(current.meta?.importedCharacters) ? current.meta.importedCharacters : []
      const remainingCards = list.map(String).filter((entry) => entry !== cardId)
      doc.setIn(['meta', 'importedCharacters'], remainingCards)
      // 检查所有已知的卡引入模块：首张卡先移除时，其来源仍须保留到最后消费者移除。
      // 没有任何来源记录的老卡或预设自带模块不回退。
      const records = recordedCharacterModules(current.meta)
      const recorded = Object.values(records).flat()
      if (recorded.length > 0) {
        const others = modulesClaimedByOtherCards(presetRoot, remainingCards, current.meta, cardId)
        const after = doc.toJS() as { params?: unknown; customTools?: unknown }
        const context: CharacterModuleContext = {
          configs: kept.filter(isRecord),
          params: isRecord(after.params) ? after.params : {},
          customTools: Array.isArray(after.customTools) && after.customTools.length > 0,
          importedCharacters: remainingCards,
        }
        const modules = readPresetModules(doc)
        const next = modules.filter((module) => !recorded.includes(module)
          || others.has(module) || characterModuleStillNeeded(module, context))
        if (next.length !== modules.length) doc.set('modules', next)
        for (const [owner, ownedModules] of Object.entries(records)) {
          const retained = ownedModules.filter((module) => next.includes(module))
          if (retained.length === 0) doc.deleteIn(['meta', CHARACTER_MODULES_KEY, owner])
          else doc.setIn(['meta', CHARACTER_MODULES_KEY, owner], retained)
        }
        if (Object.keys(recordedCharacterModules((doc.toJS() as { meta?: unknown }).meta)).length === 0) {
          doc.deleteIn(['meta', CHARACTER_MODULES_KEY])
        }
      }
    })
    return { ok: true, count: removed }
  } catch (error) {
    return { ok: false, message: `移除失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

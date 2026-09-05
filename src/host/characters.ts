/** 角色卡库：独立于预设根的素材+参数存储（预设根下点前缀目录，官方 discovery 跳过）。
 *  角色卡参数（converted.yml = convertStToPreset 产物）不直接生成预设，而是
 *  由用户按需「导入到当前预设」合并进激活预设 preset.yml（promptConfigs 带
 *  chara-<cardId>- 前缀防冲突，params 合并，meta.importedCharacters 记录来源），
 *  并可一键移除。 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'
import { inflateSync } from 'node:zlib'
import { convertStToPreset, mergeStPresets } from './sillytavern.ts'
import { appendPresetModules, withPresetDoc } from './manifest.ts'
import { buildWorldBookEntry } from './worldbook.ts'
import type { PresetSpec } from './manifest.ts'

/** 引擎六层注入顺序（与 schema 层序一致）：合并写盘时按此排序，数组序 = 引擎序。 */
const LAYER_ORDER = ['pre-step', 'system-section', 'runtime-context', 'agent-request', 'llm-stream', 'tool-pipeline']

function sortConfigs(configs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...configs].sort((a, b) => {
    const rank = (config: Record<string, unknown>): number => {
      const index = LAYER_ORDER.indexOf(String(config.layer ?? 'pre-step'))
      return index < 0 ? LAYER_ORDER.length : index
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

/** 角色卡记忆变更后同步已导入预设的 chara-<id>-memory 注入条目
 *  （world_book note 写入卡记忆后调用；未导入当前预设的卡返回 synced=false）。 */
export function syncImportedCharacterMemory(
  presetRoot: string,
  templateName: string,
  cardId: string,
): { ok: true; synced: boolean } | { ok: false; message: string } {
  if (!validCardId(cardId)) return { ok: false, message: `非法角色卡 id：${cardId}` }
  const spec = loadConverted(cardDir(presetRoot, cardId))
  if (spec === undefined) return { ok: false, message: `角色卡 ${cardId} 不存在或参数损坏` }
  const memory = readCharacterMemory(presetRoot, cardId)
  const memoryId = `chara-${cardId}-memory`
  let synced = false
  try {
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
      const at = configs.findIndex((config) => config !== null && typeof config === 'object'
        && String(config.id ?? '') === memoryId)
      if (entry === undefined) {
        if (at >= 0) {
          configs.splice(at, 1)
          synced = true
        }
      } else if (at >= 0) {
        configs[at] = { ...entry, id: memoryId }
        synced = true
      } else {
        configs.push({ ...entry, id: memoryId })
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
  if (!existsSync(file)) return undefined
  try {
    const parsed = parseYaml(readFileSync(file, 'utf8'), { logLevel: 'silent' })
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as PresetSpec
      : undefined
  } catch {
    return undefined
  }
}

/** 追加角色卡本地记忆（.characters/<id>/memory.md，跟随角色卡跨预设）。 */
export function appendCharacterMemory(presetRoot: string, cardId: string, note: string): void {
  appendMemoryFile(join(cardDir(presetRoot, cardId), 'memory.md'), note, '# 角色记忆')
}

/** 追加记忆文件（时间戳列表格式；header 标注文件类型）。世界书工具与角色卡共用。 */
export function appendMemoryFile(file: string, note: string, header = '# 本地记忆'): void {
  const content = note.trim()
  if (content.length === 0) return
  mkdirSync(dirname(file), { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const line = `\n- [${stamp}] ${content}\n`
  if (existsSync(file)) appendFileSync(file, line, 'utf8')
  else writeFileSync(file, `${header}\n${line}`, 'utf8')
}

/** 读角色卡本地记忆文本（无记忆返回空串）。 */
export function readCharacterMemory(presetRoot: string, cardId: string): string {
  try {
    const file = join(cardDir(presetRoot, cardId), 'memory.md')
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

/** 校验角色卡 id 可作目录名（防路径穿越）。 */
function validCardId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..'
    && !id.includes('/') && !id.includes('\\') && !id.startsWith('.')
}

interface CharacterImportFile {
  path: string
  content: string
}

function cardNameFromJson(jsonText: string, fallback: string): string {
  try {
    const parsed = JSON.parse(jsonText) as { name?: unknown; data?: { name?: unknown } }
    if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) return parsed.name.trim()
    if (parsed.data !== null && typeof parsed.data === 'object'
      && typeof parsed.data.name === 'string' && parsed.data.name.trim().length > 0) {
      return parsed.data.name.trim()
    }
  } catch {
    // 转换阶段会返回带上下文的 JSON 错误，这里只负责生成稳定的 fallback 名称。
  }
  return fallback
}

function convertCharacterJsons(jsons: CharacterImportFile[]): { converted: PresetSpec; jsonText: string } {
  const converted = jsons.length > 1
    ? mergeStPresets(jsons.map((entry) => {
      const baseName = basename(entry.path).replace(/\.json$/i, '') || 'character'
      return convertStToPreset(JSON.parse(entry.content), baseName)
    }))
    : convertStToPreset(
      JSON.parse(jsons[0]!.content),
      basename(jsons[0]!.path).replace(/\.json$/i, '') || 'character',
    )
  return { converted, jsonText: jsons[0]!.content }
}

function persistCharacterCard(
  presetRoot: string,
  converted: PresetSpec,
  jsonText: string,
  avatar?: Buffer,
): { ok: true; id: string; name: string } | { ok: false; message: string } {
  if (!validCardId(converted.id)) return { ok: false, message: `非法角色卡 id：${converted.id}` }
  const parent = charactersDir(presetRoot)
  const dir = cardDir(presetRoot, converted.id)
  mkdirSync(parent, { recursive: true })
  // 三文件（avatar.png / card.json / converted.yml）先在临时目录完整写好后
  // 整目录原子 rename 替换；失败恢复旧目录并清理临时目录，防部分写。
  const tmp = mkdtempSync(join(parent, `.${converted.id}.tmp-`))
  try {
    if (avatar !== undefined) writeFileSync(join(tmp, 'avatar.png'), avatar)
    writeFileSync(join(tmp, 'card.json'), jsonText, 'utf8')
    writeFileSync(join(tmp, 'converted.yml'), stringifyYaml(converted, { lineWidth: 0 }), 'utf8')
    const backup = join(parent, `.${converted.id}.bak-${Date.now().toString(36)}`)
    let hadOld = false
    if (existsSync(dir)) {
      renameSync(dir, backup)
      hadOld = true
    }
    try {
      renameSync(tmp, dir)
    } catch (error) {
      if (hadOld) {
        try { renameSync(backup, dir) } catch { /* 恢复失败保留 backup 供人工处理 */ }
      }
      throw error
    }
    if (hadOld) rmSync(backup, { recursive: true, force: true })
    return { ok: true, id: converted.id, name: converted.name }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    return { ok: false, message: `角色卡写入失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function isPngBuffer(buffer: Buffer): boolean {
  return buffer.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => buffer[index] === value)
}

/** PNG 角色卡解压输出大小上限（防 zip bomb 膨胀内存）。 */
const MAX_PNG_CARD_DECOMPRESSED_BYTES = 16 * 1024 * 1024

function decodePngCharacterCard(buffer: Buffer): { jsonText: string; avatar: Buffer } {
  if (!isPngBuffer(buffer)) throw new Error('不是有效的 PNG 文件')
  const chunks: Array<{ keyword: string; text: string }> = []
  let offset = PNG_SIGNATURE.length
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const next = dataEnd + 4
    if (dataEnd > buffer.length || next > buffer.length) throw new Error('PNG chunk 越界')
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (type === 'tEXt') {
      let separator = dataStart
      while (separator < dataEnd && buffer[separator] !== 0) separator += 1
      if (separator < dataEnd && separator > dataStart) {
        chunks.push({
          keyword: buffer.toString('latin1', dataStart, separator).toLowerCase(),
          text: buffer.toString('latin1', separator + 1, dataEnd),
        })
      }
    }
    if (type === 'IEND') break
    offset = next
  }
  const card = chunks.find((chunk) => chunk.keyword === 'ccv3') ?? chunks.find((chunk) => chunk.keyword === 'chara')
  if (card === undefined) throw new Error('PNG 不含角色卡数据（无 chara/ccv3 tEXt chunk）')
  const encoded = Buffer.from(card.text, 'base64')
  try {
    const jsonText = inflateSync(encoded, { maxOutputLength: MAX_PNG_CARD_DECOMPRESSED_BYTES }).toString('utf8')
    JSON.parse(jsonText)
    return { jsonText, avatar: buffer }
  } catch {
    // 非压缩（原始 utf8）卡片：inflate 失败回落直接解析；解压超限（zip bomb）
    // 时 inflate 抛错、raw 解析失败同样干净报错，不膨胀内存。
    const jsonText = encoded.toString('utf8')
    JSON.parse(jsonText)
    return { jsonText, avatar: buffer }
  }
}

/** 角色卡入库：PNG 原图（可选）+ 角色卡 JSON → 转换参数存 converted.yml。 */
export function importCharacterCard(
  presetRoot: string,
  files: CharacterImportFile[],
): { ok: true; id: string; name: string } | { ok: false; message: string } {
  const jsons = files.filter((entry) => /\.json$/i.test(entry.path))
  if (jsons.length === 0) {
    return { ok: false, message: '缺少角色卡 JSON（PNG 导入需同时携带解析出的角色卡 JSON）' }
  }
  try {
    const { converted, jsonText } = convertCharacterJsons(jsons)
    const avatar = files.find((entry) => /^avatar\.png$/i.test(entry.path))
    return persistCharacterCard(
      presetRoot,
      converted,
      jsonText,
      avatar === undefined ? undefined : Buffer.from(avatar.content, 'base64'),
    )
  } catch (error) {
    return { ok: false, message: `角色卡转换失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 原始文件流导入：识别 PNG 魔数后在 host 侧提取角色卡，避免客户端 base64 膨胀 JSON。 */
export function importCharacterCardFile(
  presetRoot: string,
  filePath: string,
  fileName = basename(filePath),
): { ok: true; id: string; name: string } | { ok: false; message: string } {
  try {
    const buffer = readFileSync(filePath)
    if (isPngBuffer(buffer)) {
      const { jsonText, avatar } = decodePngCharacterCard(buffer)
      const fallback = basename(fileName).replace(/\.[^.]+$/, '') || 'character'
      const baseName = cardNameFromJson(jsonText, fallback)
      const { converted } = convertCharacterJsons([{ path: `${baseName}.json`, content: jsonText }])
      return persistCharacterCard(presetRoot, converted, jsonText, avatar)
    }
    const jsonText = buffer.toString('utf8')
    const fallback = basename(fileName).replace(/\.[^.]+$/, '') || 'character'
    const { converted } = convertCharacterJsons([{ path: `${fallback}.json`, content: jsonText }])
    return persistCharacterCard(presetRoot, converted, jsonText)
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
  } catch {
    importedIds = new Set()
  }
  try {
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
  } catch {
    return []
  }
}

/** 删除角色卡库条目。 */
export function deleteCharacterCard(presetRoot: string, id: string): { ok: true } | { ok: false; message: string } {
  if (!validCardId(id)) return { ok: false, message: `非法角色卡 id：${id}` }
  const dir = cardDir(presetRoot, id)
  if (!existsSync(dir)) return { ok: false, message: `角色卡 ${id} 不存在` }
  try {
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
  const spec = loadConverted(cardDir(presetRoot, cardId))
  if (spec === undefined) return { ok: false, message: `角色卡 ${cardId} 不存在或参数损坏` }
  const prefix = `chara-${cardId}-`
  // ST system-section 开放：导入卡含 system-section 段（角色设定/系统提示/后续指令）
  // 时，激活预设 persona-main complete: true 会在 assembly 抑制这些段（官方 complete
  // 只保留 persona 段）——自动置 complete: false 开放（与 ST 转换自身的
  // moduleConfigs.persona = { complete: false } 语义对齐）。
  const hasSystemSections = (spec.promptConfigs ?? []).some((config) =>
    config !== null && typeof config === 'object' && !Array.isArray(config)
    && (config as Record<string, unknown>).layer === 'system-section')
  let personaOpened = false
  try {
    withPresetDoc(join(presetRoot, templateName), (doc) => {
      const current = doc.toJS() as { promptConfigs?: unknown[]; meta?: { importedCharacters?: unknown[] } }
      if (hasSystemSections) {
        const configs = Array.isArray(current.promptConfigs) ? current.promptConfigs : []
        const personaIdx = configs.findIndex((config) => {
          if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
          const entry = config as Record<string, unknown>
          const params = entry.params as Record<string, unknown> | undefined
          return entry.id === 'persona-main' || params?.sectionName === 'deployment:persona'
        })
        if (personaIdx >= 0) {
          const persona = configs[personaIdx] as Record<string, unknown> | undefined
          const complete = (persona?.params as Record<string, unknown> | undefined)?.complete
          if (complete === true) {
            doc.setIn(['promptConfigs', personaIdx, 'params', 'complete'], false)
            personaOpened = true
          }
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
        // 世界书（world-book 策略）与普通配置一起带前缀并入；空文本跳过。
        if (entry.text === undefined || String(entry.text).trim().length === 0) return []
        return [{ ...entry, id: `${prefix}${String(entry.id ?? '')}` }]
      })
      for (const [key, value] of Object.entries(spec.params ?? {})) {
        doc.setIn(['params', key], value)
      }
      // 角色卡本地记忆（memory.md）合并为 world-book constant 配置（chara-<卡>-memory）。
      const memory = readCharacterMemory(presetRoot, cardId)
      const memoryId = `${prefix}memory`
      const memoryEntry = buildCharacterMemoryEntry(spec, memory)
      // 合并后按（层序, order）排序写盘：UI 列表与引擎注入顺序一致。
      const merged = sortConfigs([
        ...existing,
        ...added,
        ...(memoryEntry !== undefined ? [{ ...memoryEntry, id: memoryId }] : []),
      ])
      // ST system-section 开放：最终数组上应用（避免被整体写盘覆盖）——导入卡含
      // system-section 段且激活预设 persona-main complete: true（会抑制 ST 的
      // system prompt 段）时，置 complete: false 开放。
      if (hasSystemSections) {
        const persona = merged.find((config) => {
          if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
          const entry = config as Record<string, unknown>
          const params = entry.params as Record<string, unknown> | undefined
          return entry.id === 'persona-main' || params?.sectionName === 'deployment:persona'
        }) as Record<string, unknown> | undefined
        const complete = (persona?.params as Record<string, unknown> | undefined)?.complete
        if (complete === true && persona !== undefined) {
          ;(persona.params as Record<string, unknown>).complete = false
          personaOpened = true
        }
      }
      appendPresetModules(doc, [
        'character-tools',
        ...(merged.some((config) => config.strategy === 'world-book') ? ['world-book-tools'] : []),
        'session-var-tools',
        'tool-config-engine',
        'tool-filter',
      ])
      doc.setIn(['promptConfigs'], merged)
      const list = Array.isArray(current.meta?.importedCharacters) ? current.meta.importedCharacters : []
      if (!list.map(String).includes(cardId)) list.push(cardId)
      doc.setIn(['meta', 'importedCharacters'], list)
    })
    return { ok: true, count: (spec.promptConfigs ?? []).length, ...(personaOpened ? { personaOpened: true } : {}) }
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
  const spec = loadConverted(cardDir(presetRoot, cardId))
  const prefix = `chara-${cardId}-`
  try {
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
      // 删除该卡声明的 params 键（若曾覆盖预设原值无法恢复——文档说明）。
      // 现值判断：仅当当前值仍等于卡声明值才删——用户手改过或他卡同键覆盖过的值不误删。
      for (const [key, value] of Object.entries(spec?.params ?? {})) {
        if (doc.getIn(['params', key]) === value) doc.deleteIn(['params', key])
      }
      const list = Array.isArray(current.meta?.importedCharacters) ? current.meta.importedCharacters : []
      doc.setIn(['meta', 'importedCharacters'], list.filter((entry) => String(entry) !== cardId))
    })
    return { ok: true, count: removed }
  } catch (error) {
    return { ok: false, message: `移除失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

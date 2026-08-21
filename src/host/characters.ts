/** 角色卡库：独立于预设根的素材+参数存储（预设根下点前缀目录，官方 discovery 跳过）。
 *  角色卡参数（converted.yml = convertStToPreset 产物）不直接生成预设，而是
 *  由用户按需「导入到当前预设」合并进激活预设 preset.yml（promptConfigs 带
 *  chara-<cardId>- 前缀防冲突，params 合并，meta.importedCharacters 记录来源），
 *  并可一键移除。 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'
import { convertStToPreset, mergeStPresets } from './sillytavern.ts'
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
  const content = note.trim()
  if (content.length === 0) return
  const dir = cardDir(presetRoot, cardId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'memory.md')
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const line = `\n- [${stamp}] ${content}\n`
  if (existsSync(file)) appendFileSync(file, line, 'utf8')
  else writeFileSync(file, `# 角色记忆\n${line}`, 'utf8')
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

/** 角色卡入库：PNG 原图（可选）+ 角色卡 JSON → 转换参数存 converted.yml。 */
export function importCharacterCard(
  presetRoot: string,
  files: Array<{ path: string; content: string }>,
): { ok: true; id: string; name: string } | { ok: false; message: string } {
  const jsons = files.filter((entry) => /\.json$/i.test(entry.path))
  if (jsons.length === 0) {
    return { ok: false, message: '缺少角色卡 JSON（PNG 导入需同时携带解析出的角色卡 JSON）' }
  }
  try {
    const converted = jsons.length > 1
      ? mergeStPresets(jsons.map((entry) => {
        const baseName = basename(entry.path).replace(/\.json$/i, '') || 'character'
        return convertStToPreset(JSON.parse(entry.content), baseName)
      }))
      : convertStToPreset(JSON.parse(jsons[0]!.content), basename(jsons[0]!.path).replace(/\.json$/i, '') || 'character')
    if (!validCardId(converted.id)) {
      return { ok: false, message: `非法角色卡 id：${converted.id}` }
    }
    const dir = cardDir(presetRoot, converted.id)
    mkdirSync(dir, { recursive: true })
    // 原图落盘为 avatar.png（客户端已 base64），角色卡原始 JSON 存档 card.json。
    const avatar = files.find((entry) => /^avatar\.png$/i.test(entry.path))
    if (avatar !== undefined) writeFileSync(join(dir, 'avatar.png'), Buffer.from(avatar.content, 'base64'))
    writeFileSync(join(dir, 'card.json'), jsons[0]!.content, 'utf8')
    writeFileSync(join(dir, 'converted.yml'), stringifyYaml(converted, { lineWidth: 0 }), 'utf8')
    return { ok: true, id: converted.id, name: converted.name }
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

function withPresetDoc(
  presetRoot: string,
  templateName: string,
  mutate: (doc: ReturnType<typeof parseDocument>) => void,
): void {
  const file = join(presetRoot, templateName, 'preset.yml')
  if (!existsSync(file)) throw new Error(`当前预设 ${templateName} 无 preset.yml`)
  const doc = parseDocument(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  mutate(doc)
  writeFileSync(file, doc.toString(), 'utf8')
}

/** 角色卡参数导入当前预设：promptConfigs 合并（chara-<id>- 前缀防冲突）、
 *  params 合并（角色卡覆盖同键）、meta.importedCharacters 记录来源。 */
export function applyCharacterToPreset(
  presetRoot: string,
  templateName: string,
  cardId: string,
): { ok: true; count: number } | { ok: false; message: string } {
  if (!validCardId(cardId)) return { ok: false, message: `非法角色卡 id：${cardId}` }
  const spec = loadConverted(cardDir(presetRoot, cardId))
  if (spec === undefined) return { ok: false, message: `角色卡 ${cardId} 不存在或参数损坏` }
  const prefix = `chara-${cardId}-`
  try {
    withPresetDoc(presetRoot, templateName, (doc) => {
      const current = doc.toJS() as { promptConfigs?: unknown[]; meta?: { importedCharacters?: unknown[] } }
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
      if (memory.length > 0) {
        const memoryEntry: Record<string, unknown> = {
          id: memoryId,
          name: '角色记忆',
          strategy: 'world-book',
          layer: 'pre-step',
          position: 'before-all',
          enabled: true,
          order: 1000,
          text: `【${spec.name} 的关系记忆】\n${memory}`,
          params: { constant: true },
        }
        doc.setIn(['promptConfigs'], sortConfigs([...existing, ...added, memoryEntry]))
      } else {
        // 合并后按（层序, order）排序写盘：UI 列表与引擎注入顺序一致。
        doc.setIn(['promptConfigs'], sortConfigs([...existing, ...added]))
      }
      const list = Array.isArray(current.meta?.importedCharacters) ? current.meta.importedCharacters : []
      if (!list.map(String).includes(cardId)) list.push(cardId)
      doc.setIn(['meta', 'importedCharacters'], list)
    })
    return { ok: true, count: (spec.promptConfigs ?? []).length }
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
    withPresetDoc(presetRoot, templateName, (doc) => {
      const current = doc.toJS() as { promptConfigs?: unknown[]; meta?: { importedCharacters?: unknown[] } }
      const kept = (Array.isArray(current.promptConfigs) ? current.promptConfigs as Array<Record<string, unknown>> : []).filter((config) => {
        const isCard = config !== null && typeof config === 'object'
          && String(config.id ?? '').startsWith(prefix)
        if (isCard) removed += 1
        return !isCard
      })
      doc.setIn(['promptConfigs'], kept)
      // 删除该卡声明的 params 键（若曾覆盖预设原值无法恢复——文档说明）。
      for (const key of Object.keys(spec?.params ?? {})) {
        doc.deleteIn(['params', key])
      }
      const list = Array.isArray(current.meta?.importedCharacters) ? current.meta.importedCharacters : []
      doc.setIn(['meta', 'importedCharacters'], list.filter((entry) => String(entry) !== cardId))
    })
    return { ok: true, count: removed }
  } catch (error) {
    return { ok: false, message: `移除失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

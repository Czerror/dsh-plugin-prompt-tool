/** 世界书条目 CRUD 服务：promptConfigs world-book 策略配置的增删改查。
 *  与角色卡导入（characters.applyCharacterToPreset）共用同一存储（preset.yml
 *  promptConfigs），模型工具（world_book_*）与未来 bridge 端点同源，
 *  不各自实现 parseDocument 往返。 */
import { loadPresetSpec, withPresetDoc } from './manifest.ts'

export type WorldBookEntry = Record<string, unknown>

const isWorldBook = (config: unknown): config is WorldBookEntry =>
  config !== null && typeof config === 'object' && !Array.isArray(config)
  && (config as WorldBookEntry).strategy === 'world-book'

/** 当前预设全部世界书条目（保持文件顺序）。 */
export function listWorldBookEntries(presetDir: string): WorldBookEntry[] {
  const spec = loadPresetSpec(presetDir)
  return Array.isArray(spec.promptConfigs) ? spec.promptConfigs.filter(isWorldBook) : []
}

/** 新增或更新一条世界书条目（按 id 定位；不存在则追加）。返回写入后条目总数。 */
export function upsertWorldBookEntry(presetDir: string, entry: WorldBookEntry): number {
  if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.length === 0) {
    throw new TypeError('世界书条目必须含非空字符串 id')
  }
  let count = 0
  withPresetDoc(presetDir, (doc) => {
    const current = doc.toJS() as { promptConfigs?: unknown[] }
    const configs = Array.isArray(current.promptConfigs) ? current.promptConfigs as WorldBookEntry[] : []
    const existing = configs.findIndex((config) => String(config.id ?? '') === entry.id)
    if (existing >= 0) configs[existing] = entry
    else configs.push(entry)
    doc.setIn(['promptConfigs'], configs)
    count = configs.filter(isWorldBook).length
  })
  return count
}

/** 删除一条世界书条目；不存在抛错。返回删除后条目总数。 */
export function deleteWorldBookEntry(presetDir: string, id: string): number {
  let count = 0
  let removed = false
  withPresetDoc(presetDir, (doc) => {
    const current = doc.toJS() as { promptConfigs?: unknown[] }
    const configs = Array.isArray(current.promptConfigs) ? current.promptConfigs as WorldBookEntry[] : []
    const kept = configs.filter((config) => !(isWorldBook(config) && String(config.id ?? '') === id))
    removed = kept.length !== configs.length
    doc.setIn(['promptConfigs'], kept)
    count = kept.filter(isWorldBook).length
  })
  if (!removed) throw new Error(`世界书条目 ${id} 不存在`)
  return count
}

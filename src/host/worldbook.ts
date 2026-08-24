/** 世界书条目 CRUD 服务：promptConfigs world-book 策略配置的增删改查。
 *  与角色卡导入（characters.applyCharacterToPreset）共用同一存储（preset.yml
 *  promptConfigs），模型工具（world_book_*）与未来 bridge 端点同源，
 *  不各自实现 parseDocument 往返。 */
import { loadPresetSpec, withPresetDoc } from './manifest.ts'

export type WorldBookEntry = Record<string, unknown>

/** buildWorldBookEntry 输入（两通道共用：ST 导入转换与模型 world_book_upsert 工具）。 */
export interface WorldBookEntryInput {
  /** 条目 id；缺省不写（调用方自行加前缀时用，如角色卡 chara-<卡>- 前缀）。 */
  id?: string
  name: string
  text: string
  /** 注入顺序（层内升序）；缺省 100。 */
  order?: number
  /** 启用状态；缺省不写（引擎默认启用）。 */
  enabled?: boolean
  /** 常驻注入（不依赖关键字）。 */
  constant: boolean
  keys?: string[]
  secondaryKeys?: string[]
  caseSensitive?: boolean
  wholeWords?: boolean
  /** ST selectiveLogic（0/1/2/3 → anchor-match any/all/not/notAny）。 */
  selectiveLogic?: number
}

/**
 * 世界书条目结构工厂（能力归一）。
 * strategy/layer/position 固定值与 params 键集单一权威——ST 导入（sillytavern.ts）
 * 与模型工具（world_book_upsert）共用，不再各自手写条目结构。
 */
export function buildWorldBookEntry(input: WorldBookEntryInput): WorldBookEntry {
  return {
    ...(input.id !== undefined ? { id: input.id } : {}),
    name: input.name,
    strategy: 'world-book',
    order: typeof input.order === 'number' ? input.order : 100,
    text: input.text,
    layer: 'pre-step',
    position: 'before-all',
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    params: {
      constant: input.constant,
      ...(input.keys !== undefined && input.keys.length > 0 ? { keys: input.keys } : {}),
      ...(input.secondaryKeys !== undefined && input.secondaryKeys.length > 0 ? { secondaryKeys: input.secondaryKeys } : {}),
      ...(input.caseSensitive === true ? { caseSensitive: true } : {}),
      ...(input.wholeWords === true ? { wholeWords: true } : {}),
      ...(typeof input.selectiveLogic === 'number' ? { selectiveLogic: input.selectiveLogic } : {}),
    },
  }
}

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

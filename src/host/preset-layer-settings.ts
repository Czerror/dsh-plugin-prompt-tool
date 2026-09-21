/** 预设磁盘参数：按编辑组主归属层存储，运行时仍使用 EngineParams 平铺接口。 */
import { parseDocument, Scalar, YAMLMap } from 'yaml'
import { ENGINE_EDITOR_GROUP_MAP, ENGINE_LAYER_ORDER } from '../shared/engine-capabilities.ts'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, type EngineParamKey } from '../shared/engine-params.ts'

export const ENGINE_PARAM_LAYERS = Object.fromEntries(ENGINE_PARAM_KEYS.map((key) => {
  const layer = ENGINE_EDITOR_GROUP_MAP.find((group) => group.id === ENGINE_PARAM_DEFINITIONS[key].card)?.displayLayer
  if (layer === undefined) throw new Error(`引擎参数未登记所属层：${key}`)
  return [key, layer]
})) as Record<EngineParamKey, string>

/** 只供旧格式识别与显式迁移；运行时不再读取这些位置。 */
export const MODEL_SEGMENT_MAP: Record<string, [string, string]> = {
  modelProvider: ['model', 'provider'],
  modelName: ['model', 'name'],
  modelReasoningEffort: ['model', 'reasoningEffort'],
  modelTemperature: ['model', 'temperature'],
  modelMaxTokens: ['model', 'maxTokens'],
  subagentModelProvider: ['subagentModel', 'provider'],
  subagentModelName: ['subagentModel', 'name'],
  subagentReasoningEffort: ['subagentModel', 'reasoningEffort'],
  subagentTemperature: ['subagentModel', 'temperature'],
  subagentMaxTokens: ['subagentModel', 'maxTokens'],
}

export class PresetLayerSettingsError extends Error {
  readonly code: 'preset-migration-required' | 'preset-layer-settings-invalid'
  constructor(code: PresetLayerSettingsError['code'], message: string) {
    super(`${code}: ${message}`)
    this.name = 'PresetLayerSettingsError'
    this.code = code
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value: unknown, key: string): boolean => isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)

export function engineParamPath(key: string): [string, string, string] {
  if (!Object.prototype.hasOwnProperty.call(ENGINE_PARAM_LAYERS, key)) throw new Error(`未知引擎参数：${key}`)
  return ['layerSettings', ENGINE_PARAM_LAYERS[key as EngineParamKey], key]
}

/** 未登记扩展字段留在原文档，不投影为运行时引擎参数。 */
export function readLayerSettings(value: unknown): Record<string, unknown> {
  const invalid = (message: string): never => { throw new PresetLayerSettingsError('preset-layer-settings-invalid', message) }
  if (value === undefined) return {}
  if (!isRecord(value)) return invalid('layerSettings 必须是对象')
  const params: Record<string, unknown> = {}
  for (const [layer, settings] of Object.entries(value)) {
    if (!(ENGINE_LAYER_ORDER as readonly string[]).includes(layer)) invalid(`未知插入点：layerSettings.${layer}`)
    if (!isRecord(settings)) return invalid(`layerSettings.${layer} 必须是对象`)
    for (const [key, entry] of Object.entries(settings)) {
      if (!Object.prototype.hasOwnProperty.call(ENGINE_PARAM_LAYERS, key)) continue
      const expected = ENGINE_PARAM_LAYERS[key as EngineParamKey]
      if (expected !== layer) invalid(`${key} 必须位于 layerSettings.${expected}`)
      params[key] = entry
    }
  }
  return params
}

function legacyParamPaths(source: Record<string, unknown>): Array<{ key: string; path: [string, string] }> {
  const paths: Array<{ key: string; path: [string, string] }> = []
  for (const key of ENGINE_PARAM_KEYS) {
    if (own(source.params, key)) paths.push({ key, path: ['params', key] })
    const segment = MODEL_SEGMENT_MAP[key]
    if (segment !== undefined && own(source[segment[0]], segment[1])) paths.push({ key, path: segment })
  }
  return paths
}

/** 所有磁盘读写入口先检查旧格式；保存其他段也不能绕过显式迁移。 */
export function readPresetLayerSettings(source: unknown): Record<string, unknown> {
  if (!isRecord(source)) throw new PresetLayerSettingsError('preset-layer-settings-invalid', 'preset.yml 必须是对象')
  const legacy = legacyParamPaths(source)
  if (legacy.length > 0) {
    throw new PresetLayerSettingsError('preset-migration-required', `请先显式迁移旧参数：${legacy.map(({ path }) => path.join('.')).join(', ')}`)
  }
  return readLayerSettings(source.layerSettings)
}

/** 迁移节点而非重建对象，保留值、注释、未知字段和规则实例参数。 */
export function migratePresetLayerSettings(raw: string): { text: string; moved: string[] } {
  const doc = parseDocument(raw, { logLevel: 'silent' })
  if (doc.errors.length > 0 || !(doc.contents instanceof YAMLMap)) throw new Error('预设定义必须是合法 YAML 对象')
  const source = doc.toJS() as Record<string, unknown>
  readLayerSettings(source.layerSettings)
  const paths = legacyParamPaths(source)
  const seen = new Set<string>()
  for (const { key } of paths) {
    if (seen.has(key) || doc.hasIn(engineParamPath(key))) throw new Error(`迁移参数冲突：${key}`)
    seen.add(key)
  }
  for (const { key, path } of paths) {
    const parent = doc.getIn([path[0]], true)
    if (!(parent instanceof YAMLMap)) throw new Error(`迁移源必须是 YAML 对象：${path[0]}`)
    const pair = parent.items.find((item) => item.key instanceof Scalar && item.key.value === path[1])
    if (pair === undefined || !(pair.key instanceof Scalar)) throw new Error(`无法迁移参数：${path.join('.')}`)
    const targetPath = engineParamPath(key)
    if (!doc.hasIn(targetPath.slice(0, 2))) doc.setIn(targetPath.slice(0, 2), doc.createNode({}))
    const target = doc.getIn(targetPath.slice(0, 2), true)
    if (!(target instanceof YAMLMap)) throw new Error(`迁移目标必须是 YAML 对象：${targetPath.slice(0, 2).join('.')}`)
    parent.items.splice(parent.items.indexOf(pair), 1)
    pair.key.value = key
    target.items.push(pair)
  }
  readPresetLayerSettings(doc.toJS())
  return { text: paths.length > 0 ? doc.toString() : raw, moved: [...seen] }
}

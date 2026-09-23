/** 预设磁盘参数：按编辑组主归属层存储，运行时仍使用 EngineParams 平铺接口。 */
import { ENGINE_EDITOR_GROUP_MAP, ENGINE_LAYER_ORDER } from '../shared/engine-capabilities.ts'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, type EngineParamKey } from '../shared/engine-params.ts'

export const ENGINE_PARAM_LAYERS = Object.fromEntries(ENGINE_PARAM_KEYS.map((key) => {
  const layer = ENGINE_EDITOR_GROUP_MAP.find((group) => group.id === ENGINE_PARAM_DEFINITIONS[key].card)?.displayLayer
  if (layer === undefined) throw new Error(`引擎参数未登记所属层：${key}`)
  return [key, layer]
})) as Record<EngineParamKey, string>

/** 仅用于拒绝不支持的旧模型字段；不读取旧值，也不提供迁移。 */
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

/** 所有磁盘读写入口拒绝不支持的参数位置，预设直接维护当前 layerSettings 格式。 */
export function readPresetLayerSettings(source: unknown): Record<string, unknown> {
  if (!isRecord(source)) throw new PresetLayerSettingsError('preset-layer-settings-invalid', 'preset.yml 必须是对象')
  const legacy = legacyParamPaths(source)
  if (legacy.length > 0) {
    throw new PresetLayerSettingsError('preset-migration-required', `不支持旧参数位置，请按 layerSettings 格式更新预设：${legacy.map(({ path }) => path.join('.')).join(', ')}`)
  }
  return readLayerSettings(source.layerSettings)
}

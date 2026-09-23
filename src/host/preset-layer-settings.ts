/** 预设磁盘参数：按编辑组主归属层存储，运行时仍使用 EngineParams 平铺接口。 */
import { ENGINE_EDITOR_GROUP_MAP, ENGINE_LAYER_ORDER } from '../shared/engine-capabilities.ts'
import { ENGINE_PARAM_DEFINITIONS, ENGINE_PARAM_KEYS, type EngineParamKey } from '../shared/engine-params.ts'

export const ENGINE_PARAM_LAYERS = Object.fromEntries(ENGINE_PARAM_KEYS.map((key) => {
  const layer = ENGINE_EDITOR_GROUP_MAP.find((group) => group.id === ENGINE_PARAM_DEFINITIONS[key].card)?.displayLayer
  if (layer === undefined) throw new Error(`引擎参数未登记所属层：${key}`)
  return [key, layer]
})) as Record<EngineParamKey, string>

export class PresetLayerSettingsError extends Error {
  readonly code = 'preset-layer-settings-invalid'
  constructor(message: string) {
    super(`preset-layer-settings-invalid: ${message}`)
    this.name = 'PresetLayerSettingsError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function engineParamPath(key: string): [string, string, string] {
  if (!Object.prototype.hasOwnProperty.call(ENGINE_PARAM_LAYERS, key)) throw new Error(`未知引擎参数：${key}`)
  return ['layerSettings', ENGINE_PARAM_LAYERS[key as EngineParamKey], key]
}

/** 未登记扩展字段留在原文档，不投影为运行时引擎参数。 */
export function readLayerSettings(value: unknown): Record<string, unknown> {
  const invalid = (message: string): never => { throw new PresetLayerSettingsError(message) }
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

/** 仅消费当前 layerSettings；其余段作为未知字段留存，不投影为运行时参数。 */
export function readPresetLayerSettings(source: unknown): Record<string, unknown> {
  if (!isRecord(source)) throw new PresetLayerSettingsError('preset.yml 必须是对象')
  return readLayerSettings(source.layerSettings)
}

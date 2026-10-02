/** 旧层参数到规则实例的唯一兼容投影；读取、导入物化与旧 API 保存共用。 */
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LEGACY_PROMPT_PARAM_DEFINITIONS, LEGACY_PROMPT_PARAM_KEYS, isLegacyPromptParam, type LegacyPromptParamKey } from '../shared/legacy-prompt-params.ts'
import { PresetLayerSettingsError } from './module-layer-settings.ts'
import { mergePromptConfigs, type PromptConfigSpec } from './prompt-configs.ts'

interface LegacyPromptSource {
  layerSettings?: unknown
  promptConfigs?: unknown[]
  content?: { presetText?: unknown }
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string => value === undefined || value === null ? '' : String(value)

export function readLegacyPromptParams(source: LegacyPromptSource): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (!isRecord(source.layerSettings)) return params
  for (const [layer, settings] of Object.entries(source.layerSettings)) {
    if (!isRecord(settings)) continue
    for (const [key, value] of Object.entries(settings)) {
      if (!isLegacyPromptParam(key)) continue
      if (layer !== 'pre-step') throw new PresetLayerSettingsError(`${key} 必须位于 layerSettings.pre-step`)
      params[key] = value === 'on' ? true : value === 'off' ? false : value
    }
  }
  return params
}

function legacyBody(source: LegacyPromptSource, moduleDir?: string, supplied?: string): string {
  if (supplied !== undefined) return supplied
  if (moduleDir !== undefined) {
    try {
      const file = join(moduleDir, 'preset.md')
      if (lstatSync(file).isSymbolicLink()) throw new Error(`旧模块正文不能是链接：${file}`)
      return readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return text(source.content?.presetText)
}

export function resolveLegacyPromptConfigs(source: LegacyPromptSource, options: {
  moduleDir?: string
  prompt?: string
  overrides?: Record<string, unknown>
  promptConfigs?: PromptConfigSpec[]
  /** 旧 API 写入已完成收口的规则时，只改本次提供的键。 */
  partial?: boolean
} = {}): { configs: PromptConfigSpec[]; consumedKeys: LegacyPromptParamKey[]; warnings: string[]; active: boolean } {
  const params = readLegacyPromptParams(source)
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (isLegacyPromptParam(key) && value !== undefined && value !== null) params[key] = value
  }
  const keys = LEGACY_PROMPT_PARAM_KEYS.filter(key => Object.hasOwn(params, key))
  const applies = (id: string): boolean => keys.some(key => (LEGACY_PROMPT_PARAM_DEFINITIONS[key].targets as readonly string[]).includes(id))
  const provided = (key: string): boolean => options.partial !== true || Object.hasOwn(params, key)
  const template = (source.promptConfigs ?? []) as PromptConfigSpec[]
  const projected = template.map(config => {
    if (!isRecord(config) || !applies(config.id)) return config
    const next = { ...config, params: { ...config.params } }
    if (config.id === 'near-anchor') {
      if (provided('firstTurnAnchor')) next.enabled = params.firstTurnAnchor === true
      if (provided('firstTurnCustom')) next.params.useCustom = params.firstTurnCustom === true
      if (provided('firstTurnText')) next.params.text = text(params.firstTurnText)
      for (const key of ['buildPattern', 'complexPattern', 'firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep']) {
        if (provided(key)) next.params[key] = text(params[key])
      }
    } else if (config.id === 'router-guide') {
      if (provided('guideEnabled')) next.enabled = params.guideEnabled === true
      if (provided('guideCustom') || provided('guideEnabled')) {
        const useCustom = provided('guideCustom') ? params.guideCustom === true : next.params.useCustom === true
        next.params.useCustom = useCustom
        next.modelScope = useCustom ? 'all' : 'flash'
      }
      if (provided('guideText')) next.params.text = text(params.guideText)
      for (const key of ['complexPattern', 'guideWeak', 'guideDeep']) {
        if (provided(key)) next.params[key] = text(params[key])
      }
    }
    return next
  })
  // 旧 writer 的覆盖层可替换 near-anchor/router-guide；正文注入器最后绑定文件内容。
  const configs = mergePromptConfigs(projected, options.promptConfigs).map(config => {
    if (config.id !== 'prompt-injector' || !applies(config.id)) return config
    const body = legacyBody(source, options.moduleDir, options.prompt)
    const explicitWord = text(options.partial === true && Object.hasOwn(params, 'firstTurnWord')
      ? params.firstTurnWord : config.params?.firstTurnWord ?? params.firstTurnWord)
    const anchor = projected.find(entry => entry.id === 'near-anchor')
    const signalWord = (value: string): string | undefined => {
      const sentence = /the exact sentence:\s*([A-Za-z]+)/i.exec(value)
      const first = /^\P{L}*([\p{L}]+)/u.exec(value.trim())
      return (sentence?.[1] ?? first?.[1])?.toLowerCase()
    }
    const derivedWords = [...new Set(['firstTurnText', 'firstTurnBuild', 'firstTurnInspect', 'firstTurnDeep'].map(key =>
      signalWord(text(Object.hasOwn(params, key) || options.partial !== true ? params[key] : anchor?.params?.[key === 'firstTurnText' ? 'text' : key])),
    ).filter((word): word is string => word !== undefined))]
    const { text: _text, texts: _texts, ...rest } = config
    return { ...rest, enabled: body.trim().length > 0 && (provided('injectPrompt') ? params.injectPrompt !== false : config.enabled !== false),
      params: { ...config.params, text: body, firstTurnWord: explicitWord, anchorWords: explicitWord.length > 0 ? [explicitWord] : derivedWords } }
  })
  const ids = new Set(configs.map(config => config.id))
  const consumedKeys = keys.filter(key => LEGACY_PROMPT_PARAM_DEFINITIONS[key].targets.some(id => ids.has(id)))
  const unhandled = keys.filter(key => !consumedKeys.includes(key))
  return { configs, consumedKeys, active: keys.length > 0,
    warnings: unhandled.length === 0 ? [] : [`旧规则参数没有承接配置，原值保留：${unhandled.join(', ')}`] }
}

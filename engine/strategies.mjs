/**
 * strategies — 引擎内容策略绑定(config.resolve)。
 * 内置策略: static / placeholder / instruction-hint / first-turn-anchor / guide-auto / custom-fallback。
 * 策略参数全部来自 config.params（由 preset.yml 单一配置源下发），引擎只负责组装。
 * 仍支持 strategyDir 懒加载自定义模板策略。
 */

import { MAX_TRACKED_SESSIONS, extractText } from './shared.mjs'
import { MATCH_LOGIC, createAnchorMatcher } from './anchor-match.mjs'
import { createTaskClassifier } from './classify-task.mjs'
import { createPlaceholderResolver } from './fillers.mjs'
import { createInstructionHintResolver } from './instruction-hint.mjs'

const name = 'prompt-config-engine'

/**
 * first-turn-anchor:首条真实用户消息后的一次性任务锚点。
 * 正则与锚句文本全部来自 config.params（由 preset.yml 单一配置源下发）。
 */
function createFirstTurnAnchorResolver(config) {
  const useCustom = config.params?.useCustom === true
  // 自定义文本统一读 text（与 guide-auto 同契约）；firstTurnText 旧键兼容。
  const customText = typeof config.params?.text === 'string'
    ? config.params.text
    : (typeof config.params?.firstTurnText === 'string' ? config.params.firstTurnText : '')
  const buildPattern = typeof config.params?.buildPattern === 'string' ? config.params.buildPattern : ''
  const complexPattern = typeof config.params?.complexPattern === 'string' ? config.params.complexPattern : ''
  const firstTurnBuild = typeof config.params?.firstTurnBuild === 'string' ? config.params.firstTurnBuild : ''
  const firstTurnInspect = typeof config.params?.firstTurnInspect === 'string' ? config.params.firstTurnInspect : ''
  const firstTurnDeep = typeof config.params?.firstTurnDeep === 'string' ? config.params.firstTurnDeep : ''
  const classifier = createTaskClassifier({ buildPattern, complexPattern })
  return ({ messages }) => {
    if (useCustom) {
      const text = customText.trim()
      return text.length > 0 ? { text } : null
    }
    if (!classifier.ready || (firstTurnBuild.length === 0 && firstTurnInspect.length === 0 && firstTurnDeep.length === 0)) {
      return null
    }
    const userIndex = messages.findIndex((message) => message?.source?.kind === 'user')
    if (userIndex < 0) return null
    const taskText = extractText(messages[userIndex])
    if (taskText.length === 0) return null
    const kind = classifier.classify(taskText)
    const anchor = kind === 'complex' ? firstTurnDeep : kind === 'build' ? firstTurnBuild : firstTurnInspect
    return anchor.length > 0 ? { text: anchor } : null
  }
}

/**
 * guide-auto:晋升后每轮用户消息后的弱/深度引导。
 * 正则与引导文本全部来自 config.params（由 preset.yml 单一配置源下发）。
 * 复杂任务判定 fallback 复用锚定功能的 complexPattern（guideComplexPattern
 * 冗余副本已移除）——锚定与引导是独立功能，仅分类器共用。
 */
function createGuideAutoResolver(config) {
  const useCustom = config.params?.useCustom === true
  const customText = typeof config.params?.text === 'string' ? config.params.text : ''
  const complexPattern = typeof config.params?.complexPattern === 'string' ? config.params.complexPattern : ''
  const guideWeak = typeof config.params?.guideWeak === 'string' ? config.params.guideWeak : ''
  const guideDeep = typeof config.params?.guideDeep === 'string' ? config.params.guideDeep : ''
  // 复杂判定 fallback 复用锚定分类器（buildPattern 不参与引导判定）。
  const classifier = createTaskClassifier({ complexPattern })
  return ({ messages }) => {
    const userIndex = messages.findIndex((message) => message?.source?.kind === 'user')
    if (userIndex < 0) return null
    const text = extractText(messages[userIndex])
    if (text.length === 0) return null
    if (useCustom) {
      const guide = customText.trim()
      return guide.length > 0 ? { text: guide } : null
    }
    if (guideWeak.length === 0 && guideDeep.length === 0) return null
    return { text: (text.length > 120 || classifier.isComplex(text)) ? guideDeep : guideWeak }
  }
}

/**
 * custom-fallback:自定义锚定词命中后注入一次，未命中最多两轮兜底。
 * 参数全部来自 config.params（由 preset.yml 单一配置源下发）。
 */
function createCustomFallbackResolver(config) {
  const promptText = config.texts.length > 0
    ? config.texts.join('\n\n')
    : (typeof config.params?.text === 'string' && config.params.text.length > 0 ? config.params.text : undefined)
  const firstTurnWord = typeof config.params?.firstTurnWord === 'string' && config.params.firstTurnWord.length > 0
    ? config.params.firstTurnWord
    : 'we'
  // 确认词集合：writePreset 派生的 anchorWords 优先（锚句信号词多词 prefix，任一命中即
  // 确认——deep 档 Let…/自定义锚句首词都覆盖）；旧产物无 anchorWords 时回退 firstTurnWord 单词。
  const anchorWords = Array.isArray(config.params?.anchorWords) && config.params.anchorWords.length > 0
    ? config.params.anchorWords.map(String).filter((word) => word.length > 0)
    : [firstTurnWord]
  // 锚定匹配经 anchor-match 引擎（prefix 模式：首轮 reasoning 开头命中任一确认词）。
  const anchor = createAnchorMatcher({ keys: anchorWords, mode: 'prefix' })

  const anchorScanned = new Map()

  const isAnchorConfirmed = (agent) => {
    const session = agent.session
    const cached = anchorScanned.get(session.id)
    if (cached !== undefined) return cached
    const first = session.events.find((event) => event.type === 'assistant/message')
    if (first === undefined) return false
    const content = first.data?.message?.content ?? []
    const reasoning = content.find((block) => block.type === 'reasoning')
    const confirmed = reasoning !== undefined && anchor.scan(String(reasoning.text ?? '')).active
    if (anchorScanned.size >= MAX_TRACKED_SESSIONS) anchorScanned.clear()
    anchorScanned.set(session.id, confirmed)
    return confirmed
  }

  const assistantRounds = (agent) =>
    agent.session.events.filter((event) => event.type === 'assistant/message').length

  return ({ agent }) => {
    if (promptText === undefined) return null
    const session = agent.session
    const confirmed = isAnchorConfirmed(agent)
    if (!confirmed && assistantRounds(agent) <= 1) return null
    return {
      text: promptText,
      source: {
        kind: 'plugin',
        plugin: config.id,
        form: 'notice',
        summary: confirmed
          ? `prompt-tool 提示词(「${firstTurnWord}」锚定确认后注入)`
          : `prompt-tool 提示词(「${firstTurnWord}」未确认,兜底注入)`,
      },
    }
  }
}

/**
 * world-book:世界书条目(角色卡 lorebook)。constant=true 恒注入(不扫 keys);
 * selective 条目扫描当前消息批文本,keys/secondaryKeys 按 selectiveLogic 组合
 * (any=任一命中 / all=副键全中 / not=副键全不中)。匹配经 anchor-match 引擎。
 */
function createWorldBookResolver(config) {
  const constant = config.params?.constant === true
  // selectiveLogic：ST world_info_logic 0=AND_ANY 1=NOT_ALL 2=NOT_ANY 3=AND_ALL。
  const rawLogic = config.params?.selectiveLogic
  const logic = rawLogic === 3
    ? MATCH_LOGIC.ALL
    : (rawLogic === 1
      ? MATCH_LOGIC.NOT
      : (rawLogic === 2 ? MATCH_LOGIC.NOT_ANY : MATCH_LOGIC.ANY))
  const matcher = createAnchorMatcher({
    keys: Array.isArray(config.params?.keys) ? config.params.keys : [],
    secondaryKeys: Array.isArray(config.params?.secondaryKeys) ? config.params.secondaryKeys : [],
    caseSensitive: config.params?.caseSensitive === true,
    wholeWords: config.params?.wholeWords === true,
    // 三态透传：undefined=ST 语义自动检测（/regex/ 或含特殊字符键按正则）；
    // 存量配置显式 true/false 仍强制对应行为。
    useRegex: config.params?.useRegex,
    logic,
  })
  // ST 语义：constant 或无任何键的条目恒注入（always active）。
  const hasAnyKey = (Array.isArray(config.params?.keys) ? config.params.keys : [])
      .some((key) => String(key).trim().length > 0)
    || (Array.isArray(config.params?.secondaryKeys) ? config.params.secondaryKeys : [])
      .some((key) => String(key).trim().length > 0)
  const promptText = config.texts.length > 0
    ? config.texts.join('\n\n')
    : (typeof config.params?.text === 'string' && config.params.text.length > 0 ? config.params.text : undefined)
  return ({ messages }) => {
    if (promptText === undefined) return null
    if (constant || !hasAnyKey) return { text: promptText }
    const haystack = (Array.isArray(messages) ? messages : [])
      .map((message) => extractText(message))
      .filter((text) => text.length > 0)
      .join('\n')
    if (haystack.length === 0) return null
    return matcher.scan(haystack).active ? { text: promptText } : null
  }
}

/**
 * 为归一化后的提示词配置绑定策略 resolve(策略状态随提示词配置对象,不随 apply)。
 * strategyDir:外部策略模块目录(相对本文件 URL)。未声明时只允许内置策略。
 */
export function bindResolver(config, strategyDir) {
  switch (config.strategy) {
    case 'placeholder': return createPlaceholderResolver(config)
    case 'instruction-hint': return createInstructionHintResolver(config)
    case 'first-turn-anchor': return createFirstTurnAnchorResolver(config)
    case 'guide-auto': return createGuideAutoResolver(config)
    case 'custom-fallback':
      return createCustomFallbackResolver(config)
    case 'world-book':
      return createWorldBookResolver(config)
    case 'static': {
      const texts = config.texts
      const patch = config.templatePatch ?? {}
      return () => {
        if (texts.length > 0) return { ...patch, content: texts.map((item) => ({ type: 'text', text: item })) }
        return null
      }
    }
    default: {
      // 模板专属策略:懒加载 <strategyDir>/<strategy>.mjs,模块约定导出
      // `createResolver(config)` 或默认导出同名工厂。加载失败按单配置失败语义
      // 抛给调用方(executor 会跳过该配置并 warnOnce)。
      if (typeof strategyDir !== 'string' || strategyDir.length === 0) {
        throw new TypeError(`${name}: unknown config strategy ${JSON.stringify(config.strategy)}`)
      }
      const moduleUrl = new URL(`${config.strategy}.mjs`, strategyDir.endsWith('/') ? strategyDir : `${strategyDir}/`)
      let loaded
      return async (args) => {
        if (loaded === undefined) {
          loaded = await import(moduleUrl.href)
        }
        const make = typeof loaded.createResolver === 'function'
          ? loaded.createResolver
          : typeof loaded.default === 'function'
            ? loaded.default
            : undefined
        if (typeof make !== 'function') {
          throw new TypeError(`${name}: strategy module ${moduleUrl.href} must export createResolver(config)`)
        }
        return make(config)(args)
      }
    }
  }
}

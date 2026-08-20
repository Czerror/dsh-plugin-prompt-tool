/**
 * strategies — 引擎内容策略绑定(config.resolve)。
 * 内置策略: static / placeholder / instruction-hint / first-turn-anchor / guide-auto / custom-fallback。
 * 策略参数全部来自 config.params（由 preset.yml 单一配置源下发），引擎只负责组装。
 * 仍支持 strategyDir 懒加载自定义模板策略。
 */

import { extractText } from './shared.mjs'
import { createInstructionHintResolver, createPlaceholderResolver } from './fillers.mjs'

const name = 'prompt-config-engine'

/** 锚定词正则转义。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * first-turn-anchor:首条真实用户消息后的一次性任务锚点。
 * 正则与锚句文本全部来自 config.params（由 preset.yml 单一配置源下发）。
 */
function createFirstTurnAnchorResolver(config) {
  const useCustom = config.params?.useCustom === true
  const customText = typeof config.params?.firstTurnText === 'string' ? config.params.firstTurnText : ''
  const buildPattern = typeof config.params?.buildPattern === 'string' ? config.params.buildPattern : ''
  const complexPattern = typeof config.params?.complexPattern === 'string' ? config.params.complexPattern : ''
  const firstTurnBuild = typeof config.params?.firstTurnBuild === 'string' ? config.params.firstTurnBuild : ''
  const firstTurnInspect = typeof config.params?.firstTurnInspect === 'string' ? config.params.firstTurnInspect : ''
  const firstTurnDeep = typeof config.params?.firstTurnDeep === 'string' ? config.params.firstTurnDeep : ''
  const buildRe = buildPattern.length > 0 ? new RegExp(buildPattern, 'i') : undefined
  const complexRe = complexPattern.length > 0 ? new RegExp(complexPattern, 'i') : undefined
  return ({ messages }) => {
    if (useCustom) {
      const text = customText.trim()
      return text.length > 0 ? { text } : null
    }
    if (buildRe === undefined || complexRe === undefined || (firstTurnBuild.length === 0 && firstTurnInspect.length === 0 && firstTurnDeep.length === 0)) {
      return null
    }
    const userIndex = messages.findIndex((message) => message?.source?.kind === 'user')
    if (userIndex < 0) return null
    const taskText = extractText(messages[userIndex])
    if (taskText.length === 0) return null
    let anchor
    if (complexRe.test(taskText)) anchor = firstTurnDeep
    else if (buildRe.test(taskText)) anchor = firstTurnBuild
    else anchor = firstTurnInspect
    return anchor.length > 0 ? { text: anchor } : null
  }
}

/**
 * guide-auto:晋升后每轮用户消息后的弱/深度引导。
 * 正则与引导文本全部来自 config.params（由 preset.yml 单一配置源下发）。
 */
function createGuideAutoResolver(config) {
  const useCustom = config.params?.useCustom === true
  const customText = typeof config.params?.text === 'string' ? config.params.text : ''
  const guideComplexPattern = typeof config.params?.guideComplexPattern === 'string' ? config.params.guideComplexPattern : ''
  const guideWeak = typeof config.params?.guideWeak === 'string' ? config.params.guideWeak : ''
  const guideDeep = typeof config.params?.guideDeep === 'string' ? config.params.guideDeep : ''
  const guideComplexRe = guideComplexPattern.length > 0 ? new RegExp(guideComplexPattern, 'i') : undefined
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
    return { text: (text.length > 120 || (guideComplexRe !== undefined && guideComplexRe.test(text))) ? guideDeep : guideWeak }
  }
}

/** 判断 reasoning 开头是否命中自定义锚定词:ASCII 词按词边界匹配,其他按前缀匹配。 */
function matchesAnchorWord(raw, firstTurnWord) {
  const text = String(raw ?? '').trim()
  if (text.length === 0 || firstTurnWord.length === 0) return false
  if (/^[\x20-\x7E]+$/.test(firstTurnWord)) {
    return new RegExp(`^${escapeRegExp(firstTurnWord.toLowerCase())}\\b`, 'i').test(text)
  }
  return text.startsWith(firstTurnWord)
}

/**
 * custom-fallback:自定义锚定词命中后注入一次，未命中最多两轮兜底。
 * 参数全部来自 config.params（由 preset.yml 单一配置源下发）。
 */
function createCustomFallbackResolver(config) {
  const promptText = (typeof config.text === 'string' && config.text.length > 0)
    ? config.text
    : (typeof config.params?.text === 'string' && config.params.text.length > 0 ? config.params.text : undefined)
  const firstTurnWord = typeof config.params?.firstTurnWord === 'string' && config.params.firstTurnWord.length > 0
    ? config.params.firstTurnWord
    : (typeof config.params?.firstTurnWord === 'string' && config.params.firstTurnWord.length > 0
        ? config.params.firstTurnWord
        : 'we')

  const anchorScanned = new Map()

  const isAnchorConfirmed = (agent) => {
    const session = agent.session
    const cached = anchorScanned.get(session.id)
    if (cached !== undefined) return cached
    const first = session.events.find((event) => event.type === 'assistant/message')
    if (first === undefined) return false
    const content = first.data?.message?.content ?? []
    const reasoning = content.find((block) => block.type === 'reasoning')
    const confirmed = reasoning !== undefined && matchesAnchorWord(reasoning.text, firstTurnWord)
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
    case 'static': {
      const text = config.text
      const texts = config.texts
      const patch = config.templatePatch ?? {}
      return () => {
        if (texts.length > 0) return { ...patch, content: texts.map((item) => ({ type: 'text', text: item })) }
        return text.length > 0 ? { ...patch, text } : null
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

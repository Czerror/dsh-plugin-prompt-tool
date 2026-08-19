/**
 * strategies — 引擎内容策略绑定(config.resolve)。
 * 内置通用策略:static / placeholder / instruction-hint(兼容别名)。
 * 模板专属策略(如 anchored 的 anchor-auto / guide-auto / anchor-fallback)
 * 可通过 createPromptConfigs(specs, { strategyDir }) 从外部模块懒加载。
 */

import { extractText } from './shared.mjs'
import { createInstructionHintResolver, createPlaceholderResolver } from './fillers.mjs'

const name = 'prompt-config-engine'

// ── 通用策略默认文本 ───────────────────────────────────────────────────────
export const DEFAULT_GUIDE_TEXT = ['简单任务自动引导:', 'Router: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.', '', '复杂任务自动引导:', 'Router: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'].join('\n')

/** 锚定词正则转义。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * anchor-auto(通用策略):首条真实用户消息后的一次性任务锚点。
 * 锚句与分类正则均为引擎内置默认;params.useCustom / params.anchorText 由预设参数覆盖。
 */
const BUILD_RE = /(开发|创建|写一个|生成|从零|做一个|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/i
const COMPLEX_RE = /(架构|重构|设计|系统|全面|深度|迁移|兼容|审查|architecture|refactor|comprehensive|design|system|migrate|review)/i
export const ANCHOR_BUILD = "Start your reasoning with the exact sentence: 'We need to build it directly and verify it.'"
export const ANCHOR_INSPECT = "Start your reasoning with the exact sentence: 'We need to inspect the code first.'"
export const ANCHOR_DEEP = "Start your reasoning with the exact sentence: 'Let me think through the design before changing anything.'"

function createAnchorAutoResolver(config) {
  const useCustom = config.params?.useCustom === true
  const customText = typeof config.params?.anchorText === 'string' ? config.params.anchorText : ''
  return ({ messages }) => {
    if (useCustom) {
      const text = customText.trim()
      return text.length > 0 ? { text } : null
    }
    const userIndex = messages.findIndex((message) => message?.source?.kind === 'user')
    if (userIndex < 0) return null
    const taskText = extractText(messages[userIndex])
    if (taskText.length === 0) return null
    let anchor
    if (COMPLEX_RE.test(taskText)) anchor = ANCHOR_DEEP
    else if (BUILD_RE.test(taskText)) anchor = ANCHOR_BUILD
    else anchor = ANCHOR_INSPECT
    return { text: anchor }
  }
}

/**
 * guide-auto(通用策略):晋升后每轮用户消息后的弱/深度引导。
 * 引导文本为引擎内置默认;params.useCustom / params.text 由预设参数覆盖。
 */
const GUIDE_COMPLEX_RE = /(架构|重构|全面|详细|设计|系统|优化|分析|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i
export const GUIDE_WEAK = '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.'
export const GUIDE_DEEP = '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'

function createGuideAutoResolver(config) {
  const useCustom = config.params?.useCustom === true
  const customText = typeof config.params?.text === 'string' ? config.params.text : ''
  const unchangedDefault = customText.trim() === DEFAULT_GUIDE_TEXT.trim()
  return ({ messages }) => {
    const userIndex = messages.findIndex((message) => message?.source?.kind === 'user')
    if (userIndex < 0) return null
    const text = extractText(messages[userIndex])
    if (text.length === 0) return null
    if (useCustom && !unchangedDefault) {
      const guide = customText.trim()
      return guide.length > 0 ? { text: guide } : null
    }
    return { text: (text.length > 120 || GUIDE_COMPLEX_RE.test(text)) ? GUIDE_DEEP : GUIDE_WEAK }
  }
}

/** 判断 reasoning 开头是否命中自定义锚定词:ASCII 词按词边界匹配,其他按前缀匹配。 */
function matchesAnchorWord(raw, anchorWord) {
  const text = String(raw ?? '').trim()
  if (text.length === 0 || anchorWord.length === 0) return false
  if (/^[\x20-\x7E]+$/.test(anchorWord)) {
    return new RegExp(`^${escapeRegExp(anchorWord.toLowerCase())}\\b`, 'i').test(text)
  }
  return text.startsWith(anchorWord)
}

/**
 * anchor-fallback(we-fallback 为其兼容别名):通用自定义锚定词注入。
 * params.anchorWord 可锚定任意词/字(默认 "we"):晋升后首个 reasoning 命中
 * 立即注入一次,未命中最多等满两轮兜底。与任何模板内容无关,因此属于引擎内置。
 */
function createAnchorFallbackResolver(config) {
  const promptText = (typeof config.text === 'string' && config.text.length > 0)
    ? config.text
    : (typeof config.params?.text === 'string' && config.params.text.length > 0 ? config.params.text : undefined)
  const anchorWord = typeof config.params?.anchorWord === 'string' && config.params.anchorWord.length > 0
    ? config.params.anchorWord
    : 'we'

  /** Sessions whose first assistant reasoning has been scanned (memoized). */
  const anchorScanned = new Map()

  const isAnchorConfirmed = (agent) => {
    const session = agent.session
    const cached = anchorScanned.get(session.id)
    if (cached !== undefined) return cached
    const first = session.events.find((event) => event.type === 'assistant/message')
    // 首个 assistant 消息尚未落库时不要缓存 false,等待下一轮再查。
    if (first === undefined) return false
    const content = first.data?.message?.content ?? []
    const reasoning = content.find((block) => block.type === 'reasoning')
    const confirmed = reasoning !== undefined && matchesAnchorWord(reasoning.text, anchorWord)
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
          ? `prompt-tool 提示词(「${anchorWord}」锚定确认后注入)`
          : `prompt-tool 提示词(「${anchorWord}」未确认,兜底注入)`,
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
    case 'instruction-hint': return createInstructionHintResolver()
    case 'anchor-auto': return createAnchorAutoResolver(config)
    case 'guide-auto': return createGuideAutoResolver(config)
    case 'anchor-fallback':
    case 'we-fallback': return createAnchorFallbackResolver(config)
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

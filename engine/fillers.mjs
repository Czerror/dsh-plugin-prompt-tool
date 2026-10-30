/**
 * fillers — 引擎内置的动态填充器(strategy=placeholder 的数据源)。
 * 按本次求值读取宿主能力；失败由填充器或调用方诊断并跳过该配置。
 */

import { getService, parseToolNames } from './shared.mjs'
import { toolScopeSnapshot } from './tool-scope.mjs'
import { machinePaths } from './machine-paths.mjs'
import { SAFE_ENV_KEYS } from './env-safety.mjs'
import { createInstructionHintResolver } from './instruction-hint.mjs'
import { DISCOVERY_SERVICE, SOUL_SELF_SERVICE } from './service-names.mjs'

const name = 'prompt-config-engine'

function explicitTemplate(config) {
  const texts = Array.isArray(config.texts) ? config.texts : typeof config.text === 'string' ? [config.text] : []
  return texts.length > 0 ? texts.join('\n\n') : typeof config.params?.text === 'string' ? config.params.text : ''
}

/**
 * 只读同规则工具面声明；文案、条件和投递仍归普通注入动作。
 * RESIDENT_TOOLS 只列**当前可见**的常驻工具：部署层名单可以登记替换提供方（如 dsh-ops 的
 * ops_bash），但该插件未必安装；向模型宣告一个不存在的常驻工具会把「解锁」变成错误前提。
 * 观测到工具面但一个常驻名都不在时（requireMatch 全缺/放宽场景）跳过提示；
 * 观测不到工具面（服务缺失或读取失败）才回落声明名单——「没看到」不等于「都没有」。
 */
function visibleToolNames(ctx, agent) {
  try {
    const tools = getService(ctx, 'tools')
    if (tools === undefined || typeof tools.schemas !== 'function') return undefined
    return new Set(toolScopeSnapshot(tools, agent).visible.map((schema) => schema?.name))
  } catch {
    return undefined
  }
}
function createToolCatalogResolver(config) {
  if (config.params?.templateEvaluation === true) throw new TypeError('tool-catalog is read-only and does not support templateEvaluation')
  if (typeof config.params?.action !== 'string' || config.params.action.trim().length === 0) {
    throw new TypeError('tool-catalog requires params.action referencing a tool-visibility action')
  }
  const text = explicitTemplate(config)
  return ({ ctx, agent }) => {
    if (text.trim().length === 0) return null
    const source = config.toolCatalogSource
    if (source === undefined) throw new TypeError('tool-catalog requires a same-rule tool-visibility action')
    const deny = new Set(source.deny ?? [])
    const declared = [...new Set(source.allow)].filter(tool => !deny.has(tool))
    const adapter = source.discovery === undefined ? undefined
      : getService(ctx, DISCOVERY_SERVICE)?.get?.(agent, source.discovery.kind)
    if (source.discovery !== undefined && typeof adapter?.tool !== 'string') {
      throw new Error(`tool-catalog discovery adapter ${source.discovery.kind} is unavailable`)
    }
    let resident = declared
    const visible = visibleToolNames(ctx, agent)
    if (visible !== undefined) {
      const present = declared.filter((name) => visible.has(name))
      // 观测到全缺时不宣告任何常驻工具：与 requireMatch 放宽同源，避免「解锁」建在错误前提上。
      if (present.length === 0) return null
      resident = present
    }
    return { text, variables: { RESIDENT_TOOLS: resident.join(', '), DISCOVERY_TOOL: adapter?.tool ?? '' } }
  }
}

/**
 * env-facts:机器事实动态填充器。
 * params.envKeys 逗号分隔环境变量白名单：取值归模板/预设，留空 = 不附加宿主环境
 * 变量（CWD/WORKSPACE 仍由会话事实提供）。白名单外的键在构造期拒绝，不读取任意 process.env。
 * 只提供 facts 变量；正文必须由 text/params.text 显式模板声明。
 */
function createEnvFactsResolver(config) {
  const template = explicitTemplate(config)
  const keys = parseToolNames(typeof config.params?.envKeys === 'string' ? config.params.envKeys : '')
  const rejected = keys.filter((key) => !SAFE_ENV_KEYS.has(key))
  if (rejected.length > 0) {
    throw new TypeError(`${name}: env-facts envKeys not in SAFE_ENV_KEYS: ${rejected.join(', ')} — safe keys: ${[...SAFE_ENV_KEYS].join(', ')}`)
  }
  if (template.trim().length === 0) return () => null
  return ({ agent }) => {
    const session = agent?.session
    // 路径类事实取唯一来源；白名单（envKeys）与「空串不算有值」是本处的策略，不外包。
    const paths = machinePaths(session)
    const facts = {}
    for (const key of keys) {
      let value
      if (key === 'CWD') value = paths.CWD
      else if (key === 'WORKSPACE') value = paths.WORKSPACE
      else if (key === 'DSH_HOME') value = paths.DSH_HOME
      else value = process.env[key]
      if (typeof value === 'string' && value.length > 0) facts[key] = value
    }
    facts.WORKSPACE = paths.WORKSPACE
    facts.CWD = paths.CWD
    const envFacts = Object.entries(facts).map(([key, value]) => `- ${key}=${value}`).join('\n')
    return { text: template, variables: { ...facts, ENV_FACTS: envFacts } }
  }
}

/**
 * skill-catalog:技能目录动态填充器。
 * 数据来自宿主 skills 服务(聚合各 provider;本插件 provider 的 list 已按
 * skillSwitches 过滤,因此目录天然只含已启用技能)。服务缺失或列表失败时
 * 跳过本配置并告警一次,绝不伤及会话。
 */
function createSkillCatalogResolver(config) {
  const template = explicitTemplate(config)
  if (template.trim().length === 0) return () => null
  const rawLimit = config.params?.limit
  const limit = rawLimit == null || rawLimit === '' ? undefined : rawLimit
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new TypeError(`${name}: skill-catalog limit must be a non-negative integer`)
  const fields = parseToolNames(typeof config.params?.fields === 'string' ? config.params.fields : '')
    .filter((field) => ['name', 'description', 'whenToUse'].includes(field))
  const whenToUseLabel = typeof config.params?.whenToUseLabel === 'string' ? config.params.whenToUseLabel : ''
  const unnamedLabel = typeof config.params?.unnamedLabel === 'string' ? config.params.unnamedLabel : ''
  const providers = parseToolNames(config.params?.providers)
  const emptyBehavior = config.params?.emptyBehavior === 'text' ? 'text' : 'skip'
  // 空结果提示文案归模板/预设：留空且 emptyBehavior=text 时按 skip 处理（不注入空消息）。
  const emptyText = typeof config.params?.emptyText === 'string' ? config.params.emptyText : ''
  let warned = false
  // ctx 直到 resolve 时才可用；每个填充器实例只告警一次，不让日志失败伤及会话。
  const warnOnceLocal = (ctx, message) => {
    if (warned) return
    warned = true
    try {
      ctx?.logger?.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  return async ({ ctx, agent, session }) => {
    try {
      const skills = getService(ctx, 'skills')
      if (skills === undefined || typeof skills.list !== 'function') {
        warnOnceLocal(ctx, `${name}: skills service unavailable — skill-catalog config ${config.id} skipped`)
        return null
      }
      const all = await skills.list({
        scope: agent ?? ctx,
        ...(session?.header?.cwd !== undefined ? { cwd: session.header.cwd } : {}),
        ...(agent?.signal !== undefined ? { signal: agent.signal } : {}),
      })
      const visible = Array.isArray(all) ? all : []
      const scoped = providers.length === 0
        ? visible
        : visible.filter((skill) => providers.includes(skill?.provider))
      const total = scoped.length
      if (total === 0) {
        if (emptyBehavior !== 'text' || emptyText.length === 0) return null
        return { text: emptyText, variables: { SKILL_COUNT: '0', SKILL_NAMES: '', SKILLS_TEXT: '' } }
      }

      const nameOf = (skill) => {
        const value = skill?.name
        if (typeof value === 'string' && value.length > 0) return value
        if (typeof skill?.locator === 'string' && skill.locator.length > 0) return skill.locator
        return String(skill?.id ?? unnamedLabel)
      }
      const firstLine = (value) => typeof value === 'string' ? value.split('\n')[0].trim() : ''
      const rows = (limit === undefined || limit === 0 ? scoped : scoped.slice(0, limit)).map((skill) => {
        const parts = []
        if (fields.includes('name')) parts.push(nameOf(skill))
        if (fields.includes('description')) {
          const description = firstLine(skill?.description)
          if (description.length > 0) parts.push(description)
        }
        if (fields.includes('whenToUse')) {
          const whenToUse = firstLine(skill?.whenToUse)
          if (whenToUse.length > 0) parts.push(`${whenToUseLabel}${whenToUse}`)
        }
        return parts.length === 0 ? '' : `- ${parts.join(': ')}`
      }).filter((line) => line.length > 0)
      const skillsText = rows.join('\n')
      const skillsNames = scoped.map((skill) => nameOf(skill)).join(', ')
      return {
        text: template,
        variables: {
          SKILL_COUNT: String(total),
          SKILL_NAMES: skillsNames,
          SKILLS_TEXT: skillsText,
        },
      }
    } catch (error) {
      warnOnceLocal(ctx, `${name}: skill-catalog config ${config.id} failed, skipping: ${String((error && error.message) || error)}`)
      return null
    }
  }
}

function createSoulSelfResolver(config) {
  return ({ ctx, agent, signal }) => {
    const service = getService(ctx, SOUL_SELF_SERVICE)
    if (typeof service?.render !== 'function') throw new Error('SELF dependency missing')
    const text = service.render(config.sourceModuleId, agent, signal)
    return typeof text?.then === 'function' ? text.then(value => ({ text: value })) : { text }
  }
}

/** 动态填充器:strategy=placeholder 时按 fill 键在注入点填充内容。 */
export const FILLERS = {
  'instruction-hint': (config) => createInstructionHintResolver(config),
  'env-facts': (config) => createEnvFactsResolver(config),
  'skill-catalog': (config) => createSkillCatalogResolver(config),
  'tool-catalog': (config) => createToolCatalogResolver(config),
  'soul-self': (config) => createSoulSelfResolver(config),
}

export function createPlaceholderResolver(config) {
  const make = FILLERS[config.fill]
  if (make === undefined) {
    throw new TypeError(`${name}: unknown config fill ${JSON.stringify(config.fill)}`)
  }
  return make(config)
}

export { createInstructionHintResolver }

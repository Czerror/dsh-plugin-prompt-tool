/**
 * fillers — 引擎内置的动态填充器(strategy=placeholder 的数据源)。
 * 全部遵循同一铁律:服务缺失或列表失败时返回 null(跳过该配置),绝不伤及会话。
 */

import { getService, parseToolNames } from './shared.mjs'
import { createInstructionHintResolver } from './instruction-hint.mjs'

const name = 'prompt-config-engine'

/**
 * env-facts:机器事实动态填充器。
 * params.envKeys 逗号分隔环境变量白名单,默认 DSH_HOME,DSH_WORKSPACE;
 * CWD 特殊映射到 session.header.cwd ?? process.cwd()。
 * 返回 facts 变量表与默认文本;用户可用 text 模板 + {{变量}} 完全自定义输出。
 */
function createEnvFactsResolver(config) {
  const keys = parseToolNames(typeof config.params?.envKeys === 'string' && config.params.envKeys.length > 0
    ? config.params.envKeys
    : 'DSH_HOME,DSH_WORKSPACE')
  return ({ agent }) => {
    const session = agent?.session
    const cwd = session?.header?.cwd ?? process.cwd()
    const builtinHome = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : '')
    const facts = {}
    for (const key of keys) {
      let value
      if (key === 'CWD' || key === 'WORKSPACE') value = cwd
      else if (key === 'DSH_HOME') value = builtinHome
      else value = process.env[key]
      if (typeof value === 'string' && value.length > 0) facts[key] = value
    }
    facts.WORKSPACE = process.env.DSH_WORKSPACE ?? cwd
    facts.CWD = cwd
    const defaultText = ['Environment facts:', ...Object.entries(facts).map(([key, value]) => `- ${key}=${value}`)].join('\n')
    return { text: defaultText, variables: facts }
  }
}

/**
 * skill-catalog:技能目录动态填充器。
 * 数据来自宿主 skills 服务(聚合各 provider;本插件 provider 的 list 已按
 * skillSwitches 过滤,因此目录天然只含已启用技能)。服务缺失或列表失败时
 * 跳过本配置并告警一次,绝不伤及会话。
 */
function createSkillCatalogResolver(config) {
  const limit = Number.isSafeInteger(config.params?.limit) && config.params.limit >= 0
    ? config.params.limit
    : 20
  const fields = parseToolNames(typeof config.params?.fields === 'string' ? config.params.fields : 'name,description')
    .filter((field) => ['name', 'description', 'whenToUse'].includes(field))
  const providers = parseToolNames(config.params?.providers)
  const emptyBehavior = config.params?.emptyBehavior === 'text' ? 'text' : 'skip'
  const emptyText = typeof config.params?.emptyText === 'string' && config.params.emptyText.length > 0
    ? config.params.emptyText
    : '当前没有可用技能。'
  let warned = false
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
        if (emptyBehavior !== 'text') return null
        return { text: emptyText, variables: { SKILL_COUNT: '0', SKILL_NAMES: '', SKILLS_TEXT: '' } }
      }

      const nameOf = (skill) => {
        const value = skill?.name
        if (typeof value === 'string' && value.length > 0) return value
        if (typeof skill?.locator === 'string' && skill.locator.length > 0) return skill.locator
        return String(skill?.id ?? '(unnamed)')
      }
      const firstLine = (value) => typeof value === 'string' ? value.split('\n')[0].trim() : ''
      const rows = (limit === 0 ? scoped : scoped.slice(0, limit)).map((skill) => {
        const parts = []
        if (fields.includes('name')) parts.push(nameOf(skill))
        if (fields.includes('description')) {
          const description = firstLine(skill?.description)
          if (description.length > 0) parts.push(description)
        }
        if (fields.includes('whenToUse')) {
          const whenToUse = firstLine(skill?.whenToUse)
          if (whenToUse.length > 0) parts.push(`适用：${whenToUse}`)
        }
        return parts.length === 0 ? '' : `- ${parts.join(': ')}`
      }).filter((line) => line.length > 0)
      const skillsText = rows.join('\n')
      const skillsNames = scoped.map((skill) => nameOf(skill)).join(', ')
      return {
        text: `Available skills (${total}):\n${skillsText}`,
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

/** 动态填充器:strategy=placeholder 时按 fill 键在注入点填充内容。 */
export const FILLERS = {
  'instruction-hint': (config) => createInstructionHintResolver(config),
  'env-facts': (config) => createEnvFactsResolver(config),
  'skill-catalog': (config) => createSkillCatalogResolver(config),
}

export function createPlaceholderResolver(config) {
  const make = FILLERS[config.fill]
  if (make === undefined) {
    throw new TypeError(`${name}: unknown config fill ${JSON.stringify(config.fill)}`)
  }
  return make(config)
}

export { createInstructionHintResolver }

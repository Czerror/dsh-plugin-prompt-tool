/**
 * router-first-turn — prompt-tool 本地附加件（最优组合）。
 *
 * 依据 dsh-router-standard 的 router-bootstrap 组装逻辑：
 *   - 只替换 persona 段，保留计划模式段与其他第三方 section；
 *   - 首轮隐藏 mnemon:* 自动注入段，晋升后恢复（contexts 由 context-gate 清空/恢复）；
 *   - 按主会话模型自动选择 persona：
 *       Pro  → 官方训练原句；
 *       Flash → dsh-router-standard 的 Flash 弱路由人设（build/fix 分类 +
 *               回顾锚 + 收敛锚 + 反跑题锚 + 先深想再产出）；
 *   - 子代理（委托深度 > 0）默认直接放行完整结果，保证 dsh-mnemon 等插件
 *     通过工具白名单要求的 mnemon_* 工具首轮可见；includeSubagents=true 时
 *     子代理与主会话一样走首轮 persona 替换与段隐藏。
 *
 * 工具目录裁剪仍由 tool-bootstrap 负责（首轮 = 真实 Minimal 工具对；晋升后
 * 恢复完整目录或切换 PTC），本模块不触碰 tools，避免两层过滤器冲突。
 */

import { createEpochPromotion } from './compaction-epoch.mjs'
import { isDelegated, isFlashModel, PROMOTE_EVENTS } from './shared.mjs'

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'router-first-turn'

/** 无服务依赖，只监听 system-prompt 组装。 */
export const inject = []

/** 官方 RL 训练原句（保持与 Minimal 预设逐字节一致）。 */
const RL_PERSONA = 'You are a helpful software engineer assistant.'

/** 是否为 persona 段：旧 persona 段由本模块替换。 */
function isPersonaSection(section) {
  if (section === null || typeof section !== 'object') return false
  const name = String(section.name ?? '')
  return name === 'persona' || /persona/i.test(name)
}

/** 首轮需要隐藏的 mnemon 自动注入段（晋升后恢复）。 */
function isMnemonSection(section) {
  if (section === null || typeof section !== 'object') return false
  return String(section.name ?? '').startsWith('mnemon:')
}

/**
 * 引擎级 router-first-turn:所有内容(含快速模型人设 fastModelPersona)都由预设配置参数传入,
 * 本文件不含任何模板专属文本。
 * config: { fastModelPersona: string, hideSectionPrefixes?: string[], includeSubagents?: boolean }
 */
export function apply(ctx, config) {
  const fastModelPersona = typeof config?.fastModelPersona === 'string' && config.fastModelPersona.trim().length > 0
    ? config.fastModelPersona
    : undefined
  if (fastModelPersona === undefined) {
    throw new TypeError(`${name}: config.fastModelPersona must be a non-empty string`)
  }
  const hidePrefixes = Array.isArray(config?.hideSectionPrefixes)
    ? config.hideSectionPrefixes.filter((item) => typeof item === 'string' && item.length > 0)
    : ['mnemon:']
  const includeSubagents = config?.includeSubagents === true

  const promotion = createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: false })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    if (session === undefined) return assembled

    // 子代理默认不裁剪任何 section/context：它与宿主白名单子代理协作；
    // includeSubagents=true 时与主会话同一相位逻辑（首轮替换 + 段隐藏）。
    if (isDelegated(session) && !includeSubagents) return assembled

    const persona = isFlashModel(agent.options?.model) ? fastModelPersona : RL_PERSONA

    const sections = assembled.sections ?? []
    const promoted = promotion.status(agent).promoted
    const kept = sections.filter((section) =>
      !isPersonaSection(section)
      && (promoted || !hidePrefixes.some((prefix) => String(section?.name ?? '').startsWith(prefix))))
    // contexts 由 context-gate 统一清空/恢复，本模块只替换 persona 与隐藏前缀段。
    return { ...assembled, sections: [...kept, { name: 'router-persona', text: persona, order: 0 }] }
  })
}

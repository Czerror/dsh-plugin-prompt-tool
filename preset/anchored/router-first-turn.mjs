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
 *   - 子代理（委托深度 > 0）直接放行完整结果，保证 dsh-mnemon 等插件
 *     通过工具白名单要求的 mnemon_* 工具首轮可见。
 *
 * 工具目录裁剪仍由 tool-bootstrap 负责（首轮 = 真实 Minimal 工具对；晋升后
 * 恢复完整目录或切换 PTC），本模块不触碰 tools，避免两层过滤器冲突。
 */

import { createEpochPromotion } from '../engine/compaction-epoch.mjs'
import { isDelegated, isFlashModel, PROMOTE_EVENTS } from '../engine/shared.mjs'

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'router-first-turn'

/** 无服务依赖，只监听 system-prompt 组装。 */
export const inject = []

/** 官方 RL 训练原句（保持与 Minimal 预设逐字节一致）。 */
const RL_PERSONA = 'You are a helpful software engineer assistant.'

/** dsh-router-standard 的 Flash 弱路由人设（build/fix 分类 + 三锚 + 深想）。 */
const FLASH_PERSONA = [
  'You are a helpful assistant.',
  'Before acting, decide the task type (build or fix) and adopt the matching style: build → hands-on production; fix → inspect-and-plan.',
  'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.',
  'Think deeply first, then produce.',
].join('\n')

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

export function apply(ctx) {
  const promotion = createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: false })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    if (session === undefined) return assembled

    // 子代理不裁剪任何 section/context：它与 dsh-mnemon 的工具白名单协作。
    if (isDelegated(session)) return assembled

    const persona = isFlashModel(agent.options?.model) ? FLASH_PERSONA : RL_PERSONA

    const sections = assembled.sections ?? []
    const promoted = promotion.status(agent).promoted
    const kept = sections.filter((section) => !isPersonaSection(section) && (promoted || !isMnemonSection(section)))
    // contexts 由 context-gate 统一清空/恢复，本模块只替换 persona 与隐藏 mnemon 段。
    return { ...assembled, sections: [...kept, { name: 'router-persona', text: persona, order: 0 }] }
  })
}

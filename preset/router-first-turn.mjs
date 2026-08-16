/**
 * router-first-turn — prompt-tool 本地附加件（最优组合）。
 *
 * 依据 dsh-router-standard 的 router-bootstrap 组装逻辑：
 *   - 只替换 persona 段为官方训练原句，保留计划模式段与其他第三方
 *     section（applyPersona 语义，不是整段丢弃）；
 *   - 首轮隐藏 mnemon:* 自动注入段（记忆路由/热记忆上下文）并清空 contexts，
 *     晋升后两者都恢复——与 anchored-standard 的“首轮剥离自动注入”一致；
 *   - 子代理（委托深度 > 0）直接放行完整结果，保证 dsh-mnemon 等插件
 *     通过工具白名单要求的 mnemon_* 工具首轮可见。
 *
 * 工具目录裁剪仍由上游 tool-bootstrap 负责（首轮 = 真实 Minimal 工具对；
 * 晋升后 = resident 集），本模块不触碰 tools，避免两层过滤器冲突。
 * 计划模式段必须保留：router-standard 早期实测证明整段替换 section 会
 * 丢失 plan 边界，导致模型离开计划模式后重复探索（“失忆”问题）。
 */

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

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    if (session === undefined) return assembled

    // 子代理不裁剪任何 section/context：它与 dsh-mnemon 的工具白名单协作。
    if ((session.header?.delegationDepth ?? 0) > 0) return assembled

    const sections = assembled.sections ?? []
    const promoted = session.events.some((event) => event.type === 'tool/call')
    const kept = sections.filter((section) => !isPersonaSection(section) && (promoted || !isMnemonSection(section)))
    const routerSections = [...kept, { name: 'router-persona', text: RL_PERSONA, order: 0 }]
    return promoted
      ? { ...assembled, sections: routerSections }
      : { ...assembled, sections: routerSections, contexts: [] }
  })
}

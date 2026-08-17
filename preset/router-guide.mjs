/**
 * router-guide — Flash 主会话每轮近距离深度引导（dsh-router-standard 方案）。
 *
 * 只在主会话模型为 Flash、且会话已晋升后启用；每个真实用户消息之后追加一条
 * 固定引导（近距离零衰减，缓存友好）：
 *   - 复杂任务：深度引导（架构/边界/集成点，信息足够就产出，每块以决策或信息缺口收尾）；
 *   - 简单任务：快速收敛引导（分类 + 直接产出）。
 * config.useCustom=true 时 Pro 与 Flash 一样每轮注入：文本未改动默认值时按
 * 任务自动选择 GUIDE_WEAK/GUIDE_DEEP，改动后固定使用 config.text；空文本不注入。
 * false（默认）时自动模式仅 Flash 主会话注入（router 实测 Pro 不需要）。
 * 子代理不注入；首轮不注入（首句锚定由 near-anchor 负责）。
 */

import { createEpochPromotion } from './compaction-epoch.mjs'
import { extractText, isDelegated, isFlashModel, newMessageId, PROMOTE_EVENTS } from './shared.mjs'

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'router-guide'

/** 无服务依赖，只监听 session/event 与 pre-step。 */
export const inject = []

/** 复杂任务判定：长度或架构关键词。 */
const COMPLEX_RE = /(架构|重构|全面|详细|设计|系统|优化|分析|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i

const GUIDE_WEAK = '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.'
const GUIDE_DEEP = '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'

/** 宿主 UI 写入的默认编辑框文本；未改动时等价自动模式。 */
const DEFAULT_GUIDE_TEXT = ['简单任务自动引导：', GUIDE_WEAK.trim(), '', '复杂任务自动引导：', GUIDE_DEEP.trim()].join('\n')



export function apply(ctx, config) {
  const useCustom = config?.useCustom === true
  const customText = typeof config?.text === 'string' ? config.text : ''
  const enabled = config?.enabled !== false
  const unchangedDefault = customText.trim() === DEFAULT_GUIDE_TEXT.trim()

  const promotion = createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: false })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || !enabled) return decision
    if (agent === undefined) return decision
    const session = agent.session
    if (session === undefined) return decision
    // 子代理不注入。
    if (isDelegated(session)) return decision
    // 自动模式只对 Flash 主会话注入；自定义开关打开后，Pro 与 Flash 一样注入。
    const isFlash = isFlashModel(agent.options?.model)
    if (!useCustom && !isFlash) return decision
    // 晋升后才注入（首轮由 near-anchor 负责）。
    if (!promotion.status(agent).promoted) return decision

    const messages = Array.isArray(decision.messages) ? decision.messages : []
    const userIndex = messages.findIndex((message) => message?.source?.kind === 'user')
    if (userIndex < 0) return decision
    // 本轮已注入过则跳过。
    if (messages.some((message) => message?.source?.plugin === 'router-guide')) return decision

    const text = extractText(messages[userIndex])
    if (text.length === 0) return decision
    const guide = (useCustom && !unchangedDefault)
      ? customText.trim()
      : ((text.length > 120 || COMPLEX_RE.test(text)) ? GUIDE_DEEP : GUIDE_WEAK)
    if (guide.length === 0) return decision

    const nextMessages = [...messages]
    nextMessages.splice(userIndex + 1, 0, {
      id: newMessageId('router-guide'),
      role: 'user',
      content: [{ type: 'text', text: guide }],
      source: { kind: 'router-guide', plugin: 'router-guide', form: 'notice', summary: 'router-guide 每轮近距离引导' },
    })
    return { ...decision, messages: nextMessages }
  })
}

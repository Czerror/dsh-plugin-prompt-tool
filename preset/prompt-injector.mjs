/**
 * prompt-injector — prompt-tool 的提示词注入层。
 *
 * 职责：会话晋升（首个 tool/call 或 assistant/message，与 promoteOn: either
 * 同定义）后，turn1 reasoning 以 "we" 开头 → 下一轮注入 promptText 一次；
 * we 未确认 → 最多再等一轮，仍无则强制注入（兜底，绝不卡死）。
 *
 * promptText 由宿主在生成 preset 时写入 config（默认等于 preset.md 原文）。
 * AGENTS.md 的注入走 instruction-hint.mjs，不由本模块拼接。
 *
 * 实测依据：
 *   - 复杂任务 + 原版 2 工具 + maxTokens 1024 → turn1 reasoning "We need"；
 *   - 简单任务模型直接调工具干活（无 we 首词），走兜底注入；
 *   - 锚定消息（"Tools are not open yet"）在 2 工具下不产生 we
 *     （模型回复 "The user says..." 叙述语气），已废弃。
 *
 * 状态全部从持久 session events 推导（resume/reload 安全）：
 *   - promoted：events 含 tool/call 或 assistant/message；
 *   - 已注入：events 含 source.kind=plugin + source.plugin=prompt-injector 的
 *     消息事件（注入消息本身就是持久事件），进程重启/插件重载后据此跳过；
 *   - 内存 Set/Map 只做进程内快路径 memo，不承载跨进程真相。
 *   注入仅一次。
 */

import { createEpochPromotion } from './compaction-epoch.mjs'
import { newMessageId, PROMOTE_EVENTS } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'prompt-injector'

/** No inject list: nothing to resolve, only event listeners. */
export const inject = []

export function apply(ctx, config) {
  const promptText = typeof config.promptText === 'string' && config.promptText.length > 0
    ? config.promptText
    : undefined

  /** Sessions whose promptText has been injected (append-only). */
  const injectedPrompt = new Set()
  /** Sessions whose first assistant reasoning has been scanned (memoized). */
  const weScanned = new Map()
  /** Epoch-aware promotion, same definition as tool-bootstrap/context-gate. */
  const promotion = createEpochPromotion(PROMOTE_EVENTS.either, { includeSubagents: false })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  /**
   * 从持久 session events 推导「是否已经注入过 promptText」。
   * 注入消息本身就是 user/message 持久事件（data 即消息本体），因此跨进程
   * 重启 / 插件热重载后仍能识别；兼容 router-standard 观测到的
   * `data.message` 嵌套形状。内存 Set 只做快路径 memo，真相在事件流。
   */
  const hasInjectedPrompt = (session) =>
    session.events.some((event) => {
      const payload = event.data && typeof event.data.message === 'object' && event.data.message !== null
        ? event.data.message
        : event.data
      const source = payload?.source
      return source?.kind === 'plugin' && source?.plugin === 'prompt-injector'
    })



  /** 第一个 assistant/message（锚定轮）的 reasoning 是否以 "we" 开头。 */
  const isWeAnchored = (agent) => {
    const session = agent.session
    const cached = weScanned.get(session.id)
    if (cached !== undefined) return cached
    const first = session.events.find((event) => event.type === 'assistant/message')
    // 首个 assistant 消息尚未落库时不要缓存 false，等待下一轮再查。
    if (first === undefined) return false
    const content = first.data?.message?.content ?? []
    const reasoning = content.find((block) => block.type === 'reasoning')
    const anchored = reasoning !== undefined && /^we\b/i.test(String(reasoning.text ?? '').trim())
    weScanned.set(session.id, anchored)
    return anchored
  }

  /** 已落库的 assistant 回合数（we 未确认时的兜底轮计数）。 */
  const assistantRounds = (agent) =>
    agent.session.events.filter((event) => event.type === 'assistant/message').length

  // 锚定确认后注入一次 promptText（we 确认立即注入；未确认最多再等一轮）。
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (agent === undefined || promptText === undefined) return decision
    if (!promotion.status(agent).promoted) return decision
    const session = agent.session
    if (session === undefined || injectedPrompt.has(session.id)) return decision
    // 持久事件级幂等：进程重启/插件重载后，已注入消息仍在事件流里，据此跳过。
    if (hasInjectedPrompt(session)) {
      injectedPrompt.add(session.id)
      return decision
    }
    const weOk = isWeAnchored(agent)
    if (!weOk && assistantRounds(agent) <= 1) return decision
    injectedPrompt.add(session.id)
    const message = {
      id: newMessageId('prompt-injector'),
      role: 'user',
      content: [{ type: 'text', text: promptText }],
      source: {
        kind: 'plugin',
        plugin: 'prompt-injector',
        form: 'notice',
        summary: weOk ? 'prompt-tool 提示词（we 锚定确认后注入）' : 'prompt-tool 提示词（we 未确认，兜底注入）',
      },
    }
    return { ...decision, messages: [message, ...decision.messages] }
  })
}

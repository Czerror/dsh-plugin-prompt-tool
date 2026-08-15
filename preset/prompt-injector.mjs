/**
 * prompt-injector — anchored-standard 的附加件（prompt-tool 自研，唯一本地件）。
 *
 * 职责（tools / maxTokens / 上下文剥离全部留给原版 tool-bootstrap）：
 *   会话晋升（首个 tool/call 或 assistant/message，与 promoteOn: either 同定义）后，
 *   turn1 reasoning 以 "we" 开头 → 下一轮注入 promptText 一次；
 *   we 未确认 → 最多再等一轮，仍无则强制注入（兜底，绝不卡死）。
 *
 * 实测依据：
 *   - 复杂任务 + 原版 2 工具 + maxTokens 1024 → turn1 reasoning "We need"；
 *   - 简单任务模型直接调工具干活（无 we 首词），走兜底注入；
 *   - 锚定消息（"Tools are not open yet"）在 2 工具下不产生 we
 *     （模型回复 "The user says..." 叙述语气），已废弃。
 *
 * 状态全部从持久 session events 推导（resume/reload 安全）；注入仅一次。
 */

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
  /** Sessions already promoted in this process (memoized). */
  const promoted = new Set()

  /** 与 tool-bootstrap 的 promoteOn: either 同定义。 */
  const isPromoted = (agent) => {
    if (agent === undefined) return true
    const session = agent.session
    if (session === undefined) return true
    if ((session.header.delegationDepth ?? 0) > 0) return true
    if (promoted.has(session.id)) return true
    const hit = session.events.some((event) => event.type === 'tool/call' || event.type === 'assistant/message')
    if (hit) promoted.add(session.id)
    return hit
  }

  /** 第一个 assistant/message（锚定轮）的 reasoning 是否以 "we" 开头。 */
  const isWeAnchored = (agent) => {
    const session = agent.session
    const first = session.events.find((event) => event.type === 'assistant/message')
    if (first === undefined) return false
    const content = first.data?.message?.content ?? []
    const reasoning = content.find((block) => block.type === 'reasoning')
    return reasoning !== undefined && /^we\b/i.test(String(reasoning.text ?? '').trim())
  }

  /** 已落库的 assistant 回合数（we 未确认时的兜底轮计数）。 */
  const assistantRounds = (agent) =>
    agent.session.events.filter((event) => event.type === 'assistant/message').length

  // 锚定确认后注入一次 promptText（we 确认立即注入；未确认最多再等一轮）。
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (promptText === undefined) return decision
    if (!isPromoted(agent)) return decision
    const session = agent.session
    if (session === undefined || injectedPrompt.has(session.id)) return decision
    const weOk = isWeAnchored(agent)
    if (!weOk && assistantRounds(agent) <= 1) return decision
    injectedPrompt.add(session.id)
    const message = {
      id: crypto.randomUUID(),
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

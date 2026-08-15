/**
 * turn-anchor — prompt-tool 可选附加件：首轮独立锚定轮。
 *
 * 启用后，会话首个真实用户消息不直接发给模型：先把任务原样挪进
 * `agent.inbox` 的 `next-step`（持久事件），首步只发一条 anchorText 作为
 * 独立输入。模型先回应锚定句（实测首词稳定 "We need…"），driver 随后在同
 * 一轮内自动消费 next-step 中的真实任务继续执行——因此用户只发一次消息，
 * 但模型看到的首轮是锚定句。
 *
 * 状态从持久 session events 推导（resume/reload 安全）：
 *   - 已处理/已拆轮：events 含 source.plugin=turn-anchor 的消息，或会话已
 *     晋升（tool/call | assistant/message）；
 *   - 任务在 next-step inbox 中持久化，进程重启后由 driver 继续消费。
 * 失败兜底：inbox.append 抛错时原样返回决策，绝不吞掉用户任务。
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'turn-anchor'

/** No inject list: nothing to resolve, only event listeners. */
export const inject = []

/** 消息 id：优先 crypto.randomUUID，旧运行时回退到随机串。 */
function newMessageId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `turn-anchor-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function apply(ctx, config) {
  const anchorText = typeof config.anchorText === 'string' && config.anchorText.length > 0
    ? config.anchorText
    : undefined
  if (anchorText === undefined) return

  /** Sessions already handled in this process (memo; truth stays in events/inbox). */
  const handled = new Set()

  /** 是否已经拆过轮：锚定句消息是持久 user/message，兼容 data.message 嵌套形状。 */
  const seenAnchor = (session) => session.events.some((event) => {
    const payload = event.data && typeof event.data.message === 'object' && event.data.message !== null
      ? event.data.message
      : event.data
    return payload?.source?.plugin === 'turn-anchor'
  })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (agent === undefined) return decision
    const session = agent.session
    if (session === undefined || handled.has(session.id)) return decision

    const events = session.events
    const promoted = events.some((event) => event.type === 'tool/call' || event.type === 'assistant/message')
    if (promoted || seenAnchor(session)) {
      handled.add(session.id)
      return decision
    }

    // 首步里的真实用户消息（source.kind === 'user'）才是任务；插件消息原样保留。
    const tasks = decision.messages.filter((message) => message?.source?.kind === 'user')
    if (tasks.length === 0) return decision

    // 任务挪进 next-step：driver 在本轮锚定步结束后自动 claim 并继续执行。
    try {
      for (const task of tasks) agent.inbox.append('next-step', task)
    } catch {
      // 入队失败（id 冲突/坏状态）→ 不拆轮，原样发送，绝不丢任务。
      return decision
    }

    handled.add(session.id)
    const anchor = {
      id: newMessageId(),
      role: 'user',
      content: [{ type: 'text', text: anchorText }],
      source: { kind: 'plugin', plugin: 'turn-anchor', form: 'notice', summary: 'turn-anchor 首轮独立锚定句' },
    }
    const kept = decision.messages.filter((message) => message?.source?.kind !== 'user')
    return { ...decision, messages: [anchor, ...kept] }
  })
}

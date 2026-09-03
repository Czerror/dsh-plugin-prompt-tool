/**
 * anchor-turn — 在用户首条真实消息之前播种一个合成锚定轮（前置锚定）。
 *
 * 移植自 upstream dsh-anchored-standard shared/anchor-turn.mjs (MIT)：
 * 锚定消息 PREPEND 进 `next-turn` inbox 队列、排在真实消息之前；dsh 每轮
 * 只 claim 一条 next-turn 消息，所以首条模型请求 = 固定锚定提示（配合
 * 零工具模式时 = 空工具面上的 "we" 锚定），用户真实消息由下一轮 claim——
 * 彼时 bootstrap 已晋升、目录已开放。
 *
 * 与 near-anchor（first-turn-anchor 策略，消息级追加）正交：本模块是轮级
 * 前置（真实消息延后一轮），near-anchor 是首条真实用户消息后的同轮追加。
 *
 * 在首条消息前（而非会话创建时）锚定，保持空白会话的预设切换器可用。
 * 子代理默认跳过（其 brief 即计划）；includeSubagents: true 让子代理也
 * 走锚定轮。
 *
 * Durability 免费：prepend 经 `agent/inbox/spliced` 事件持久化，崩溃后
 * 队列按序恢复；inbox replay 不触发 `inserted` 通知，锚定永不重注入。
 *
 * Robustness：插件来源消息（含自身锚定）永不再次锚定。
 */

import { booleanOption, sessionEvents, validateConfig } from './shared.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchor-turn'

/** 默认锚定文本（合成首轮展示给模型）。 */
export const ANCHOR_TEXT = 'This round is a test. Tools are not open yet; all tools will open next round.'

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['enabled', 'text', 'includeSubagents'])

/** 全新会话（无任何历史 user/message）才锚定。 */
function isFreshSession(agent, includeSubagents = false) {
  if (!includeSubagents && (agent.session.header.delegationDepth ?? 0) > 0) return false
  return !sessionEvents(agent.session).some((event) => event.type === 'user/message')
}

/** 注册首消息锚定注入。 */
export function apply(ctx, config) {
  const source = validateConfig(name, config, ALLOWED_KEYS)
  if (source.enabled === false) return
  const text = typeof source.text === 'string' && source.text.length > 0
    ? source.text
    : ANCHOR_TEXT
  const includeSubagents = booleanOption(name, source.includeSubagents, 'includeSubagents', false)

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent?.session === undefined || agent?.inbox?.prepend === undefined) return
    if (!isFreshSession(agent, includeSubagents)) return
    // 插件来源消息（包括我们自己的锚定）永不再次锚定。
    if (message?.source?.kind === 'plugin') return
    agent.inbox.prepend('next-turn', {
      id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `anchor-turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: name,
        form: 'notice',
        summary: 'zero-tool anchor turn',
      },
    })
  })
}

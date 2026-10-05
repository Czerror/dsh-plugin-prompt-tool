import { labelOf, requireString } from './shared.mjs'
import { newMessageId } from '../shared.mjs'

export function prepareInboxPrepend(action, plugin) {
  const label = labelOf(action)
  const target = action.target ?? 'next-turn'
  if (target !== 'next-turn' && target !== 'next-step') {
    throw new TypeError(`${plugin}: ${label}.target must be "next-turn" or "next-step"`)
  }
  const text = requireString(action.text, `${label}.text`, plugin)
  // 空正文 = 没有可插入的内容（empty 情形）：不注册，而不是插入一条空消息。
  if (text.length === 0) return
  return (_ctx, { warnOnce, on, collect, take }) => collect(on('agent/inbox/inserted', ({ agent, message } = {}) => {
    try {
      // 无 session 的 agent 不锚定（与原 `anchor-turn` 的守卫逐条对齐）：锚定是**会话**
      // 首轮语义，没有会话就没有「首轮」；缺这条会让匿名/临时 agent 也被插一条合成消息
      // （对拍实测：声明路径多插 2 条）。
      if (agent?.session === undefined) return
      if (typeof agent?.inbox?.prepend !== 'function') return
      // v4 起插件来源的 kind 是生产者名（`plugin:<name>`）；两种形态一起认，否则换代后
      // 「插件来源消息永不再次前置」这道防自触发的闸会静默失效。
      if (typeof message?.source?.kind === 'string' && message.source.kind.startsWith('plugin:')) return
      if (message?.source?.kind === 'plugin') return
      if (typeof action.match === 'function' && action.match(agent, message) !== true) return
      if (!take({ agent })) return
      agent.inbox.prepend(target, {
        id: newMessageId(`action-${label}`),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: `plugin:${label}`, plugin: label, form: 'notice', summary: `${label} ${target}` },
      })
    } catch (error) {
      warnOnce(`${plugin}: inbox-prepend action ${label} failed: ${String(error?.message ?? error)}`)
    }
  }))
}

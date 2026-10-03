import { lastAssistantText, subagentTextOf, toolArgsText, userMessagesText } from '../condition.mjs'
import { extractText } from '../shared.mjs'

const CHANNEL_SUBJECTS = {
  'system-prompt/assemble': (args) => ({ agent: args[1]?.agent }),
  'agent/request': (args) => ({ agent: args[0]?.agent }),
  'agent/pre-step': (args) => ({ agent: args[0]?.agent }),
  'agent/inbox/inserted': (args) => ({ agent: args[0]?.agent, source: args[0]?.message?.source }),
  'agent/turn-stopping': (args) => ({ agent: args[0]?.agent }),
  'tools/pre-execute': (args) => ({ agent: args[0]?.agent, name: args[0]?.name }),
  'tools/post-execute': (args) => ({ agent: args[0]?.agent, name: args[0]?.name }),
  'session/event': (args) => ({ session: args[0] }),
  'llm/stream': (args) => ({ model: args[0]?.model }),
  'subagent/start': () => ({}),
  'subagent/end': () => ({}),
}

/** 未知通道的告警去重（每个通道一次；判定期不刷屏）。 */
const warnedChannels = new Set()

/**
 * 归一化载荷的标记（Symbol，非字符串键）：`subjectOf` 产出它，`agentOf`/`sessionOf` 据此
 * 区分「归一化载荷」与「旧形态的直接 payload」——**不用启发式猜**（曾按「有没有 `.session`」
 * 判断，结果把测试里 `{ id, ctx }` 形状的假 agent 误判成归一化载荷）。
 */
const SUBJECT_MARK = Symbol('predicate-subject')

/**
 * 把事件参数表归一为谓词载荷。
 *
 * `args` 传的是**去掉 `next` 之后的参数表**（无 `next` 的 emit/serial 通道原样传）。
 * 未知通道回落到「第一个实参」（= 归一化之前的旧行为）并**告警一次**——不静默丢弃，
 * 否则新增通道会悄悄失去判定能力；也不抛错，判定期抛错会打断会话。
 *
 * @param {string} channel 事件名
 * @param {unknown[]} args 去掉 next 的参数表
 * @param {Function} [warn] 告警回调（缺省静默）
 * @returns {unknown} 谓词载荷
 */
export function subjectOf(channel, args, warn) {
  // 第一个实参的字段**原样保留**在载荷顶层：旧形态（如 `agent/turn-stopping` 的
  // `{ agent, turn }`）因此继续可见，既有断言不会因归一化而失效。
  const first = args[0]
  const base = first !== null && typeof first === 'object' && !Array.isArray(first) ? { ...first } : {}
  const pick = CHANNEL_SUBJECTS[channel]
  const text = (() => {
    switch (channel) {
      case 'tools/pre-execute': return { argsText: toolArgsText(args[0]?.arguments) }
      case 'tools/post-execute': return { argsText: toolArgsText(args[0]?.arguments), resultText: extractText(args[1]) }
      case 'agent/pre-step': return { userText: userMessagesText(args[0]?.messages) }
      case 'agent/inbox/inserted': return { userText: userMessagesText([args[0]?.message]) }
      case 'agent/turn-stopping': return { assistantText: lastAssistantText(args[0]?.agent?.session) }
      case 'subagent/start':
      case 'subagent/end': return { subagentText: subagentTextOf(args[0]) }
      default: return {}
    }
  })()
  if (pick === undefined) {
    if (typeof warn === 'function' && !warnedChannels.has(channel)) {
      warnedChannels.add(channel)
      warn(`predicates: unknown channel ${JSON.stringify(channel)} — 无显式取法，退回「第一个实参即载荷」的旧语义`)
    }
    return { ...base, ...text, [SUBJECT_MARK]: true, channel, args }
  }
  return { ...base, ...pick(args), ...text, [SUBJECT_MARK]: true, channel, args }
}

/**
 * 从载荷取 agent：**归一化载荷**读 `agent`（`subjectOf` 的标记为凭）；**旧形态**
 * （载荷本身就是 agent——手写调用方与既有测试都这样传）原样返回。
 */
export function agentOf(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  return payload[SUBJECT_MARK] === true ? payload.agent : payload
}

/**
 * 从载荷取 session：归一化载荷走 `session` → `agent.session`；旧形态走
 * `session` → 载荷自身。取不到时返回原载荷——`sessionEvents` 对无 `snapshotEvents`
 * 的对象返回空，语义是「无事件」，与归一化之前逐例一致。
 */
export function sessionOf(payload) {
  if (payload === null || typeof payload !== 'object') return payload
  if (payload[SUBJECT_MARK] !== true) return payload.session ?? payload
  return payload.session ?? payload.agent?.session
}

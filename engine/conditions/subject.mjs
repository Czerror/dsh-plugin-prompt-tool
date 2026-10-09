import { SUBJECT_FIELDS, lastAssistantText, subagentTextOf, toolArgsText, userMessagesText } from '../condition.mjs'
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

/**
 * 通道 → 归一化载荷里的**文本**字段与取值器；键名取自 `condition.mjs#SUBJECT_FIELDS`。
 * 这份表同时是「某通道能提供哪些文本 subject」的唯一真相——编译期据此拒绝永不命中的
 * `text` 条件（见 `rule-spec.mjs`）。非文本事实（agent/session/model/provider 名）走
 * `CHANNEL_SUBJECTS`，不进此表。
 */
const CHANNEL_TEXT = {
  'tools/pre-execute': { argsText: (args) => toolArgsText(args[0]?.arguments) },
  'tools/post-execute': { argsText: (args) => toolArgsText(args[0]?.arguments), resultText: (args) => extractText(args[1]) },
  'agent/pre-step': { userText: (args) => userMessagesText(args[0]?.messages) },
  'agent/inbox/inserted': { userText: (args) => userMessagesText([args[0]?.message]) },
  'agent/turn-stopping': { assistantText: (args) => lastAssistantText(args[0]?.agent?.session) },
  'subagent/start': { subagentText: (args) => subagentTextOf(args[0]) },
  'subagent/end': { subagentText: (args) => subagentTextOf(args[0]) },
}

/** 字段名 → subject 反查；键名只在 SUBJECT_FIELDS 声明一次，两表交叉而不重复。 */
const SUBJECT_OF_FIELD = Object.fromEntries(Object.entries(SUBJECT_FIELDS).map(([subject, field]) => [field, subject]))

/**
 * 本通道可用的文本 subject。未列出的通道（`system-prompt/assemble`、`agent/request`、
 * `llm/stream`、`session/event`）不提供任何文本，其上声明的 `text` 条件永不命中。
 * @param {string} channel 官方事件名
 * @returns {string[]} 可用 subject
 */
export function channelTextSubjects(channel) {
  const fields = CHANNEL_TEXT[channel]
  if (fields === undefined) return []
  return Object.keys(fields).map(field => SUBJECT_OF_FIELD[field]).filter(subject => subject !== undefined)
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
 * 子代理事件判定期可见的 agent 事实。
 *
 * 官方 `subagent/start`、`subagent/end` 的载荷只有 `runId/provider/id/local`；
 * `wireSubagentEvents` 是在 handler 里才把 child 挂上 frame 的，而 `ruleMatches`
 * 在 handler **之前**执行。结果是 `scope.modelScope`（availability 要求 model 为非空
 * 字符串）与 `scope.audience`（要求 session 可达）在子代理两层恒判 UNAVAILABLE——UI 上
 * 配了却永远不命中，正是 schema 注释要避免的「配了没效果也不报错」。
 *
 * 这里在**判定前**用事件里的 `id` 反查 agent 补齐同样的事实。取不到时不写键：判定
 * 退回 UNAVAILABLE（fail-closed），不得乐观放行。
 */
function subagentFacts(info, ctx) {
  const facts = {}
  const id = info?.id
  if (typeof id !== 'string' || id.length === 0) return facts
  const agent = ctx?.agents?.get?.(id)
  if (agent === undefined || agent === null) return facts
  facts.agent = agent
  if (agent.session !== undefined) facts.session = agent.session
  const model = agent.options?.model
  if (typeof model === 'string' && model.length > 0) facts.model = model
  return facts
}

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
 * @param {unknown} [ctx] 判定期服务入口（目前只被子代理事件的 agent 反查使用）
 * @returns {unknown} 谓词载荷
 */
export function subjectOf(channel, args, warn, ctx) {
  // 第一个实参的字段**原样保留**在载荷顶层：旧形态（如 `agent/turn-stopping` 的
  // `{ agent, turn }`）因此继续可见，既有断言不会因归一化而失效。
  const first = args[0]
  const base = first !== null && typeof first === 'object' && !Array.isArray(first) ? { ...first } : {}
  const pick = CHANNEL_SUBJECTS[channel]
  const fields = CHANNEL_TEXT[channel]
  const text = fields === undefined ? {} : Object.fromEntries(Object.entries(fields).map(([key, read]) => [key, read(args)]))
  if (channel === 'subagent/start' || channel === 'subagent/end') {
    // 子代理事件的 `name` = provider（`SubagentRunInfo` 里唯一稳定的分类事实：
    // spawn / fork / acp / codex / claude-code / dsh-sdk）。`names` 谓词读的就是
    // `payload.name`，因此 `if: { names: { allow: ['fork'] } }` 在此可用。
    // provider 可能缺席（官方注释：已接受的 one-shot 变 ready 或持久 Activation 冷恢复时
    // 提供方未必仍注册）——那时不写键，让 `names` 走 UNAVAILABLE，而不是塞空串当「已知为空」。
    if (typeof args[0]?.provider === 'string' && args[0].provider.length > 0) text.name = args[0].provider
    Object.assign(text, subagentFacts(args[0], ctx))
  }
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

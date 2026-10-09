import { SUBJECT_FIELDS, lastAssistantText, subagentTextOf, toolArgsText, userMessagesText } from '../condition.mjs'
import { extractText } from '../shared.mjs'

/**
 * 子代理事件判定期可见的 agent 事实。
 *
 * 官方 `subagent/start`、`subagent/end` 的载荷只有 `runId/provider/id/local`；
 * `wireSubagentEvents` 是在 handler 里才把 child 挂上 frame 的，而 `ruleMatches`
 * 在 handler **之前**执行。结果是 `scope.modelScope`（availability 要求 model 为非空
 * 字符串）与 `scope.audience`（要求 session 可达）在子代理两层恒判 UNAVAILABLE——UI 上
 * 配了却永远不命中，正是 schema 注释要避免的「配了没效果也不报错」。
 *
 * 这里在**判定前**用事件里的 `id` 反查 agent 补齐同样的事实。取不到时返回 `undefined`
 * （取值器不写键）：判定退回 UNAVAILABLE（fail-closed），不得乐观放行。
 */
const subagentAgent = (args, ctx) => {
  const id = args[0]?.id
  if (typeof id !== 'string' || id.length === 0) return undefined
  return ctx?.agents?.get?.(id) ?? undefined
}

/**
 * 子代理两层的事实。`name` = provider（`SubagentRunInfo` 里唯一稳定的分类事实：
 * spawn / fork / acp / codex / claude-code / dsh-sdk），`names` 谓词读的就是它，
 * 因此 `names` 在这两层合法（编译期据此放行）。provider 可能缺席（官方注释：已接受的
 * one-shot 变 ready 或持久 Activation 冷恢复时提供方未必仍注册）——那时返回 `undefined`
 * 让取值器不写键、`names` 走 **运行期** UNAVAILABLE，而不是塞空串当「已知为空」，
 * 也不是编译期拒绝。
 */
const SUBAGENT_FACTS = {
  name: (args) => {
    const provider = args[0]?.provider
    return typeof provider === 'string' && provider.length > 0 ? provider : undefined
  },
  agent: subagentAgent,
  session: (args, ctx) => subagentAgent(args, ctx)?.session,
  model: (args, ctx) => {
    const model = subagentAgent(args, ctx)?.options?.model
    return typeof model === 'string' && model.length > 0 ? model : undefined
  },
}

/**
 * 通道 → 归一化载荷的字段与取值器：**唯一**的「该通道提供什么事实」真相。
 * `channelTextSubjects` 与 `channelFactSubjects` 都从这张表派生，不另立第二张手抄表。
 *
 * - `text[字段名] = args => value`：字段名取自 `condition.mjs#SUBJECT_FIELDS`，
 *   经 `SUBJECT_OF_FIELD` 反查成文本 subject。
 * - `facts[字段名] = (args, ctx) => value`：字段名本身即 subject（`name` / `source` /
 *   `agent` / `session` / `model`）；返回 `undefined` 即不写键（判定退回 UNAVAILABLE）。
 */
const CHANNELS = {
  'system-prompt/assemble': { facts: { agent: args => args[1]?.agent } },
  'agent/request': { facts: { agent: args => args[0]?.agent } },
  'agent/pre-step': {
    facts: { agent: args => args[0]?.agent },
    text: { userText: args => userMessagesText(args[0]?.messages) },
  },
  'agent/inbox/inserted': {
    facts: { agent: args => args[0]?.agent, source: args => args[0]?.message?.source },
    text: { userText: args => userMessagesText([args[0]?.message]) },
  },
  'agent/turn-stopping': {
    facts: { agent: args => args[0]?.agent },
    text: { assistantText: args => lastAssistantText(args[0]?.agent?.session) },
  },
  'tools/pre-execute': {
    facts: { agent: args => args[0]?.agent, name: args => args[0]?.name },
    text: { argsText: args => toolArgsText(args[0]?.arguments) },
  },
  'tools/post-execute': {
    facts: { agent: args => args[0]?.agent, name: args => args[0]?.name },
    text: { argsText: args => toolArgsText(args[0]?.arguments), resultText: args => extractText(args[1]) },
  },
  'session/event': { facts: { session: args => args[0] } },
  'llm/stream': { facts: { model: args => args[0]?.model } },
  'subagent/start': { facts: SUBAGENT_FACTS, text: { subagentText: args => subagentTextOf(args[0]) } },
  'subagent/end': { facts: SUBAGENT_FACTS, text: { subagentText: args => subagentTextOf(args[0]) } },
}

/** 字段名 → subject 反查；键名只在 SUBJECT_FIELDS 声明一次，表与名单交叉而不重复。 */
const SUBJECT_OF_FIELD = Object.fromEntries(Object.entries(SUBJECT_FIELDS).map(([subject, field]) => [field, subject]))

/**
 * 事实谓词 → 它读取的事实 subject：校验面与运行面的**唯一**登记处——新谓词还要在
 * `PREDICATE_FACTORIES` 与通道可用性表登记，但「谓词 → subject」只此一处，
 * `rule-spec.mjs#conditionSubjects` 直接消费本对象、`FACT_SUBJECTS` 也由它派生。
 * ponytail: 漂移断言靠运行时改写本对象；将来若 `Object.freeze`，需把判据换成「同一引用」。
 */
export const FACT_PREDICATE_SUBJECTS = { names: 'name', source: 'source' }

/** 谓词能消费的事实 subject：`names` 读 `name`、`source` 读 `source`；agent/session/model 不是谓词 subject。 */
const FACT_SUBJECTS = Object.values(FACT_PREDICATE_SUBJECTS)

/**
 * 本通道可用的文本 subject。未列出的通道（`system-prompt/assemble`、`agent/request`、
 * `llm/stream`、`session/event`）不提供任何文本，其上声明的 `text` 条件永不命中。
 * @param {string} channel 官方事件名
 * @returns {string[]} 可用 subject
 */
export function channelTextSubjects(channel) {
  const fields = CHANNELS[channel]?.text
  if (fields === undefined) return []
  return Object.keys(fields).map(field => SUBJECT_OF_FIELD[field]).filter(subject => subject !== undefined)
}

/**
 * 本通道可用的事实 subject（`name` / `source` 中它具备的那些）——编译期据此拒绝
 * `names` / `source` 的死条件（见 `rule-spec.mjs`）。
 * @param {string} channel 官方事件名
 * @returns {string[]} 可用 subject
 */
export function channelFactSubjects(channel) {
  const facts = CHANNELS[channel]?.facts
  if (facts === undefined) return []
  return FACT_SUBJECTS.filter(subject => Object.hasOwn(facts, subject))
}

/** 按表取字段：`undefined` 不写键——判定据此退回 UNAVAILABLE，而不是把「取不到」当成「已知为空」。 */
function pickFields(readers, args, ctx) {
  const out = {}
  for (const [field, read] of Object.entries(readers ?? {})) {
    const value = read(args, ctx)
    if (value !== undefined) out[field] = value
  }
  return out
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
 * @param {unknown} [ctx] 判定期服务入口（目前只被子代理事件的 agent 反查使用）
 * @returns {unknown} 谓词载荷
 */
export function subjectOf(channel, args, warn, ctx) {
  // 第一个实参的字段**原样保留**在载荷顶层：旧形态（如 `agent/turn-stopping` 的
  // `{ agent, turn }`）因此继续可见，既有断言不会因归一化而失效。
  const first = args[0]
  const base = first !== null && typeof first === 'object' && !Array.isArray(first) ? { ...first } : {}
  const spec = CHANNELS[channel]
  if (spec === undefined) {
    if (typeof warn === 'function' && !warnedChannels.has(channel)) {
      warnedChannels.add(channel)
      warn(`predicates: unknown channel ${JSON.stringify(channel)} — 无显式取法，退回「第一个实参即载荷」的旧语义`)
    }
    return { ...base, [SUBJECT_MARK]: true, channel, args }
  }
  return {
    ...base,
    ...pickFields(spec.facts, args, ctx),
    ...pickFields(spec.text, args, ctx),
    [SUBJECT_MARK]: true,
    channel,
    args,
  }
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

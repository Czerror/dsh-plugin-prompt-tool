/**
 * predicates — 判断原语库（B3/T1）：`判断 → 执行` 的前半身。
 *
 * 统一接口：`predicate(payload) → boolean`。判定**只读、无副作用、判定期不做 IO**；
 * 配置错误（空键集合、非法 logic、非法正则、非法取值）一律在**挂载期** fail loud，
 * 运行期取不到数据只按「不命中」降级，绝不抛出——静默失效比拒绝挂载更难发现。
 * 每个谓词函数带 `kind` 标签（诊断层按类别输出，不打印正文）。
 *
 * 七类原语与它们包装的既有实现（B1–B6 零行为变更：同一输入下判定逐例一致）：
 *
 *   | 类别     | 工厂                        | 包装的既有实现                                   |
 *   |----------|-----------------------------|--------------------------------------------------|
 *   | 文本     | createTextPredicate         | anchor-match.mjs（字/词/句、any/all/not/notAny、整词、正则） |
 *   | 相位     | createPhasePredicate        | compaction-epoch.mjs（epoch 边界 + 两种复位语义） |
 *   | 来源     | createSourcePredicate       | context-gate / executor 的 source.kind / source.plugin 比较 |
 *   | 计数     | createCountPredicate        | deliberation-gate / progress-reminder 的计数（冷扫重建） |
 *   | 名单     | createNameListPredicate     | tool-filter 的 nameSet + allow/deny 语义          |
 *   | 会话状态 | createSessionStatePredicate | anchor-turn 的 isFreshSession                    |
 *   | 当前预设 | createPresetPredicate       | 官方 agent-presets 的 composedPreset / standingMountFor |
 *
 * 组合：`composite({ any | all | not | notAny })`，短路求值；运算符词汇与
 * anchor-match 的 `MATCH_LOGIC` 同源，但**语义不同**：组合层的 `not` 是标准取反，
 * anchor-match 的 `NOT` 是「主键命中且副键全部未命中」的二集语义，两者不可混用。
 */

import { MATCH_LOGIC, createAnchorMatcher } from './anchor-match.mjs'
import { createEpochPromotion } from './compaction-epoch.mjs'
import { subjectTextOf } from './condition.mjs'
import { importHostPackage } from './host-package.mjs'
import {
  MAX_TRACKED_SESSIONS,
  extractText,
  getService,
  parsePromoteOn,
  sessionEvents,
} from './shared.mjs'

/** 组合运算符词汇（与 anchor-match 的 logic 同源，避免两处各记一套）。 */
const COMPOSITE_OPERATORS = Object.values(MATCH_LOGIC)

/** 文本匹配的布尔开关（与 schema.mjs 的 match 归一化同一套字段）。 */
const MATCH_FLAGS = ['caseSensitive', 'wholeWords', 'useRegex', 'stWords']

/** 文本匹配模式（anchor-match 支持的两档）。 */
const MATCH_MODES = ['scan', 'prefix']

/** 可选布尔：缺省返回 fallback；显式非布尔一律 fail loud。 */
function optionalBoolean(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`predicates: ${field} must be a boolean`)
  return value
}

/** 键集合归一化：非字符串数组 / 非数组一律 fail loud；空白键丢弃。 */
function keyList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`predicates: ${field} must be an array of strings when present`)
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0)
}

/** 名称集合：与 tool-filter 的 nameSet 同严格度（空串不是合法名称）。 */
function nameList(value, field) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`predicates: ${field} must be an array of non-empty strings`)
  }
  return [...new Set(value)]
}

/** 计数上下限：缺省 = 不设该侧；非安全非负整数一律 fail loud。 */
function boundOf(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`predicates: count ${field} must be an integer >= 0`)
  }
  return value
}

/**
 * 文本锚定判断（包装 anchor-match）。
 *
 * 判定对象：`payload` 为字符串时直接匹配；否则按 `subject` 从载荷取文本
 * （复用 condition.mjs 的 subjectTextOf，取不到即空串 = 不命中）。
 * 空键集合、非法 logic、非法正则、非法模式都在**构造期**抛错——运行时静默
 * 不命中会让「配了锚定却没生效」变成不可见的失效。
 *
 * @param {object} options
 * @param {string[]} [options.keys] 主键
 * @param {string[]} [options.secondaryKeys] 副键
 * @param {'any'|'all'|'not'|'notAny'} [options.logic] 组合逻辑（缺省 any）
 * @param {boolean} [options.caseSensitive]
 * @param {boolean} [options.wholeWords]
 * @param {boolean} [options.useRegex] 三态：true=强制正则 / false=强制字面 / 缺省=ST 自动检测
 * @param {boolean} [options.stWords] ST 整词规则（仅 ST 导入开启）
 * @param {'scan'|'prefix'} [options.mode]
 * @param {string} [options.subject] 从对象载荷取文本的字段名（condition.mjs 的 subject 词汇）
 * @returns {(payload: unknown) => boolean}
 */
export function createTextPredicate(options = {}) {
  const keys = keyList(options.keys, 'keys')
  const secondaryKeys = keyList(options.secondaryKeys, 'secondaryKeys')
  if (keys.length === 0 && secondaryKeys.length === 0) {
    throw new TypeError('predicates: a text predicate needs at least one non-empty key')
  }
  const logic = options.logic ?? MATCH_LOGIC.ANY
  if (!Object.values(MATCH_LOGIC).includes(logic)) {
    throw new TypeError(`predicates: logic must be one of ${Object.values(MATCH_LOGIC).join(', ')}`)
  }
  const mode = options.mode ?? 'scan'
  if (!MATCH_MODES.includes(mode)) {
    throw new TypeError(`predicates: mode must be one of ${MATCH_MODES.join(', ')}`)
  }
  for (const field of MATCH_FLAGS) {
    if (options[field] !== undefined && typeof options[field] !== 'boolean') {
      throw new TypeError(`predicates: ${field} must be a boolean when present`)
    }
  }
  // 与 anchor-match 逐例等价的关键：匹配器就是 anchor-match 的匹配器，本层不加也不减语义。
  const matcher = createAnchorMatcher({
    keys,
    secondaryKeys,
    caseSensitive: options.caseSensitive === true,
    wholeWords: options.wholeWords === true,
    useRegex: options.useRegex,
    logic,
    mode,
    stWords: options.stWords === true,
  })
  const subject = options.subject
  const predicate = (payload) => matcher.scan(
    typeof payload === 'string' ? payload : subjectTextOf(subject, payload),
  ).active === true
  predicate.kind = 'text'
  return predicate
}

/**
 * 相位判断（包装 compaction-epoch 的 epoch 感知晋升机）。
 *
 * 两种复位语义都从这里表达，差别只在**谁负责记忆**：
 *  - `subscribe: true`（缺省，等价于 tool-bootstrap / context-gate 的现状）：
 *    调用方把 `session/event` 喂给 `predicate.observe`，成功 `compaction/end`
 *    在喂入时复位；判定读的是喂入维护的状态。
 *  - `subscribe: false`（不订阅）：判定自己每次从 durable log 冷扫重建，
 *    所以日志里新增的压缩边界**无需任何通知**就改变结果——适合一次性判定，
 *    代价是每次判定 O(事件数)（ponytail: 不订阅即每次冷扫，需要热路径时改用订阅）。
 *
 * 相位语义本身（谁算晋升、子代理默认已晋升、非法 promoteOn fail loud）全部沿用
 * 现有实现，本层只做包装。
 *
 * @param {object} options
 * @param {'either'|'tool-call'|'assistant-message'} [options.promoteOn]
 * @param {string[]} [options.promoteEvents] 显式事件集合（优先于 promoteOn）
 * @param {boolean} [options.includeSubagents]
 * @param {boolean} [options.promoteGate]
 * @param {boolean} [options.promoteAfterFirstResponse]
 * @param {number} [options.maxPromoteSteps]
 * @param {boolean} [options.subscribe] 缺省 true
 * @returns {((agent: unknown) => boolean) & { kind: string, observe?: Function }}
 */
export function createPhasePredicate(options = {}) {
  const promoteEvents = options.promoteEvents ?? parsePromoteOn('predicates', options.promoteOn)
  if (!Array.isArray(promoteEvents) || promoteEvents.some((type) => typeof type !== 'string')) {
    throw new TypeError('predicates: promoteEvents must be an array of event type strings')
  }
  const subscribe = optionalBoolean(options.subscribe, 'subscribe', true)
  const trackerOptions = {
    includeSubagents: options.includeSubagents === true,
    promoteGate: options.promoteGate === true,
    promoteAfterFirstResponse: options.promoteAfterFirstResponse === true,
    maxPromoteSteps: options.maxPromoteSteps,
  }
  const tracker = createEpochPromotion(promoteEvents, trackerOptions)
  const predicate = (agent) => (subscribe ? tracker : createEpochPromotion(promoteEvents, trackerOptions))
    .status(agent).promoted === true
  predicate.kind = 'phase'
  // 只有订阅模式才有增量入口：不订阅时多一个入口只会诱使调用方以为状态被记住了。
  if (subscribe) predicate.observe = (session, event) => tracker.observe(session, event)
  return predicate
}

/** 来源通道取值归一化：未声明 = 该通道不参与判定；空集合在挂载期抛错（"恒不命中"是配置错误）。 */
function sourceChannel(value, field) {
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.length > 0) return [value]
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0)) {
    return [...new Set(value)]
  }
  throw new TypeError(`predicates: ${field} must be a non-empty string or an array of non-empty strings`)
}

/**
 * 来源判断：`source.kind` / `source.plugin` 的比较（context-gate 的 allowKinds 一族
 * 与 executor 的双通道去重都是这套比较）。
 *
 *  - **精确**（缺省）为 `===` 语义，且**大小写敏感**——现有四处调用
 *    （context-gate / executor / anchor-turn / instruction-hint）全是精确且区分大小写，
 *    统一不得放宽；大小写不敏感必须显式 `caseSensitive: false`。
 *  - **前缀**仅在 `match: 'prefix'` 时启用。
 *  - 声明了多个通道时是**合取**（都命中才算命中）；需要析取用
 *    `composite({ any: [source({kind}), source({plugin})] })`——不隐式二选一。
 *
 * @param {object} options
 * @param {string|string[]} [options.kind]
 * @param {string|string[]} [options.plugin]
 * @param {boolean} [options.caseSensitive] 缺省 true
 * @param {'exact'|'prefix'} [options.match] 缺省 exact
 * @returns {(payload: unknown) => boolean}
 */
export function createSourcePredicate(options = {}) {
  const kinds = sourceChannel(options.kind, 'kind')
  const plugins = sourceChannel(options.plugin, 'plugin')
  if (kinds === undefined && plugins === undefined) {
    throw new TypeError('predicates: a source predicate needs kind or plugin')
  }
  const caseSensitive = optionalBoolean(options.caseSensitive, 'caseSensitive', true)
  const match = options.match ?? 'exact'
  if (match !== 'exact' && match !== 'prefix') {
    throw new TypeError('predicates: source match must be "exact" or "prefix"')
  }
  const normalize = (value) => (caseSensitive ? value : value.toLowerCase())
  const asSet = (list) => (list === undefined ? undefined : new Set(list.map(normalize)))
  const kindSet = asSet(kinds)
  const pluginSet = asSet(plugins)
  const channelHit = (value, allowed) => {
    if (allowed === undefined) return true
    if (typeof value !== 'string' || value.length === 0) return false
    const normalized = normalize(value)
    if (match === 'exact') return allowed.has(normalized)
    for (const prefix of allowed) {
      if (normalized.startsWith(prefix)) return true
    }
    return false
  }
  const predicate = (payload) => {
    const source = payload?.source
    return channelHit(source?.kind, kindSet) && channelHit(source?.plugin, pluginSet)
  }
  predicate.kind = 'source'
  return predicate
}

/**
 * 计数信号词汇：语义相近但不相同的判断归入同一类，靠参数区分。
 * `chars` 只计 `extractText(event.data).length`（与 deliberation-gate 的深度代理
 * 逐字相同：只读 message.content，不读同一事件的 stream delta，避免双计）。
 */
const COUNT_SIGNALS = {
  'tool-call': { type: 'tool/call', measure: 'count' },
  'tool-result': { type: 'tool/result', measure: 'count' },
  'assistant-message': { type: 'assistant/message', measure: 'count' },
  'assistant-chars': { type: 'assistant/message', measure: 'chars' },
  'user-message': { type: 'user/message', measure: 'count' },
  turn: { type: 'turn/start', measure: 'count' },
}

/** 每会话最多保留的轮次计数（与 deliberation-gate 的 MAX_TRACKED_TURNS 同策略）。 */
const MAX_TRACKED_TURNS = 8

/** 轮边界事件：`per: 'turn'` 的当前轮由它与计数信号自身的轮号共同推进。 */
const TURN_EVENT = 'turn/start'

/**
 * 计数判断：次数 / 字符数 / 轮次，带上下限与**冷启动重建**。
 *
 *  - `per: 'session'` 计整个 durable log；`per: 'turn'` 只计**最新轮**，当前轮由
 *    `turn/start` 与计数信号自身带轮号的事件共同推进（与 deliberation-gate 的
 *    `turnOf` 同规则），轮号取自 `event.data.turn`；无轮号的事件不参与轮内计数
 *    （宁可少计，也不把跨轮数据算进当前轮）。
 *  - 冷启动：首次判定冷扫 `sessionEvents(session)` 重建（重启/恢复/重挂后同一结果），
 *    之后 O(1)；`observe` 是增量喂入，**只喂已判定过的会话**，避免「冷扫 + 增量」重复计数。
 *  - 上下限：`count >= min`（声明时）且 `count <= max`（声明时）。至少要声明一侧，
 *    否则该判定恒真——那是把配置错误伪装成命中。
 *  - 取不到会话 = 无事件 = 计数 0（与空会话同一语义，不发明数据）；无 `id` 的会话
 *    不记账（共享一个 Map 键会让两个会话串味），每次冷扫。
 *
 * @param {object} options
 * @param {'tool-call'|'tool-result'|'assistant-message'|'assistant-chars'|'user-message'|'turn'} options.of
 * @param {'session'|'turn'} [options.per] 缺省 session
 * @param {number} [options.min]
 * @param {number} [options.max]
 * @returns {((payload: unknown) => boolean) & { kind: string, observe: Function }}
 */
export function createCountPredicate(options = {}) {
  const signal = COUNT_SIGNALS[options.of]
  if (signal === undefined) {
    throw new TypeError(`predicates: count of must be one of ${Object.keys(COUNT_SIGNALS).join(', ')}`)
  }
  const per = options.per ?? 'session'
  if (per !== 'session' && per !== 'turn') {
    throw new TypeError('predicates: count per must be "session" or "turn"')
  }
  const min = boundOf(options.min, 'min')
  const max = boundOf(options.max, 'max')
  if (min === undefined && max === undefined) {
    throw new TypeError('predicates: a count predicate needs min or max')
  }
  /** sessionId -> { total, turns, lastTurn }（进程内快路径，真相在 durable 事件流）。 */
  const state = new Map()
  const fresh = () => ({ total: 0, turns: new Map(), lastTurn: undefined })
  const measure = (event) => (signal.measure === 'chars' ? extractText(event.data).length : 1)
  /** 轮号推进：与 deliberation-gate 的 turnOf/turnEntryOf 同规则——`turn/start` 与
   *  计数信号自身带轮号的事件都推进当前轮，且取最大值；新轮先落 0，再累加。 */
  const trackTurn = (entry, turn) => {
    if (!entry.turns.has(turn)) {
      if (entry.turns.size >= MAX_TRACKED_TURNS) {
        const oldest = [...entry.turns.keys()]
          .sort((left, right) => left - right)
          .slice(0, entry.turns.size - MAX_TRACKED_TURNS + 1)
        for (const key of oldest) entry.turns.delete(key)
      }
      entry.turns.set(turn, 0)
    }
    if (entry.lastTurn === undefined || turn > entry.lastTurn) entry.lastTurn = turn
  }
  const applyEvent = (entry, event) => {
    const type = event?.type
    const turn = event?.data?.turn
    const tagged = typeof turn === 'number' && Number.isFinite(turn)
    if (per === 'turn' && tagged && (type === TURN_EVENT || type === signal.type)) trackTurn(entry, turn)
    if (type !== signal.type) return entry
    const amount = measure(event)
    if (per === 'session') {
      entry.total += amount
      return entry
    }
    // 轮内计数只认带轮号的事件（与 deliberation-gate 一致：宁可少计，也不把跨轮数据算进当前轮）。
    if (!tagged) return entry
    entry.turns.set(turn, (entry.turns.get(turn) ?? 0) + amount)
    return entry
  }
  const countOf = (entry) => (per === 'session'
    ? entry.total
    : (entry.lastTurn === undefined ? 0 : entry.turns.get(entry.lastTurn) ?? 0))
  const rebuild = (session) => {
    const entry = fresh()
    for (const event of sessionEvents(session)) applyEvent(entry, event)
    return entry
  }
  const entryOf = (session) => {
    if (session?.id === undefined) return rebuild(session)
    const known = state.get(session.id)
    if (known !== undefined) return known
    const entry = rebuild(session)
    if (state.size >= MAX_TRACKED_SESSIONS) state.clear()
    state.set(session.id, entry)
    return entry
  }
  const predicate = (payload) => {
    const count = countOf(entryOf(payload?.session ?? payload))
    return (min === undefined || count >= min) && (max === undefined || count <= max)
  }
  predicate.kind = 'count'
  predicate.observe = (session, event) => {
    const entry = session?.id === undefined ? undefined : state.get(session.id)
    if (entry !== undefined) applyEvent(entry, event)
  }
  return predicate
}

/**
 * 名单判断：名称集合的 allow / deny（tool-filter 的 applyMask 语义逐条保留）。
 *
 *  - deny 命中即不通过；`allow` 已声明时不在其中也不通过；
 *  - **两侧都未声明 = 不过滤**（恒通过），与「两个列表都空 = 零开销不干预」一致；
 *  - 显式空数组是**已声明**：`allow: []` 一个都不通过，`deny: []` 一个都不拦；
 *  - 空名 / 非字符串名一律通过（动作侧对无名项的策略，保持 tool-filter 原样）；
 *  - 大小写缺省敏感；不敏感必须显式声明（构造期统一小写，不在判定里做转换）。
 *
 * @param {object} options
 * @param {string[]} [options.allow]
 * @param {string[]} [options.deny]
 * @param {boolean} [options.caseSensitive] 缺省 true
 * @returns {(payload: unknown) => boolean}
 */
export function createNameListPredicate(options = {}) {
  const allow = nameList(options.allow, 'allow')
  const deny = nameList(options.deny, 'deny')
  const caseSensitive = optionalBoolean(options.caseSensitive, 'caseSensitive', true)
  const normalize = (name) => (caseSensitive ? name : name.toLowerCase())
  const allowSet = allow === undefined ? undefined : new Set(allow.map(normalize))
  const denySet = deny === undefined ? undefined : new Set(deny.map(normalize))
  const predicate = (payload) => {
    const name = typeof payload === 'string' ? payload : payload?.name
    if (typeof name !== 'string' || name.length === 0) return true
    const value = normalize(name)
    if (denySet !== undefined && denySet.has(value)) return false
    if (allowSet !== undefined && !allowSet.has(value)) return false
    return true
  }
  predicate.kind = 'names'
  return predicate
}

/**
 * 会话状态判断：某类 durable 事件在会话内是否出现过。
 *
 * 无状态：每次判定直接读 durable log 快照（与 anchor-turn 的 isFreshSession 同一读法，
 * 逐例等价），因此重挂、恢复、压缩都不会给出过期答案。
 * 缺省 `present: false` = 「尚无」，即 `createSessionStatePredicate({ type: 'user/message' })`
 * 表达「会话内无 user/message」。
 *
 * @param {object} options
 * @param {string} options.type 事件类型（如 'user/message'）
 * @param {boolean} [options.present] 缺省 false
 * @returns {(payload: unknown) => boolean}
 */
export function createSessionStatePredicate(options = {}) {
  const type = options.type
  if (typeof type !== 'string' || type.length === 0) {
    throw new TypeError('predicates: a session-state predicate needs an event type')
  }
  const present = optionalBoolean(options.present, 'present', false)
  const predicate = (payload) => sessionEvents(payload?.session ?? payload)
    .some((event) => event?.type === type) === present
  predicate.kind = 'session'
  return predicate
}

/** 官方 agent-presets 包：`standingMountFor` 就是服务方法 `composedPreset` 的实现本体。 */
const AGENT_PRESETS_PACKAGE = '@deepseek-ai/dsh-agent-presets'

/**
 * 当前预设 id（进程内判定；官方唯一正确取法）。
 *
 *     const id = ctx.get?.('agentPresets')?.composedPreset?.(agent.ctx)   // 首选
 *       ?? standingMountFor(agent.ctx)?.presetId                          // 服务未就绪时的同源兜底
 *
 * 依据（官方源码，非转述）：
 *  - `agent-presets/src/index.ts:504-505`：`composedPreset(agentCtx) { return standingMountFor(agentCtx)?.presetId }`
 *    ——服务方法就是模块导出的包装，**同源不是两个来源**；
 *  - `agent-presets/src/invariant.ts:48,61-64`：内核自己就用 `composedPreset(agent.ctx) === undefined`
 *    判「这个 agent 有没有 join 预设」；
 *  - `agent-presets/src/mount.ts:243-248`：`standingMountFor` 读的是 **live scope chain**
 *    （`scopeParentOf(scopeOf(agentCtx))` 匹配 standing key），不依赖事件落盘。
 *
 * 三条硬约束（改这里之前先读 PLAN 的「审查结论」）：
 *  1. **禁止读 `session.header.agentPreset`**——它是出生预设。官方 `agent-presets/src/session.ts`
 *     明写「Reconstruction reads the `agentPreset` Session projection, never the header alone」，
 *     投影初值取自 header、之后由 `agent-preset/selected` 推进；真机实测亦有 header 与
 *     实际挂载不一致的案例。
 *  2. **禁止用 `agent-presets.default`**（宿主 settings 的 default）当当前预设——它是
 *     **新会话的默认值**，与任何已存在 agent 的挂载无关。
 *  3. **`undefined` 的含义是「该 agent 没有预设」**（裸 agent），不是「取不到」；
 *     **不得回退到默认值**，调用方按「不干预 / 不命中」处理。
 *
 * 适用边界：`composedPreset` 只在**进程内、拿得到 `agent.ctx`** 时可用（装配期
 * `context.agent.ctx`、子代理认领、引擎能力）。跨 API/客户端边界没有这个方法——
 * 官方 `ctx.remote.agentPresets` 只暴露 `list / read / copy / deletePreset / select`，
 * 客户端拿不到 `agent.ctx` 也无法用本方法。**两种取法是分工而非替代**：
 * 进程内判定用本函数，跨边界用会话投影（`sessionProjections.stateOf(session, 'agentPreset')`）。
 *
 * @param {object|undefined} ctx 插件/运行时 ctx（服务查询基准）
 * @param {{ctx?: unknown}|undefined} agent 判定对象（读它的 `ctx` = agent scope context）
 * @param {Function} [standingMountFor] 官方模块导出兜底（服务未就绪时用）
 * @returns {string|undefined} 预设 id；`undefined` = 该 agent 没有预设
 */
export function agentPresetId(ctx, agent, standingMountFor) {
  try {
    const service = getService(ctx, 'agentPresets')
    const composed = typeof service?.composedPreset === 'function'
      ? service.composedPreset(agent?.ctx)
      : undefined
    if (composed !== undefined && composed !== null) return composed
    const mount = typeof standingMountFor === 'function' ? standingMountFor(agent?.ctx) : undefined
    return mount?.presetId
  } catch {
    // 判定不抛出：拿不到就是「没有预设」（不命中），与 condition.mjs 的降级纪律一致。
    return undefined
  }
}

/**
 * 惰性解析官方 `standingMountFor`（挂载期一次，判定期零 IO）。
 * 官方包缺席（最小组合、测试环境）＝没有兜底，不是错误：此时服务缺席即判定恒 undefined。
 * @param {string} [entry] 解析基准（缺省按宿主入口解析；测试/嵌入可显式指定）
 * @returns {Promise<Function|undefined>}
 */
export async function loadStandingMountFor(entry) {
  try {
    const module = await importHostPackage(AGENT_PRESETS_PACKAGE, entry)
    return typeof module?.standingMountFor === 'function' ? module.standingMountFor : undefined
  } catch {
    return undefined
  }
}

/**
 * 当前预设判断：`agentPresetId(...) === presetId`。
 *
 * `ctx` 在**构造期**绑定（服务查询基准，通常是触发器运行时的插件 ctx）；
 * 判定只读 payload（agent）。服务与兜底都取不到时恒不命中——**不回落默认值**。
 *
 * @param {object} options
 * @param {string} options.presetId 目标预设 id
 * @param {object} [options.ctx] 插件/运行时 ctx
 * @param {Function} [options.standingMountFor] 官方模块导出兜底
 * @returns {(agent: unknown) => boolean}
 */
export function createPresetPredicate(options = {}) {
  const presetId = options.presetId
  if (typeof presetId !== 'string' || presetId.length === 0) {
    throw new TypeError('predicates: a preset predicate needs a presetId')
  }
  const ctx = options.ctx
  const standingMountFor = options.standingMountFor
  const predicate = (agent) => agentPresetId(ctx, agent, standingMountFor) === presetId
  predicate.kind = 'preset'
  return predicate
}

/**
 * 组合判断（短路求值）：`{ any: [...] }` / `{ all: [...] }` / `{ not: p }` / `{ notAny: [...] }`。
 *
 *  - 一个节点**只能声明一个运算符**：混合声明（如同时给 all 与 not）在挂载期抛错。
 *    优先级因此永远是显式的树形嵌套，而不是靠"先算 not 再算 and"的隐式约定。
 *  - 短路：`any` 首个命中即返回 true；`all` 首个未命中即返回 false；`notAny` 首个命中即返回 false。
 *  - 数组必须非空、子节点必须是谓词函数；空数组在挂载期抛错（"恒真/恒假"是配置错误，不是命中）。
 *
 * @param {Function|object} node 谓词函数，或 `{ any|all|not|notAny }` 组合节点
 * @returns {Function} 谓词函数
 */
export function composite(node) {
  if (typeof node === 'function') return node
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError(`predicates: a composite must be a predicate or { ${COMPOSITE_OPERATORS.join(' | ')} }`)
  }
  const unknown = Object.keys(node).filter((key) => !COMPOSITE_OPERATORS.includes(key))
  if (unknown.length > 0) {
    throw new TypeError(`predicates: unknown composite key(s) ${unknown.join(', ')} — allowed: ${COMPOSITE_OPERATORS.join(', ')}`)
  }
  const declared = COMPOSITE_OPERATORS.filter((key) => node[key] !== undefined)
  if (declared.length !== 1) {
    throw new TypeError(`predicates: a composite node must declare exactly one of ${COMPOSITE_OPERATORS.join(', ')}`)
  }
  const operator = declared[0]
  if (operator === MATCH_LOGIC.NOT) {
    const child = composite(node[operator])
    const predicate = (payload) => !child(payload)
    predicate.kind = 'composite'
    return predicate
  }
  const list = node[operator]
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError(`predicates: composite ${operator} needs a non-empty array of predicates`)
  }
  const children = list.map(composite)
  const predicates = {
    [MATCH_LOGIC.ANY]: (payload) => {
      for (const child of children) {
        if (child(payload)) return true
      }
      return false
    },
    [MATCH_LOGIC.ALL]: (payload) => {
      for (const child of children) {
        if (!child(payload)) return false
      }
      return true
    },
    [MATCH_LOGIC.NOT_ANY]: (payload) => {
      for (const child of children) {
        if (child(payload)) return false
      }
      return true
    },
  }
  const predicate = predicates[operator]
  if (predicate === undefined) {
    throw new TypeError(`predicates: composite ${operator} is not a supported operator`)
  }
  predicate.kind = 'composite'
  return predicate
}

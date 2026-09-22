/**
 * shared — small utilities shared by the prompt-tool preset scripts.
 * Not a plugin row: no name/inject exports and no listeners.
 */

/** Durable session event types that count as a promotion signal per mode. */
export const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Parse the shared promoteOn vocabulary. */
export function parsePromoteOn(pluginName, value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${pluginName}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/** Validate an optional boolean config flag with a default. */
export function booleanOption(pluginName, value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new TypeError(`${pluginName}: ${field} must be a boolean`)
  }
  return value
}

/**
 * 必填整数配置：缺键 / 非整数 / 越界一律 fail loud。
 * 默认值归模板与预设（组合源 yml 的 config 或本预设 moduleConfigs），引擎不兜底。
 */
export function requiredInt(pluginName, value, field, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${pluginName}: ${field} must be an integer >= ${minimum}`)
  }
  return value
}

/**
 * 必填文本配置：缺键 / 非字符串 fail loud（引导措辞归模板与预设，引擎不内置文案）；
 * 空串 = 显式留空，返回 undefined 供调用方跳过注册（无正文即无该能力行为）。
 */
export function requiredText(pluginName, value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`${pluginName}: ${field} must be a string — 默认文案归模板/预设，请在本预设或组合源提供`)
  }
  return value.length > 0 ? value : undefined
}

/** Validate the shared config envelope and unknown-key contract. */
export function validateConfig(pluginName, source, allowedKeys) {
  const config = source === undefined ? {} : source
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new TypeError(`${pluginName}: config must be an object`)
  }
  const unknown = Object.keys(config).filter((key) => !allowedKeys.has(key))
  if (unknown.length > 0) {
    throw new TypeError(
      `${pluginName}: unknown config key(s) ${unknown.join(', ')} — allowed keys: ${[...allowedKeys].sort().join(', ')}`,
    )
  }
  return config
}

/** One-shot logger guard shared by filters that degrade instead of throwing. */
export function createWarnOnce(ctx, pluginName) {
  let warned = false
  return (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }
}

/** Random message id with a crypto.randomUUID fast path. */
export function newMessageId(prefix) {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Extract plain text from a message or from a wrapped event data shape. */
export function extractText(message) {
  if (!message) return ''
  const payload = message && typeof message.message === 'object' && message.message !== null
    ? message.message
    : message
  const content = Array.isArray(payload.content) ? payload.content : []
  return content.map((block) => (typeof block === 'string' ? block : (block?.text ?? ''))).join(' ').trim()
}

/** True for subagent sessions. */
export function isDelegated(session) {
  return (session?.header?.delegationDepth ?? 0) > 0
}

/**
 * 读取当前 Session 的不可变事件快照。
 * 正式 API 是 snapshotEvents()（DSH 0.1.2-alpha.4+）；宿主缺失该接口时按空日志处理，不再读取旧 events 数组。
 */
export function sessionEvents(session) {
  const snapshot = session?.snapshotEvents?.()
  return Array.isArray(snapshot) ? snapshot : []
}

/** True when a model id looks like a Flash-family model. */
export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

/** 模型范围过滤:flash=仅 Flash 家族模型;pro=仅非 Flash;all=全部。 */
export function matchesModel(scope, model) {
  if (scope === 'all') return true
  const isFlash = isFlashModel(model)
  return scope === 'flash' ? isFlash : !isFlash
}

/** 逗号分隔的 token 列表;空 = 空数组(调用方自行决定"全部"语义)。 */
export function parseToolNames(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

/** 读取可选服务;测试桩 / 极简组合里缺失时返回 undefined,由调用方降级。 */
export function getService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** 把服务注册返回的 disposer 挂到 fiber(资源注册契约)。 */
export function keepDisposer(ctx, disposer, label) {
  if (typeof disposer !== 'function') return
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => disposer, label)
      return
    }
  } catch {
    // 极简测试桩没有 effect:保持注册随进程,测试自行隔离。
  }
}
/** 会话态 Map 上限：session 数超出后整体清空防无界增长
 *  （进程内快路径，真相在 durable 事件流，清空仅触发一次冷扫重建）。 */
export const MAX_TRACKED_SESSIONS = 4096

/** 按会话 key 取 Map 条目；超限时清空后重建（防 session 数无界增长）。 */
export function sessionMapGet(map, key, create) {
  let entry = map.get(key)
  if (entry === undefined) {
    if (map.size >= MAX_TRACKED_SESSIONS) map.clear()
    entry = create()
    map.set(key, entry)
  }
  return entry
}

/**
 * 会话态声明的统一访问接口（B4 T1 步骤一）。
 *
 * 收敛「每个模块自己维护会话态 Map、自己决定上限与清空策略、自己决定复位时机」，
 * 但**不改变任何既有策略**：键类型、淘汰策略、复位语义逐项由调用方按现状声明，
 * 本函数只把它们收进同一套读写入口。它**不替代** `sessionMapGet`（后者仍是
 * 「按 id + 超限全清」这一档的实现，本函数在 `evict` 缺省且按 id 索引时逐字复用它）。
 *
 * ## 三个必答项（正好对应现状的三处差异）
 *
 *   1. **键类型**：`weak: true` 用会话**对象身份**（`WeakMap`，随对象回收、无上限，
 *      既有先例见原 `context-gate` 的延迟状态表，它已随模块删除）；缺省用 `session.id`
 *      （跨对象稳定的快路径键）。
 *   2. **淘汰策略**：按 id 索引时缺省 `clear()` 全清（`MAX_TRACKED_SESSIONS` 上限，
 *      清空只触发一次冷扫重建）；`evict: 'oldest'` 是**另一档**——只删早于当前新建的
 *      一个条目，与 `clear()` **不等价**，只有调用方明确声明要用它时才生效（既有两处
 *      见 `layers` 的去重 memo，B4 保留原状并注释）。
 *   3. **复位语义**：`reset` **缺省完全不订阅** `session/event`（零开销，模块自行在其
 *      既有监听里处理复位）；给了 `reset` 才注册一条监听，且**只有 `reset` 返回 true
 *      才删除该会话条目**——由调用方按**状态字段**决定，不按模块决定
 *      （`tool-bootstrap` 的 `stage` 与 `promotion` 策略相反，是这条的现成反例）。
 *
 * **纪律**：进程内状态是快路径，真相在 durable 事件流；迁移到本接口**不得**让任何判定
 * 从 durable 事实退化为进程内状态，也不得改变任何门控/过滤的结果。
 *
 * @param {object} ctx 挂载期 ctx（只有声明了 `reset` 才需要它；缺 `on` 时 watchdog 不订阅）
 * @param {() => any} create 新会话条目的工厂
 * @param {object} [options]
 * @param {boolean} [options.weak] 用会话对象身份做键（WeakMap，无上限）
 * @param {number} [options.limit] 按 id 索引时的条目上限，缺省 `MAX_TRACKED_SESSIONS`
 * @param {'clear'|'oldest'|null} [options.evict] 超限淘汰策略，缺省 `'clear'`
 * @param {(session: unknown, event: unknown) => boolean} [options.reset] 复位判定
 * @returns {{get: Function, peek: Function, set: Function, delete: Function, size: () => number, keys: Function, clear: Function}}
 */
export function sessionState(ctx, create, { weak = false, limit = MAX_TRACKED_SESSIONS, evict = 'clear', reset } = {}) {
  const store = weak ? new WeakMap() : new Map()
  const keyOf = (session) => (weak ? session : session?.id)
  // ponytail: 无上限档（weak / limit: null / evict: null）与有上限档共用一条读写路径，
  // 只在上限判定处分支；未声明上限时不创建任何额外计数器。
  const finite = !weak && typeof limit === 'number' && limit > 0 && evict !== null
  /** 超限处理：`clear` 与 `oldest` 是**两档不同语义**，绝不互相降级。 */
  const settle = () => {
    if (!finite) return
    if (store.size < limit) return
    if (evict === 'oldest') store.delete(store.keys().next().value)
    else store.clear()
  }
  const peek = (session) => (keyOf(session) === undefined ? undefined : store.get(keyOf(session)))
  const set = (session, value) => {
    const key = keyOf(session)
    // 无 id 的会话**不记账**（与 `predicates.mjs:343` 的既有决定一致）：共用一个 Map 键
    // 会让两个会话串味，所以这里返回 undefined 而不是伪造一个存不住的条目。
    if (key === undefined) return undefined
    settle()
    store.set(key, value)
    return value
  }
  const get = (session) => {
    const known = peek(session)
    return known === undefined ? set(session, create()) : known
  }
  const remove = (session) => {
    const key = keyOf(session)
    return key === undefined ? false : store.delete(key)
  }

  // 复位：只在调用方声明了 reset 时订阅，且删除与否由 reset 的返回值决定。
  if (typeof reset === 'function' && typeof ctx?.on === 'function') {
    const disposer = ctx.on('session/event', (session, event) => {
      try {
        if (reset(session, event) === true) remove(session)
      } catch {
        // 复位失败不得影响事件流上的其它监听器（与各模块既有降级纪律一致）。
      }
    })
    keepDisposer(ctx, disposer, 'session-state-reset')
  }

  return {
    get,
    peek,
    set,
    delete: remove,
    size: () => (weak ? NaN : store.size),
    keys: () => (weak ? [] : [...store.keys()]),
    clear: () => { if (!weak) store.clear() },
    weak,
    limit: finite ? limit : null,
    evict: finite ? evict : null,
  }
}

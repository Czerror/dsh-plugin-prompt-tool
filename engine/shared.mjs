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

/** 模板变量插值:配置 variables 优先,内置 {{DSH_HOME}} / {{WORKSPACE}} / {{CWD}}。 */
export function interpolateVariables(text, variables, session) {
  const builtins = {
    DSH_HOME: process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : ''),
    WORKSPACE: process.env.DSH_WORKSPACE ?? session?.header?.cwd ?? process.cwd(),
    CWD: session?.header?.cwd ?? process.cwd(),
  }
  return text.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) return String(variables[key])
    return Object.prototype.hasOwnProperty.call(builtins, key) ? builtins[key] : whole
  })
}

/** 仅做配置级静态变量替换(无 session 上下文的层)。 */
export function interpolateStatic(text, variables) {
  return text.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : whole)
}

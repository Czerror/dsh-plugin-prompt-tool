const key = Symbol.for('prompt-tool:request-budget')
export const requestBudgetOwner = Symbol.for('prompt-tool:request-budget-owner')
const slot = Symbol.for('prompt-tool:request-budget-seed')
const proposal = Symbol.for('prompt-tool:request-budget-proposal')
export const requestBudgetState = globalThis[key] ??= {
  available: false, reason: 'early entry not loaded before official request owner (missing or cached)',
}

/** 凭据只关联当次配置，不保存规则、额度选择或会话配置。 */
export function markRequestBudget(result, base, value, onAccepted) {
  const inherited = base[proposal]
  const prior = inherited !== undefined && Object.is(base.maxTokens, inherited.value) ? inherited : undefined
  // 枚举Symbol随其它请求中间件的浅拷贝保留，官方JSON/structuredClone不持久化它。
  result[proposal] = Object.freeze({ value, present: prior?.present ?? Object.hasOwn(base, 'maxTokens'),
    original: prior === undefined ? base.maxTokens : prior.original, onAccepted })
}

requestBudgetState.accepted = (agent, proposed, resolved) => {
  const own = proposed[proposal]
  if (own === undefined) return
  const matched = Object.is(resolved.maxTokens, own.value)
  if (matched) agent[slot] = { value: own.value, present: own.present, original: own.original }
  try { own.onAccepted?.(agent, matched) } catch { /* 诊断不改变已接受请求 */ }
}

export function requestBudgetStatus(agent) {
  if (!requestBudgetState.available) return { available: false, reason: requestBudgetState.reason }
  const available = agent?.[requestBudgetOwner] === true
  return { available, reason: available ? '' : 'verified official request owner unavailable' }
}

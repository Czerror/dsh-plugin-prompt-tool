import { labelOf, toolNameSet } from './shared.mjs'

export function prepareDecision(action, plugin) {
  const label = labelOf(action)
  const names = toolNameSet(action.toolNames, plugin, `${label}.toolNames`)
  const matchesTool = (exec) => names === undefined || names.has(exec?.name)
  const hit = (exec, result) => typeof action.match !== 'function' || action.match(exec, result) === true
  const phase = action.phase === undefined ? 'pre' : action.phase
  if (!['pre', 'post'].includes(phase)) {
    throw new TypeError(`${plugin}: ${label}.phase must be one of pre, post`)
  }
  if (phase === 'pre') {
    const decision = action.decision ?? 'allow'
    if (!['allow', 'deny', 'ask'].includes(decision)) {
      throw new TypeError(`${plugin}: ${label}.decision must be one of allow, deny, ask`)
    }
    return (_ctx, { warnOnce, on, collect, take }) => collect(on('tools/pre-execute', async (exec, next) => {
      try {
        if (!matchesTool(exec) || !hit(exec)) return next()
        if (decision === 'allow') return next()
        // `||` 而非 `??`：种子里的 `reason: ''` 是「取引擎缺省」的中性值，不是「无解释的拒绝」。
        const outcome = decision === 'deny'
          ? { kind: 'deny', reason: String(action.reason || `${label}: denied by action`) }
          : { kind: 'ask' }
        return take(exec) ? outcome : next()
      } catch (error) {
        warnOnce(`${plugin}: decision(pre) action ${label} failed: ${String(error?.message ?? error)}`)
        return next()
      }
    }))
  }
  const postAction = action.action ?? 'accept'
  if (!['accept', 'replace', 'block'].includes(postAction)) {
    throw new TypeError(`${plugin}: ${label}.action must be one of accept, replace, block`)
  }
  const text = typeof action.text === 'string' ? action.text : ''
  return (_ctx, { warnOnce, on, collect, take }) => collect(on('tools/post-execute', async (exec, result, next) => {
    try {
      if (!matchesTool(exec) || !hit(exec, result)) return next()
      if (postAction === 'accept') return next()
      if (postAction === 'replace' && text.length > 0) {
        if (!take(exec)) return next()
        return { kind: 'accept', content: [{ type: 'text', text }] }
      }
      if (postAction === 'block') {
        if (!take(exec)) return next()
        return { kind: 'block', feedback: [{ type: 'text', text: text.length > 0 ? text : `${label}: blocked by action` }] }
      }
      return next()
    } catch (error) {
      warnOnce(`${plugin}: decision(post) action ${label} failed: ${String(error?.message ?? error)}`)
      return next()
    }
  }))
}

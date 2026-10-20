import { labelOf } from './shared.mjs'

/**
 * tool-gate —— 工具执行前的裁决（pre 相）。
 *
 * 从原 `decision` 拆出：字段只保留这一相真正读的键，写错相位就是未知字段而不是静默失效。
 * 异常与条件未命中一律走 `next()`（放行）——裁决 bug 不该卡死调用。
 */
export function prepareToolGate(action, plugin) {
  const label = labelOf(action)
  const decision = action.decision ?? 'allow'
  if (!['allow', 'deny', 'ask'].includes(decision)) {
    throw new TypeError(`${plugin}: ${label}.decision must be one of allow, deny, ask`)
  }
  if (action.reason !== undefined && typeof action.reason !== 'string') {
    throw new TypeError(`${plugin}: ${label}.reason must be a string`)
  }
  return (_ctx, { warnOnce, on, collect, take }) => collect(on('tools/pre-execute', async (exec, next) => {
    try {
      if (decision === 'allow') return next()
      // `||` 而非 `??`：空串是「取引擎缺省」的中性值，不是「无解释的拒绝」。
      const outcome = decision === 'deny'
        ? { kind: 'deny', reason: String(action.reason || `${label}: denied by action`) }
        : { kind: 'ask' }
      return take(exec) ? outcome : next()
    } catch (error) {
      warnOnce(`${plugin}: tool-gate action ${label} failed: ${String(error?.message ?? error)}`)
      return next()
    }
  }))
}

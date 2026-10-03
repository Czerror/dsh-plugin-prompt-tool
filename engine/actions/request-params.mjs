import { labelOf } from './shared.mjs'
import { applyAgentRequestParams, matchesAgentScope } from '../layers.mjs'

export function prepareRequestParams(action, plugin) {
  const label = labelOf(action)
  const patch = action.patch
  if (patch !== undefined && (patch === null || typeof patch !== 'object' || Array.isArray(patch))) {
    throw new TypeError(`${plugin}: ${label}.patch must be an object`)
  }
  const unset = action.unset
  if (unset !== undefined && (unset === null || typeof unset !== 'object' || Array.isArray(unset))) {
    throw new TypeError(`${plugin}: ${label}.unset must be an object of { key: expectedValue }`)
  }
  if (action.replace === true && unset !== undefined) {
    throw new TypeError(`${plugin}: ${label} cannot combine replace with unset — 整体替换没有可比较的下游值`)
  }
  const params = { ...(patch !== undefined ? { patch } : {}), ...(unset !== undefined ? { unset } : {}), ...(action.replace === true ? { replace: true } : {}) }
  return (_ctx, { warnOnce, on, collect, take }) => collect(on('agent/request', async (payload, next) => {
    const base = await next()
    try {
      if (!matchesAgentScope(action, payload?.agent)) return base
      const result = applyAgentRequestParams(params, base)
      const keys = Object.keys(result)
      const changed = base == null || keys.length !== Object.keys(base).length
        || keys.some((key) => !Object.hasOwn(base, key) || !Object.is(result[key], base[key]))
      return changed && take(payload) ? result : base
    } catch (error) {
      warnOnce(`${plugin}: request-params action ${label} failed: ${String(error?.message ?? error)}`)
      return base
    }
  }))
}

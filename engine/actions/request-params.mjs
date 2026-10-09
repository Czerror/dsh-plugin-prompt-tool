import { labelOf } from './shared.mjs'
import { applyAgentRequestParams, matchesAgentScope } from '../layers.mjs'
import { assertReplacePatch } from '../schema.mjs'

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
  // 信任边界：只接受布尔值（缺省 = false），显式 `'yes'` / `1` / `null` 一律拒绝，
  // 与 config 层 `agent-request.params.replace` 的严格化对称——静默退化成「只合并 patch」
  // （`applyAgentRequestParams` 只在 `=== true` 时整体替换）会让「写了却没生效」无法察觉。
  if (action.replace !== undefined && typeof action.replace !== 'boolean') {
    throw new TypeError(`${plugin}: ${label}.replace must be a boolean (省略 = false) — got ${JSON.stringify(action.replace)}`)
  }
  if (action.replace === true && unset !== undefined) {
    throw new TypeError(`${plugin}: ${label} cannot combine replace with unset — 整体替换没有可比较的下游值`)
  }
  assertReplacePatch(patch, action.replace, `${plugin}: ${label}.patch`)
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

import { bool, defineConfig, enumOf, passthrough } from './fields.mjs'
import { SOUL_MAINTENANCE_SERVICE } from './service-names.mjs'

export const name = 'soul-maintenance'
const bounded = (fallback, min, max) => passthrough((value = fallback, plugin, field) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${plugin}: ${field} must be an integer from ${min} to ${max}`)
  return value
})
export const configContract = defineConfig({
  enabled: bool({ default: false }), intervalMs: bounded(60000, 1000, 2147483647),
  wake: bool({ default: false }), audience: enumOf(['all', 'main', 'subagent'], { default: 'all' }),
  budgetBytes: bounded(12288, 1024, 65536),
})
export function apply(ctx, raw, options = {}) {
  const config = configContract.parse(raw, name)
  if (!config.enabled) return
  ctx.inject([SOUL_MAINTENANCE_SERVICE], scopeCtx => {
    scopeCtx.effect(() => scopeCtx.get(SOUL_MAINTENANCE_SERVICE).mount(scopeCtx, config, options), name + ': mount')
  })
}

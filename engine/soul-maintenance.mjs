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
  pressureThresholds: passthrough((value, plugin, field) => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length !== 3 || value.some((ratio, index) => typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1 || index > 0 && ratio <= value[index - 1])) throw new TypeError(`${plugin}: ${field} must be three increasing ratios between 0 and 1`)
    return [...value]
  }),
})
export function apply(ctx, raw, options = {}) {
  const config = configContract.parse(raw, name)
  if (!config.enabled) return
  ctx.inject([SOUL_MAINTENANCE_SERVICE], scopeCtx => {
    scopeCtx.effect(() => scopeCtx.get(SOUL_MAINTENANCE_SERVICE).mount(scopeCtx, config, options), name + ': mount')
  })
}

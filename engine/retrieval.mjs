import { bool, defineConfig, stringList } from './fields.mjs'
import { toolServiceName } from './service-names.mjs'

export const name = 'retrieval'
export const inject = ['tools']
export const configContract = defineConfig({
  enabled: bool({ default: false }),
  paths: stringList({ default: () => [], allowEmpty: true, dedupe: true }),
  sessions: stringList({ default: () => [], allowEmpty: true, dedupe: true }),
})

export function apply(ctx, raw, options) {
  const config = configContract.parse(raw, name)
  if (!config.enabled) return
  const fiber = ctx.inject([toolServiceName(name)], scopeCtx => scopeCtx.effect(() => scopeCtx.get(toolServiceName(name)).mount(scopeCtx, config, options)))
  return () => { void fiber.dispose() }
}

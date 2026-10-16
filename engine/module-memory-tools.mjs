import { toolServiceName } from './service-names.mjs'

export const name = 'module-memory-tools'
export function apply(ctx) {
  ctx.inject([toolServiceName('module-memory-tools')], scopeCtx => {
    scopeCtx.effect(() => scopeCtx.get(toolServiceName('module-memory-tools')).mount(scopeCtx), name + ': mount')
  })
}

import { toolServiceName } from './service-names.mjs'

export const name = 'soul-ledger'
export function apply(ctx) {
  ctx.inject([toolServiceName(name)], scopeCtx => {
    scopeCtx.effect(() => scopeCtx.get(toolServiceName(name)).mount(scopeCtx), name + ': mount')
  })
}

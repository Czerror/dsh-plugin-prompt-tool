import { toolServiceName } from './service-names.mjs'

export const name = 'module-manifest-tools'
export function apply(ctx) {
  ctx.inject([toolServiceName('module-manifest-tools')], scopeCtx => {
    scopeCtx.effect(() => scopeCtx.get(toolServiceName('module-manifest-tools')).mount(scopeCtx), name + ': mount')
  })
}

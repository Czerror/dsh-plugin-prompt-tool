import { toolServiceName } from './service-names.mjs'

export const name = 'module-file-tools'
export function apply(ctx) {
  ctx.inject([toolServiceName('module-file-tools')], scopeCtx => {
    scopeCtx.effect(() => scopeCtx.get(toolServiceName('module-file-tools')).mount(scopeCtx), name + ': mount')
  })
}

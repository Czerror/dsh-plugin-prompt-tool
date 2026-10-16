/** 两级持久模块变量工具，按声明等待宿主 provider。 */
import { toolServiceName } from './service-names.mjs'

export const name = 'module-variable-tools'

export function apply(ctx) {
  ctx.inject([toolServiceName('module-variable-tools')], scopeCtx => {
    scopeCtx.effect(() => scopeCtx.get(toolServiceName('module-variable-tools')).mount(scopeCtx), name + ': mount')
  })
}

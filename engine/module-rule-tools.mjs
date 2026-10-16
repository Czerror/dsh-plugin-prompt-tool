/** 完整模块规则工具，按声明等待宿主 provider。 */
import { toolServiceName } from './service-names.mjs'

export const name = 'module-rule-tools'

export function apply(ctx) {
  ctx.inject([toolServiceName('module-rule-tools')], scopeCtx => {
    scopeCtx.effect(() => scopeCtx.get(toolServiceName('module-rule-tools')).mount(scopeCtx), name + ': mount')
  })
}

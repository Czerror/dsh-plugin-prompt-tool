/** 角色卡库工具预设模块。 */
import { toolServiceName } from "./service-names.mjs"

export const name = "module-import-tools"

export function apply(ctx) {
  ctx.inject([toolServiceName("module-import-tools")], (scopeCtx) => {
    scopeCtx.effect(() => scopeCtx.get(toolServiceName("module-import-tools")).mount(scopeCtx), name + ": mount")
  })
}

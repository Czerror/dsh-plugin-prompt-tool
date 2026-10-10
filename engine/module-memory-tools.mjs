export const name = 'module-memory-tools'
export function apply(ctx) {
  ctx.inject(['pt-module-memory-tools'], scopeCtx => {
    scopeCtx.effect(() => scopeCtx.get('pt-module-memory-tools').mount(scopeCtx), name + ': mount')
  })
}

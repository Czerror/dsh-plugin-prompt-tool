import { Context } from '@deepseek-ai/cordis'

/** 只路由声明Agent，原provider的方法和其它监听器保持原所有权。 */
export function routeContextRuntime(ctx, agent, runtime) {
  let active = true
  const disposers = []
  for (const service of ['compaction', 'toolResultPruner']) {
    if (!runtime[service]) continue
    const dependency = ctx.inject([service], dependent => {
      // 已发布Fiber.store公开了这次依赖快照的精确provider身份。
      const owner = dependent.fiber.store[service].fiber
      const carriers = new WeakMap()
      const offDispatch = service === 'compaction' ? dependent.on('internal/dispatch', (_mode, event, args, carrier) => {
        if (!active || !['agent/pre-step', 'agent/request-error', 'agent/request'].includes(event)
          || args[0]?.agent !== agent || !carrier) return
        if (carriers.has(carrier)) return
        const original = carrier[Context.filter]
        const filter = function (candidate) {
          return (!original || original.call(this, candidate)) && (!active || candidate.fiber !== owner)
        }
        carriers.set(carrier, original)
        carrier[Context.filter] = filter
      }) : () => {}
      const offGet = dependent.on('internal/get', (_consumer, key, _error, next) => {
        const original = next()
        if (!active || key !== service || !original) return original
        return new Proxy(original, {
          get(target, property) {
            const method = target[property]
            if (typeof method !== 'function') return method
            return (...args) => {
              const subject = service === 'toolResultPruner' ? args[0] : property === 'compactRegion' ? args[2] : args[0]
              const selected = service === 'toolResultPruner' ? subject === agent.session : subject === agent
              if (active && selected && typeof runtime[service][property] === 'function') return runtime[service][property](...args)
              return method.apply(target, args)
            }
          },
        })
      }, { prepend: true })
      return () => { offDispatch(); offGet() }
    })
    disposers.push(() => dependency.dispose())
  }
  return () => { active = false; for (const dispose of disposers) void dispose() }
}

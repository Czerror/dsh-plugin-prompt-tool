/** 模块内容策略只读取宿主提供的 SELF 出口，身份取当前 resolve 帧。 */
export function createResolver(config) {
  return ({ ctx, agent, signal }) => {
    const service = ctx.get(config.params?.service)
    if (typeof service?.render !== 'function') throw new Error('SELF dependency missing')
    return { text: service.render(config.sourceModuleId, agent, signal) }
  }
}

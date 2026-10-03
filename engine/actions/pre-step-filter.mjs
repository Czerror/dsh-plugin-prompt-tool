import { NAME_LIST, labelOf } from './shared.mjs'

export function preparePreStepFilter(action, plugin) {
  const label = labelOf(action)
  const sources = NAME_LIST.parse(action.sources, plugin, `${label}.sources`)
  const keepKinds = NAME_LIST.parse(action.keepKinds, plugin, `${label}.keepKinds`)
  // `blockPlugins`（B8 T8，2026-09-22 拍板「大小写不敏感的精确等值」）：与上面两种白名单**正交**，
  // 因此可共存——白名单决定「留哪些 kind」，本名单决定「再剔掉哪些插件」。未声明或空名单 =
  // 不过滤（空集没有可剔对象；这与白名单「空 = 全拦」的语义**相反**，勿沿用邻居语义）。
  const parsedBlockPlugins = NAME_LIST.parse(action.blockPlugins, plugin, `${label}.blockPlugins`)
  const blockPlugins = parsedBlockPlugins === undefined || parsedBlockPlugins.size === 0
    ? undefined
    : new Set([...parsedBlockPlugins].map((name) => name.toLowerCase()))
  if (sources !== undefined && keepKinds !== undefined) {
    throw new TypeError(`${plugin}: ${label} cannot combine sources with keepKinds — 两种过滤语义的保留集定义不同`)
  }
  if (sources === undefined && keepKinds === undefined && blockPlugins === undefined) return
  return (_ctx, { warnOnce, on, collect, take }) => collect(on('agent/pre-step', async ({ agent, messages: claimed } = {}, next) => {
    const decision = await next()
    try {
      if (decision?.kind === 'reject') return decision
      if (!Array.isArray(decision?.messages)) return decision
      let messages = decision.messages
      if (sources !== undefined) {
        messages = messages.filter((message) => sources.has(message?.source?.kind))
      } else if (keepKinds !== undefined && Array.isArray(claimed)) {
        const baseline = new Set(claimed)
        const baselineIds = new Set(claimed
          .map((message) => message?.id)
          .filter((id) => id !== undefined && id !== null))
        messages = messages.filter((message) =>
          baseline.has(message)
          || (message?.id !== undefined && message?.id !== null && baselineIds.has(message.id))
          || keepKinds.has(message?.source?.kind))
      }
      if (blockPlugins !== undefined) {
        messages = messages.filter((message) => {
          const source = message?.source
          // v4 起插件来源的 kind 是生产者名（`plugin:<name>`），旧日志才有裸 `plugin`：
          // 只认其中一种，换代后这道「按 source.plugin 精确屏蔽」的逃生阀会静默失效。
          const isPlugin = source?.kind === 'plugin'
            || (typeof source?.kind === 'string' && source.kind.startsWith('plugin:'))
          if (!isPlugin) return true
          const name = source?.plugin
          // 只认插件自报的字符串身份；非字符串一律不拦（宁可少拦，不可误删上下文）。
          return typeof name !== 'string' || !blockPlugins.has(name.toLowerCase())
        })
      }
      return messages.length !== decision.messages.length && take({ agent }) ? { ...decision, messages } : decision
    } catch (error) {
      warnOnce(`${plugin}: pre-step-filter action ${label} failed, keeping every message: ${String(error?.message ?? error)}`)
      return decision
    }
  }))
}

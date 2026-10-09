import { labelOf, requireString } from './shared.mjs'
import { createTurnStopBudget, pluginMessage } from '../layers.mjs'

export function prepareAppendContext(action, plugin, _promptConfigOptions, turnStopBudget) {
  const label = labelOf(action)
  const text = requireString(action.text, `${label}.text`, plugin)
  if (text.length === 0) return
  if (action.mode === 'continue') {
    return (_ctx, { warnOnce, on, collect, take }) => {
      // 共享预算优先：同一来源模块的多条 continue 每轮只续跑一次（上限按模块一份）；
      // 无调用方预算时保持按动作新建（独立 registerAction 路径）。
      const budget = turnStopBudget ?? createTurnStopBudget()
      collect(on('agent/turn-stopping', ({ agent, turn } = {}) => {
        try {
          if (typeof action.match === 'function' && action.match(agent, turn) !== true) return
          const session = agent?.session
          if (session?.id === undefined || typeof agent.steer !== 'function') return
          const entry = budget.entry(session.id, turn)
          if (!budget.available(entry, turn) || !take({ agent })) return
          // 计数在 steer 之前落账：steer 抛错也不允许下一步重试越过预算。
          budget.claim(entry, turn)
          // 身份归本动作：复用 pluginMessage 的形状，但 source.plugin 必须是动作命名空间
          // （层模块的 pluginMessage 用 layers 自己的身份，那不是本动作的名字）。
          const message = pluginMessage(`action-${label}`, text, `${label} continue`)
          agent.steer({ ...message, source: { ...message.source, plugin: label } })
        } catch (error) {
          warnOnce(`${plugin}: append-context(continue) action ${label} failed: ${String(error?.message ?? error)}`)
        }
      }))
    }
  }
  // 追加上下文：只回 user 角色的 durable 通知（宿主把 additionalContexts 落成 user 消息）。
  return (_ctx, { warnOnce, on, collect, take }) => collect(on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (typeof action.match === 'function' && action.match(exec, result, decision) !== true) return decision
      if (decision?.kind !== 'accept') return decision
      // source 形状与 pluginMessage 同源：v4 要求 kind 是生产者名（`plugin:<name>`），
      // 裸 `plugin` 会被会话格式校验拒绝，这条 durable user 通知就落不了盘。
      const notice = {
        ...pluginMessage(`action-${label}`, text, `${label} context`),
        source: { kind: `plugin:${label}`, plugin: label, form: 'notice', summary: `${label} context` },
      }
      const updated = { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), notice] }
      return take(exec) ? updated : decision
    } catch (error) {
      warnOnce(`${plugin}: append-context action ${label} failed, keeping the plain result: ${String(error?.message ?? error)}`)
      return decision
    }
  }))
}

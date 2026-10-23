import { labelOf, requireString } from './shared.mjs'
import { pluginMessage } from '../layers.mjs'
import { pluginKind } from '../source-kind.mjs'

export function prepareAppendContext(action, plugin) {
  const label = labelOf(action)
  const text = requireString(action.text, `${label}.text`, plugin)
  if (text.length === 0) return
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
        source: { kind: pluginKind(label), plugin: label, form: 'notice', summary: `${label} context` },
      }
      const updated = { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), notice] }
      return take(exec) ? updated : decision
    } catch (error) {
      warnOnce(`${plugin}: append-context action ${label} failed, keeping the plain result: ${String(error?.message ?? error)}`)
      return decision
    }
  }))
}

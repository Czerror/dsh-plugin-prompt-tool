import { labelOf } from './shared.mjs'
import { editResultText, validateResultTextEdits } from '../result-text.mjs'
import { resultTextOwners } from '../result-text-owners.mjs'

/**
 * tool-result —— 工具结果结算后的处理（post 相）。
 *
 * 从原 `decision` 拆出：只读这一相的字段。`text` 仅 replace / block 使用；
 * 异常一律 `next()`（接受），绝不让结果处理把工具调用变成失败。
 */
export function prepareToolResult(action, plugin) {
  const label = labelOf(action)
  const mode = action.action ?? 'accept'
  if (!['accept', 'replace', 'block', 'edit-text'].includes(mode)) {
    throw new TypeError(`${plugin}: ${label}.action must be one of accept, replace, block, edit-text`)
  }
  if (mode === 'edit-text') {
    validateResultTextEdits(action.edits, plugin)
    if (action.waterfallPosition !== undefined && action.waterfallPosition !== 'default') {
      throw new TypeError(`${plugin}: ${label} edit-text does not support waterfallPosition; it uses snapshotted result-content slots`)
    }
  }
  else if (action.edits !== undefined) throw new TypeError(`${plugin}: ${label}.edits requires action edit-text`)
  if (action.text !== undefined && typeof action.text !== 'string') {
    throw new TypeError(`${plugin}: ${label}.text must be a string`)
  }
  const text = typeof action.text === 'string' ? action.text : ''
  return (ctx, { warnOnce, on, collect, take }) => {
    const plan = { edits: action.edits, plugin, warnOnce, take }
    const handler = async (exec, result, next) => {
      if (mode === 'edit-text') {
        if (resultTextOwners.handled.has(exec)) return next()
        const decision = await next()
        try { return editResultText(exec, result, decision, [plan], ctx.get('tools')) }
        catch (error) {
          warnOnce(`${plugin}: tool-result action ${label} failed: ${String(error?.message ?? error)}`)
          return decision
        }
      }
      try {
        if (mode === 'accept') return next()
        if (mode === 'replace' && text.length > 0) {
          if (!take(exec)) return next()
          return { kind: 'accept', content: [{ type: 'text', text }] }
        }
        if (mode === 'block') {
          if (!take(exec)) return next()
          return { kind: 'block', feedback: [{ type: 'text', text: text.length > 0 ? text : `${label}: blocked by action` }] }
        }
        return next()
      } catch (error) {
        warnOnce(`${plugin}: tool-result action ${label} failed: ${String(error?.message ?? error)}`)
        return next()
      }
    }
    if (mode === 'edit-text') handler.resultTextPlan = plan
    return collect(on('tools/post-execute', handler))
  }
}

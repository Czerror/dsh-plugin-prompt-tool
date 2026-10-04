import { subjectOf } from './subject.mjs'

/**
 * 一次官方调用的局部判定帧；不按 session、turn 或载荷身份缓存。
 * `ctx` 是判定期服务入口：子代理事件靠它用 `id` 反查 agent（见 subject.mjs 的
 * `subagentFacts`），使 `modelScope`/`audience` 在判定阶段就有事实可用。
 */
export function ruleFrame(channel, args, warnOnce = () => {}, ctx) {
  return { channel, args, subject: subjectOf(channel, args, warnOnce, ctx), decisions: new Map(), warnOnce }
}

export function ruleMatches(rule, frame) {
  if (rule === undefined) return true
  if (frame.decisions.has(rule)) return frame.decisions.get(rule)
  let hit = rule.enabled !== false
  if (hit && typeof rule.when === 'function') {
    try { hit = rule.when(frame.subject) === true }
    catch (error) { hit = false; frame.warnOnce(`rule ${rule.id} condition failed: ${String(error?.message ?? error)}`) }
  }
  frame.decisions.set(rule, hit)
  return hit
}

/**
 * 动作级判定：规则条件与动作自身的分支条件都要过。
 *
 * `bypassRuleWhen` 的动作来自规则级 `else`——它的条件里已经含 `not(if)`，再叠加
 * `rule.when` 会自相矛盾、令该分支永不执行。动作条件缺省 = 恒真；非 `true`
 * （含 UNAVAILABLE 三值语义）一律不命中，与 `ruleMatches` 同一纪律。
 */
export function actionMatches(entry, frame) {
  if (entry.bypassRuleWhen !== true && !ruleMatches(entry.rule, frame)) return false
  const when = entry.actionWhen
  if (when === undefined) return true
  try {
    return when(frame.subject) === true
  } catch (error) {
    frame.warnOnce(`action ${entry.id} condition failed: ${String(error?.message ?? error)}`)
    return false
  }
}

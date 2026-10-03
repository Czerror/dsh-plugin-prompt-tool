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

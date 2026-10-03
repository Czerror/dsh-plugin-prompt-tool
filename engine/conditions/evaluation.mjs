import { subjectOf } from './subject.mjs'

/** 一次官方调用的局部判定帧；不按 session、turn 或载荷身份缓存。 */
export function ruleFrame(channel, args, warnOnce = () => {}) {
  return { channel, args, subject: subjectOf(channel, args, warnOnce), decisions: new Map(), warnOnce }
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

import { subjectOf } from './subject.mjs'
import { UNAVAILABLE } from './availability.mjs'

/**
 * 一次官方调用的局部判定帧；不按 session、turn 或载荷身份缓存。
 * `ctx` 是判定期服务入口：子代理事件靠它用 `id` 反查 agent（见 `subject.mjs` 的通道事实表
 * `CHANNELS`），使 `modelScope`/`audience` 在判定阶段就有事实可用。
 * `onOutcome` 是可选只读上报（规则、通道、判定类别），供宿主统计「配了没生效」；
 * 缺省不传即零开销，也不改变任何判定结果。
 */
export function ruleFrame(channel, args, warnOnce = () => {}, ctx, onOutcome) {
  return { channel, args, subject: subjectOf(channel, args, warnOnce, ctx), decisions: new Map(), actionDecisions: new Map(), warnOnce, onOutcome }
}

/** 只读上报：诊断抛错不得反过来打断判定（调用方可能在记账里访问规则身份）。 */
function report(frame, rule, outcome) {
  try { frame.onOutcome?.(rule, frame.channel, outcome) } catch { /* 诊断不得反过来打断判定 */ }
}

/** 单次规则级判定（帧内缓存，键为规则实例）：三值语义见下；只判定、不上报。 */
function decideRule(rule, frame) {
  if (rule === undefined) return { hit: true, outcome: 'hit' }
  const cached = frame.decisions.get(rule)
  if (cached !== undefined) return cached
  let hit = rule.enabled !== false
  let outcome = hit ? 'hit' : 'disabled'
  if (hit && typeof rule.when === 'function') {
    try {
      const decided = rule.when(frame.subject)
      hit = decided === true
      // 三值语义：缺事实（UNAVAILABLE）与「条件为假」在诊断里必须分开——前者是
      // 「为什么没触发」的答案，后者是条件按设计不满足。
      outcome = hit ? 'hit' : decided === UNAVAILABLE ? 'unavailable' : 'miss'
    } catch (error) {
      hit = false
      outcome = 'error'
      frame.warnOnce(`rule ${rule.id} condition failed: ${String(error?.message ?? error)}`)
    }
  }
  const decided = { hit, outcome }
  frame.decisions.set(rule, decided)
  return decided
}

export function ruleMatches(rule, frame) {
  if (rule === undefined) return true
  const cached = frame.decisions.get(rule)
  if (cached !== undefined) return cached.hit
  const decided = decideRule(rule, frame)
  report(frame, rule, decided.outcome)
  return decided.hit
}

/**
 * 动作级判定：规则条件与动作自身的分支条件都要过。
 *
 * `bypassRuleWhen` 的动作来自规则级 `else`——它的条件里已经含 `not(if)`，再叠加
 * `rule.when` 会自相矛盾、令该分支永不执行。动作条件缺省 = 恒真；非 `true`
 * （含 UNAVAILABLE 三值语义）一律不命中，与 `ruleMatches` 同一纪律。
 *
 * 上报（方案 A：不加 actionId 维度）：带动作级分支的动作上报「规则∧动作」的**最终**
 * 判定，按帧对每个动作实例去重一次——分支为真记 `hit`、为假记 `miss`、缺事实记
 * `unavailable`、异常记 `error`；这类动作不再单独发规则级上报，避免同一事件先记
 * `hit` 再记 `miss`。没有分支的动作最终判定就是规则级判定，沿用规则级上报。
 */
export function actionMatches(entry, frame) {
  const branched = entry.actionWhen !== undefined || entry.bypassRuleWhen === true
  if (!branched) return ruleMatches(entry.rule, frame)
  // `else`（bypassRuleWhen）自带 not(if)，不叠加规则级判定；其余带分支的动作自判
  // 规则级（不发上报），判定仍走同一份帧内缓存，同帧同规则依旧只判一次。
  const ruled = entry.bypassRuleWhen === true ? { hit: true, outcome: 'hit' } : decideRule(entry.rule, frame)
  let hit = ruled.hit
  let outcome = ruled.outcome
  if (hit) {
    try {
      const decided = entry.actionWhen === undefined ? true : entry.actionWhen(frame.subject)
      hit = decided === true
      outcome = hit ? 'hit' : decided === UNAVAILABLE ? 'unavailable' : 'miss'
    } catch (error) {
      hit = false
      outcome = 'error'
      frame.warnOnce(`action ${entry.id} condition failed: ${String(error?.message ?? error)}`)
    }
  }
  // 只去重上报，不缓存判定结果：同帧内重复求值仍按当次事实判定。
  if (!frame.actionDecisions.has(entry)) {
    frame.actionDecisions.set(entry, hit)
    report(frame, entry.rule, outcome)
  }
  return hit
}

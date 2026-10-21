/**
 * 规则判定记账（只读诊断）：只统计身份与判定类别，不存规则正文、事件载荷或会话文本。
 * 引擎经 `mountRuleSources({ onOutcome })` 上报（见 engine/rule-runtime.mjs）；账本由
 * 装配实例持有，工作台经 `/rule-diagnostics` 读当前实例；两处共用 bridge-contract 的类型。
 *
 * 有界：达到身份上限后不再新增，只累加已有身份，长会话不会无界增长；被丢弃的判定次数
 * 记在实例的 `dropped`，仅在大于 0 时随响应下发。多个装配实例互不串账。
 */
import type { RuleDiagnosticRecord, RuleOutcomeKind } from '../shared/bridge-contract.ts'

/** 记账身份上限；超出后不再新增。 */
export const RULE_DIAGNOSTIC_LIMIT = 512

/** 引擎上报的判定事件形状（与 `ruleFrame` 的 `onOutcome` 回调一一对应）。 */
export interface RuleOutcomeReport {
  moduleId?: string
  ruleId: string
  channel: string
  outcome: RuleOutcomeKind
}

export interface RuleDiagnosticsSnapshot {
  records: RuleDiagnosticRecord[]
  dropped: number
}

export const emptyRuleDiagnostics = (): RuleDiagnosticsSnapshot => ({ records: [], dropped: 0 })

export interface RuleDiagnosticsLedger {
  /** 记一次判定；未启用的规则不入账（那不是「配了没生效」）。 */
  record(report: RuleOutcomeReport): void
  /** 只读快照：每次返回新对象，不外泄内部引用，也不触发任何求值。 */
  snapshot(): RuleDiagnosticsSnapshot
}

const keyOf = (report: RuleOutcomeReport): string =>
  `${report.moduleId ?? ''}\u0000${report.ruleId}\u0000${report.channel}`

/** 一次装配实例的判定账本；随实例创建与释放，不共享全局状态。 */
export function createRuleDiagnosticsLedger(): RuleDiagnosticsLedger {
  const counters = new Map<string, RuleDiagnosticRecord>()
  let dropped = 0
  return {
    record(report) {
      const outcome = report.outcome
      if (outcome === 'disabled') return
      const key = keyOf(report)
      let record = counters.get(key)
      if (record === undefined) {
        if (counters.size >= RULE_DIAGNOSTIC_LIMIT) {
          dropped += 1
          return
        }
        record = {
          ...(report.moduleId === undefined ? {} : { moduleId: report.moduleId }),
          ruleId: report.ruleId,
          channel: report.channel,
          hit: 0,
          miss: 0,
          unavailable: 0,
          error: 0,
        }
        counters.set(key, record)
      }
      record[outcome] += 1
    },
    snapshot() {
      return { records: [...counters.values()].map(record => ({ ...record })), dropped }
    },
  }
}

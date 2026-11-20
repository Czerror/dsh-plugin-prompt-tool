import { isFixedRegistration } from '../../../engine/fixed-registration.mjs'
import type { RuleAction, RuleDefinition, RuleEditorMeta } from '../../shared/rules.ts'

/** 只读展示事实：动态层使用引擎目录，固定注册判据复用同一纯函数。 */
export function ruleExecutionPoint(action: RuleAction, rule: RuleDefinition, meta: RuleEditorMeta): { channel: string; phase: string; lifecycle: string } | undefined {
  const entry = meta.actions.find(candidate => candidate.kind === action.kind)
  if (!entry) return undefined
  if (action.kind !== 'inject-text') return { channel: entry.channel, phase: entry.phase, lifecycle: entry.lifecycle ?? 'event' }
  const config = action.config !== null && typeof action.config === 'object' && !Array.isArray(action.config)
    ? action.config as Record<string, unknown> : undefined
  if (!config) return undefined
  const layer = config.layer ?? rule.layer ?? 'pre-step'
  const point = typeof layer === 'string' ? meta.injectionPoints?.[layer] : undefined
  return point ? { ...point, lifecycle: isFixedRegistration(config, layer) ? 'registration' : 'event' } : undefined
}

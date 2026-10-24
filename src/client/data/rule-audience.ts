/**
 * raw 规则的只读展示事实：受众与 context activation。
 *
 * 这是 client 对 `engine/rule-facts.mjs` 的 typed 适配面；`features` 不直接 import engine。
 * 不引入 React、不持有状态、不参与执行门控。
 */
import { ruleFacts as engineRuleFacts } from '../../../engine/rule-facts.mjs'
import type { RuleFacts } from '../../../engine/rule-facts.mjs'
import type { RuleDefinition } from '../../shared/rules.ts'

export type { RuleFacts }

/** 一条 raw 规则的只读事实；未知形状按保守方向返回 undefined / false。 */
export function ruleFacts(rule: RuleDefinition): RuleFacts {
  const facts = engineRuleFacts(rule)
  // 展示上界：空集代表「没有可执行受众」，但编辑器不能因此把卡藏到无处可改；
  // 与未知受众同口径，两个页面都显示。
  return facts.audiences !== undefined && facts.audiences.size === 0
    ? { ...facts, audiences: undefined }
    : facts
}

import type { RuleAction, RuleDefinition } from '../shared/rules.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'
// @ts-expect-error 动作身份和内容默认值归唯一引擎编译器。
import { injectionConfigSpec } from '../../engine/rule-spec.mjs'

export interface RuleInjection {
  rule: RuleDefinition
  action: RuleAction
  config: PromptConfigSpec
}

/** 资产工具只投影注入动作的内容；不读取旧定义或创建第二份配置源。 */
export function ruleInjections(rules: readonly RuleDefinition[] = []): RuleInjection[] {
  return rules.flatMap(rule => rule.do.flatMap(action => action.kind === 'inject-text'
    ? [{ rule, action, config: injectionConfigSpec(rule, action) as PromptConfigSpec }] : []))
}

/** 只替换指定注入动作载荷，保留同一卡的判断与其他动作。 */
export function mapRuleInjections(rule: RuleDefinition, map: (config: PromptConfigSpec, action: RuleAction) => PromptConfigSpec): RuleDefinition {
  return { ...rule, do: rule.do.map(action => action.kind === 'inject-text'
    ? { ...action, config: map(injectionConfigSpec(rule, action) as PromptConfigSpec, action) } : action) }
}

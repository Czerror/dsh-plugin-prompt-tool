import type { RuleAction, RuleDefinition } from '../shared/rules.ts'
import type { PromptConfigSpec } from './prompt-configs.ts'
// @ts-expect-error 动作身份和内容默认值归唯一引擎编译器。
import { injectionConfigSpec } from '../../engine/rule-spec.mjs'
// @ts-expect-error 分支识别与引擎编译使用同一语法。
import { isBranchNode } from '../../engine/branch.mjs'

export interface RuleInjection {
  rule: RuleDefinition
  action: RuleAction
  config: PromptConfigSpec
}

/** 资产工具只投影注入动作的内容；不读取旧定义或创建第二份配置源。 */
export function ruleInjections(rules: readonly RuleDefinition[] = []): RuleInjection[] {
  const injections: RuleInjection[] = []
  for (const rule of rules) mapRuleInjections(rule, (config, action) => {
    injections.push({ rule, action, config: injectionConfigSpec(rule, action) as PromptConfigSpec })
    return config
  })
  return injections
}

type InjectionPayload = Omit<PromptConfigSpec, 'id'> & { id?: string | null }

/** 写入只映射原始载荷；读取用的身份与默认值投影不回填声明。 */
export function mapRuleInjections(rule: RuleDefinition, map: (config: InjectionPayload, action: RuleAction) => InjectionPayload): RuleDefinition {
  const actions = (list: RuleAction[]): RuleAction[] => list.map(action => {
    if (isBranchNode(action)) return {
      ...action, then: actions(action.then as RuleAction[]),
      ...(action.else === undefined ? {} : { else: actions(action.else as RuleAction[]) }),
    }
    return action.kind === 'inject-text' ? { ...action, config: map({ ...action.config as InjectionPayload }, action) } : action
  })
  return { ...rule, then: actions(rule.then), ...(rule.else === undefined ? {} : { else: actions(rule.else) }) }
}

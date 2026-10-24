/** `rule-facts.mjs` 的客户端消费面；形状按实现写实。 */
import type { RuleAudience } from './audience.mjs'
export type { RuleAudience }

export interface RuleFacts {
  /** 可能受众的上界；undefined = 无法静态收窄，调用方按两个受众处理。 */
  audiences: Set<RuleAudience> | undefined
  /** 是否包含 canonical context-activation 的 inject-text 动作。 */
  contextActivation: boolean
}
export function ruleFacts(rule: unknown): RuleFacts

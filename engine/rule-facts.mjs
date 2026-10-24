/**
 * raw rule 的规则事实（只读）：可能受众 + 是否包含 context activation。
 *
 * 只服务 UI/消费者，不参与执行、不替代 `rule-spec` 的编译与 `audienceOf` 的运行时判据。
 * 纯 ESM，无宿主 import；与 `expandActions` 同构地展开 then/else/嵌套分支，但不编译动作。
 */
import { audienceOf, intersectAudiences, isAudience } from './audience.mjs'
import { conjunction, expandActionsLenient } from './branch.mjs'
import { isFixedRegistration } from './fixed-registration.mjs'
import { record } from './record.mjs'
import { CONTEXT_ACTIVATION_STRATEGY } from './strategy-ids.mjs'

function targetAudiences(action, ruleLayer) {
  // 文档只允许固定 system-section 的 registration target 用 config.audience 收窄；
  // 与引擎共用 isFixedRegistration（含 config.layer ?? rule.layer 回退）。
  if (action.kind !== 'inject-text') return undefined
  const config = record(action.config) ? action.config : undefined
  if (!isFixedRegistration(config, ruleLayer)) return undefined
  const raw = config.audience
  return isAudience(raw) ? new Set([raw]) : undefined
}

function hasContextActivation(expanded) {
  return expanded.some(({ node }) => node.kind === 'inject-text'
    && record(node.config)
    && node.config.strategy === CONTEXT_ACTIVATION_STRATEGY)
}

/**
 * 一条 raw rule 的规则事实。
 *
 * `audiences` 是 then/else/嵌套分支动作可能受众的并集；任一动作无法收窄则整体
 * `undefined`（调用方按两个受众处理）。没有动作时回退到规则级 `if`，让正在编辑的
 * 空卡仍按它的受众条件过滤。`contextActivation` 只识别 `inject-text` 且 strategy
 * 为 canonical context-activation 的动作，不执行选择或注入。
 */
export function ruleFacts(rule) {
  if (!record(rule)) return { audiences: undefined, contextActivation: false }
  const expanded = [
    ...expandActionsLenient(rule.then, { bypass: false }),
    ...expandActionsLenient(rule.else, {
      outer: rule.if === undefined ? [] : [{ not: rule.if }],
      bypass: true,
    }),
  ]
  const when = audienceOf(rule.if)
  if (expanded.length === 0) return { audiences: when, contextActivation: false }
  let audiences
  for (const { node, conditions, bypass } of expanded) {
    const conditioned = intersectAudiences(bypass ? undefined : when, audienceOf(conjunction(conditions)))
    const effective = intersectAudiences(conditioned, targetAudiences(node, rule.layer))
    if (effective === undefined) {
      audiences = undefined
      break
    }
    audiences ??= new Set()
    for (const audience of effective) audiences.add(audience)
  }
  return { audiences, contextActivation: hasContextActivation(expanded) }
}

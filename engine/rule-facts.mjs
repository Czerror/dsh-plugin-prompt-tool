/**
 * raw rule 的只读展示事实：可能受众 + 是否包含 context activation。
 *
 * 只服务 UI/消费者，不参与执行、不替代 `rule-spec` 的编译与 `audienceOf` 的运行时判据。
 * 纯 ESM，无宿主 import；与 `expandActions` 同构地展开 then/else/嵌套分支，但不编译动作。
 */
import { audienceOf } from './audience.mjs'
import { conjunction, expandActionsLenient } from './branch.mjs'
import { CONTEXT_ACTIVATION_STRATEGY } from './strategy-ids.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function targetAudiences(action) {
  const raw = action.kind === 'inject-text'
    ? (record(action.config) ? action.config.audience : undefined)
    : action.audience
  return raw === 'main' || raw === 'subagent' ? new Set([raw]) : undefined
}

function intersect(left, right) {
  if (left === undefined) return right
  if (right === undefined) return left
  return new Set([...left].filter(audience => right.has(audience)))
}

function hasContextActivation(expanded) {
  return expanded.some(({ node }) => node.kind === 'inject-text'
    && record(node.config)
    && node.config.strategy === CONTEXT_ACTIVATION_STRATEGY)
}

/**
 * 一条 raw rule 的展示事实。
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
    const conditioned = intersect(bypass ? undefined : when, audienceOf(conjunction(conditions)))
    const effective = intersect(conditioned, targetAudiences(node))
    if (effective === undefined) {
      audiences = undefined
      break
    }
    audiences ??= new Set()
    for (const audience of effective) audiences.add(audience)
  }
  return { audiences, contextActivation: hasContextActivation(expanded) }
}

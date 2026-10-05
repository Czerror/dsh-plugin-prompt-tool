/**
 * 规则节点（动作 / 分支）的分类、摘要与计数：折叠卡上的文字只从真值派生，不存第二份。
 *
 * 引擎真值（engine/branch.mjs#expandActions）：动作的生效条件 = 根到该节点路径上
 * 所有 `if` 的合取；分支 `then` 侧继承「父链 ∧ 本层 if」，`else` 侧继承「父链 ∧ ¬本层 if」。
 * 所以界面按「一个条件作用域 = 一张卡」组织，不存在「第 i 个条件配第 i 个动作」。
 */
import type { RuleAction, RuleCondition } from '../../../shared/rules.ts'
import type { PromptToolLocaleKey, PromptToolTranslate } from '../../locales.ts'
import { triggerLabel } from './rule-labels.ts'
import {
  AUDIENCE_LABEL_KEYS, LAYER_LABEL_KEYS, MODEL_SCOPE_LABEL_KEYS, POSITION_LABEL_KEYS,
  PROMOTION_LABEL_KEYS, STRATEGY_LABEL_KEYS, SUBJECT_LABEL_KEYS, translateLabel,
} from './prompt-config-policy.ts'

/** 一个 `then`／`else` 项：动作，或内嵌 `if/then/else` 的分支（引擎允许任意嵌套）。 */
export type RuleNode = RuleAction | RuleBranch
export interface RuleBranch extends Record<string, unknown> {
  if?: RuleCondition
  then: RuleNode[]
  else?: RuleNode[]
}

export const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** 动作节点的判据只有 `kind`；分支与无法识别的节点都没有它。 */
export const isActionNode = (node: unknown): node is RuleAction => {
  const kind = asRecord(node).kind
  return typeof kind === 'string' && kind.length > 0
}
export const isBranchNode = (node: unknown): node is RuleBranch => !isActionNode(node) && Array.isArray(asRecord(node).then)
/** 既不是动作也不是分支：保留原值走 JSON 编辑，绝不猜成动作。 */
export const isUnknownNode = (node: unknown): boolean => !isActionNode(node) && !isBranchNode(node)
export const nodeList = (value: unknown): RuleNode[] => Array.isArray(value) ? value as RuleNode[] : []

/** 摘要里的枚举上限：超过就退化成「前两项 等 N 项」，卡头永远单行。 */
const SUMMARY_LIMIT = 2

/** 值以内联标签显示的技术键；缺省时按原值显示。 */
const VALUE_LABEL_KEYS: Record<string, Record<string, PromptToolLocaleKey>> = {
  subject: SUBJECT_LABEL_KEYS,
  audience: AUDIENCE_LABEL_KEYS,
  modelScope: MODEL_SCOPE_LABEL_KEYS,
  // 层键集由共享契约的联合类型约束，这里只当字符串索引读。
  layer: LAYER_LABEL_KEYS as Record<string, PromptToolLocaleKey>,
  strategy: STRATEGY_LABEL_KEYS,
  position: POSITION_LABEL_KEYS,
  promotion: PROMOTION_LABEL_KEYS,
}

function clipped(t: PromptToolTranslate, items: readonly string[], separator: string): string {
  if (items.length <= SUMMARY_LIMIT) return items.join(separator)
  return t('rules.steps.more', { head: items.slice(0, SUMMARY_LIMIT).join(separator), count: items.length })
}

function valueText(t: PromptToolTranslate, key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? t('rules.steps.yes') : t('rules.steps.no')
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    const keys = VALUE_LABEL_KEYS[key]
    return keys === undefined ? value : translateLabel(t, keys, value)
  }
  if (Array.isArray(value)) return clipped(t, value.map(item => valueText(t, key, item)), t('rules.steps.listSeparator'))
  const entries = Object.entries(asRecord(value))
  if (entries.length === 0) return ''
  return clipped(t, entries.map(([field, item]) => `${triggerLabel(t, field)}=${valueText(t, field, item)}`), t('rules.steps.listSeparator'))
}

/** 单个条件（含组合递归）的摘要；畸形条件退化为项数，不猜结构。 */
export function conditionSummary(t: PromptToolTranslate, condition: RuleCondition | undefined): string {
  if (condition === undefined) return t('triggers.unconditional')
  const record = asRecord(condition)
  const kinds = Object.keys(record)
  if (kinds.length !== 1) return t('rules.steps.complex', { count: kinds.length })
  const kind = kinds[0]!
  const value = record[kind]
  if (kind === 'not') return t('rules.steps.not', { value: conditionSummary(t, asRecord(value)) })
  if (kind === 'all' || kind === 'any' || kind === 'notAny') {
    const children = nodeList(value).map(child => conditionSummary(t, asRecord(child)))
    if (children.length === 0) return triggerLabel(t, kind)
    if (kind === 'all') return clipped(t, children, ` ${t('rules.steps.and')} `)
    const joined = clipped(t, children, ` ${t('rules.steps.or')} `)
    return kind === 'any' ? joined : t('rules.steps.not', { value: joined })
  }
  const detail = valueText(t, kind, value)
  return detail.length === 0 ? triggerLabel(t, kind) : t('rules.steps.condition', { kind: triggerLabel(t, kind), detail })
}

/** 注入正文的首行摘要：去掉 Markdown 标题记号与空行，超长截断。 */
function textLead(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[#>\s*-]+/, '').trim()
    if (line.length > 0) return line.length > 28 ? `${line.slice(0, 28)}…` : line
  }
  return ''
}

/** 动作摘要：类型 + 执行层 + 策略 + 正文首行（或 request-params 的覆盖项）。 */
export function actionSummary(t: PromptToolTranslate, action: RuleAction): string {
  const config = asRecord(action.config)
  const parts = [triggerLabel(t, String(action.kind))]
  if (typeof config.layer === 'string' && config.layer.length > 0) parts.push(translateLabel(t, LAYER_LABEL_KEYS as Record<string, PromptToolLocaleKey>, config.layer))
  if (typeof config.strategy === 'string' && config.strategy.length > 0) parts.push(translateLabel(t, STRATEGY_LABEL_KEYS, config.strategy))
  const lead = typeof config.text === 'string' ? textLead(config.text) : ''
  if (lead.length > 0) parts.push(lead)
  else {
    const entries = Object.entries(asRecord(config.patch)).filter(([, value]) => value !== undefined && value !== '')
    if (entries.length > 0) parts.push(clipped(t, entries.map(([key, value]) => `${key}=${valueText(t, key, value)}`), t('rules.steps.listSeparator')))
  }
  return parts.join(' · ')
}

/** 分支卡头：`当 ⟨条件⟩ → ⟨动作⟩`；单个动作时直接写该动作，多动作写条数。 */
export function branchSummary(t: PromptToolTranslate, branch: RuleBranch): string {
  const then = nodeList(branch.then)
  const otherwise = nodeList(branch.else)
  const lead = then.length === 1 && otherwise.length === 0 && isActionNode(then[0])
    ? actionSummary(t, then[0])
    : t('rules.steps.actionCount', { count: then.length })
  return t('rules.steps.branch', { condition: conditionSummary(t, branch.if), actions: lead })
}

export function nodeSummary(t: PromptToolTranslate, node: RuleNode): string {
  if (isActionNode(node)) return actionSummary(t, node)
  if (isBranchNode(node)) return branchSummary(t, node)
  return t('rules.steps.unknown')
}

/** 递归统计生效动作数与分支数（卡头摘要用）。 */
export function countNodes(nodes: readonly RuleNode[]): { actions: number; branches: number } {
  return nodes.reduce((total, node) => {
    if (!isBranchNode(node)) return { actions: total.actions + 1, branches: total.branches }
    const then = countNodes(nodeList(node.then))
    const otherwise = countNodes(nodeList(node.else))
    return {
      actions: total.actions + then.actions + otherwise.actions,
      branches: total.branches + 1 + then.branches + otherwise.branches,
    }
  }, { actions: 0, branches: 0 })
}

/** 整条规则已用的动作 id：嵌套后新建动作必须在**全规则**范围内唯一（引擎拒绝重复 id）。 */
export function collectActionIds(nodes: readonly RuleNode[], into: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (isActionNode(node)) into.add(node.id)
    else if (isBranchNode(node)) { collectActionIds(nodeList(node.then), into); collectActionIds(nodeList(node.else), into) }
  }
  return into
}

/** 叶子节点数（含组合条件展开）与作用域条件计数，供卡头摘要。 */
export function countConditions(condition: RuleCondition | undefined): number {
  if (condition === undefined) return 0
  const record = asRecord(condition)
  const kind = Object.keys(record)[0]
  if (kind === 'all' || kind === 'any' || kind === 'notAny') {
    return nodeList(record[kind]).reduce((total, child) => total + countConditions(asRecord(child)), 0)
  }
  if (kind === 'not') return countConditions(asRecord(record.not))
  return 1
}

/** 路径上带条件的叶子动作：这些动作必须是 event 生命周期，否则引擎拒绝（rule-spec.mjs:143）。 */
export function conditionalActions(nodes: readonly RuleNode[], inherited = false, into: RuleAction[] = []): RuleAction[] {
  for (const node of nodes) {
    if (isActionNode(node)) { if (inherited) into.push(node); continue }
    if (isBranchNode(node)) {
      const inner = inherited || node.if !== undefined
      conditionalActions(nodeList(node.then), inner, into)
      conditionalActions(nodeList(node.else), inner, into)
    }
  }
  return into
}

/**
 * JSON 面板的结构门槛：动作要有非空 `id` + `kind`，分支要有 `then` 数组（可递归嵌套）。
 * 分支节点没有 `kind`，不能再用「每个 then 项都必须是动作」判定，否则合法规则被报成非法 JSON。
 */
export function isValidNode(node: unknown): boolean {
  if (isBranchNode(node)) {
    const record = asRecord(node)
    return nodeList(record.then).every(isValidNode) && nodeList(record.else).every(isValidNode)
  }
  const record = asRecord(node)
  return isActionNode(node) && typeof record.id === 'string' && record.id.length > 0
}

/** 生效条件链：从根到该节点的所有条件用「且」连接，放进卡头提示逐字可读。 */
export function conditionChain(t: PromptToolTranslate, chain: readonly RuleCondition[]): string {
  return t('rules.steps.chain', { chain: chain.map(item => conditionSummary(t, item)).join(` ${t('rules.steps.and')} `) })
}

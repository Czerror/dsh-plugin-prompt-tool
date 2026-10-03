import type { EngineLayer } from './engine-capabilities.ts'

/** 仅离线迁移读取；新模型路由与采样参数必须写 request-params 动作。 */
export const RULE_OWNED_MODEL_PARAMS = [
  'modelProvider', 'modelName', 'modelReasoningEffort', 'modelTemperature', 'modelMaxTokens',
  'subagentModelProvider', 'subagentModelName', 'subagentReasoningEffort', 'subagentTemperature', 'subagentMaxTokens',
] as const

/** 一张独立配置卡的判断树；原语与组合的合法形状由引擎唯一校验。 */
export type RuleCondition = Record<string, unknown>

/** 动作拥有稳定身份；其执行点由动作目录推导，不能任意指定宿主事件。 */
export interface RuleAction extends Record<string, unknown> {
  id: string
  kind: string
  channelOrder?: number
  waterfallPosition?: 'default' | 'outermost'
}

/** module.yml.rules 的单一规则定义；层用于呈现归属，不建立跨层执行顺序。 */
export interface RuleDefinition {
  id: string
  name?: string
  enabled?: boolean
  layer?: EngineLayer
  group?: string
  exclusive?: boolean
  when?: RuleCondition
  do: RuleAction[]
}

/** 显式旧身份使改名、删除与 configOrder 在同一事务中更新。 */
export interface RuleEdit {
  previousId: string | null
  rule: RuleDefinition | null
}

export interface RulesRequest {
  expectedPresetId: string
  expectedRevision?: string
  edits?: RuleEdit[]
  /** 显式启用目标；保存端同时停用同模块互斥组的其他卡。 */
  activateRuleId?: string
  validateOnly?: boolean
}

export interface RuleEditorMeta {
  predicates: Array<{ kind: string; example: Record<string, unknown> }>
  composites: string[]
  actions: Array<{
    kind: string
    example: Record<string, unknown>
    channel: string
    phase: string
    supportsWhen: boolean
    lifecycle?: 'event' | 'registration'
  }>
  waterfallPositions: string[]
}

export interface RulesSnapshot {
  rules: RuleDefinition[]
  revision: string
  meta: RuleEditorMeta
}

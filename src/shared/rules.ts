import type { EngineLayer } from './engine-capabilities.ts'

/** 一张独立配置卡的判断树；原语与组合的合法形状由引擎唯一校验。 */
export type RuleCondition = Record<string, unknown>

/** 动作拥有稳定身份；其执行点由动作目录推导，不能任意指定宿主事件。 */
export interface RuleAction extends Record<string, unknown> {
  id: string
  kind: string
  channelOrder?: number
  waterfallPosition?: 'default' | 'outermost'
}

/**
 * module.yml.rules 的单一规则定义；层是动作未声明 `config.layer` 时的缺省注入层，其余用于展示，不建立跨层执行顺序。
 *
 * **旧名 `when`/`do` 已随引擎重构退役**（不再作为兼容输入），全链路只有 `if`/`then`/`else`。
 * 定义迁移由 YAML Document API 改键名完成，注释与未知字段原地保留。
 */
export interface RuleDefinition {
  id: string
  name?: string
  enabled?: boolean
  layer?: EngineLayer
  group?: string
  exclusive?: boolean
  /** 分支条件；缺省 = 无条件。 */
  if?: RuleCondition
  /** 动作列表。 */
  then: RuleAction[]
  /** `if` 不命中时执行；与 `then` 结构互斥（编译期按 `not(if)` 展开）。 */
  else?: RuleAction[]
}

/** 显式旧身份使改名、删除与 configOrder 在同一事务中更新。 */
export interface RuleEdit {
  previousId: string | null
  rule: RuleDefinition | null
  /** 正文编辑不拥有启停与互斥状态；修改状态须显式声明并校验 settings 版本。 */
  settingsChanged?: boolean
}

export interface RuleRevisions {
  rules: Record<string, string>
  settings: string
  variables: string
}
export type RuleContent = Omit<RuleDefinition, 'enabled' | 'group' | 'exclusive'>
export interface RuleSettings { order: number; enabled?: boolean; group?: string; exclusive?: boolean }

export interface RulesRequest {
  expectedModuleId?: string
  expectedRevision?: string
  expectedRevisions?: Partial<RuleRevisions>
  edits?: RuleEdit[]
  /** 显式启用目标；保存端同时停用同模块互斥组的其他卡。 */
  activateRuleId?: string
  validateOnly?: boolean
  /** 只重新发布已提交定义，不能与规则修改或候选校验混用。 */
  refreshOnly?: boolean
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
  revisions: RuleRevisions
  /** 仅旧客户端兼容输入，不是规范响应的版本来源。 */
  revision?: string
  meta: RuleEditorMeta
  persisted?: boolean
  publicationPending?: boolean
  publicationError?: string
}

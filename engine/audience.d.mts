/** 条件树 → 受众事实的纯模块声明；RuleAudience 的唯一声明处。 */
export type RuleAudience = 'main' | 'subagent'
export function audienceOf(tree: unknown): Set<RuleAudience> | undefined

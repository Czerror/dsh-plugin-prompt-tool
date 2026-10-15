/** `order.mjs` 的手写声明：只声明 `src/` 消费的导出。 */

/** 排序所需的身份字段；仅覆盖插件依赖面（其余字段引擎不读）。 */
export interface ConfigSequenceLike {
  id: string
  sequence?: number
  order?: number
  sourceModuleId?: string
  ruleId?: string
  ruleActionIndex?: number
}

/** 模块配置的执行顺序：`sequence`（回退 `order`）优先，其次模块与规则身份。 */
export function compareConfigSequence(a: ConfigSequenceLike, b: ConfigSequenceLike): number

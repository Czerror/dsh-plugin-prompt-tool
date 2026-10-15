/** `tool-definition.mjs` 的手写声明：只声明 `src/` 消费的导出。 */

/** 完整定义校验；非法定义抛 `TypeError`，合法定义无返回值。 */
export function validateDefinition(def: unknown): void

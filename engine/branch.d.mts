/** `branch.mjs` 的手写声明：只声明 `src/` 消费的导出。 */

/** 分支节点：占动作位、没有 `kind`，但带 `if`/`then`/`else` 之一。 */
export function isBranchNode(node: unknown): boolean

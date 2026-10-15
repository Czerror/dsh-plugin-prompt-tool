/** `interpolate.mjs` 的手写声明：只声明 `src/` 消费的导出。 */

/** 保留名判据（内建变量 + 动态宏）；任何值都接受，非字符串按空名处理。 */
export function isReservedInterpolationName(key: unknown): boolean

/** ST 宏写法归一（`{{roll 1d6}}` / `{{roll:1d6}}` → `{{roll::1d6}}`），幂等。 */
export function normalizeMacroSyntax(text: string): string

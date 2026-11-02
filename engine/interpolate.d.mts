/** `interpolate.mjs` 的手写声明：只声明 `src/` 消费的导出。 */

/** 保留名判据（内建变量 + 动态宏）；任何值都接受，非字符串按空名处理。 */
export function isReservedInterpolationName(key: unknown): boolean

/** ST 宏写法归一（`{{roll 1d6}}` / `{{roll:1d6}}` → `{{roll::1d6}}`），幂等。 */
export function normalizeMacroSyntax(text: string): string

/** 已声明变量与内建宏插值；可选白名单保留给官方变量通道。 */
export function interpolateVariables(text: string, variables: Readonly<Record<string, unknown>>, session?: unknown, keep?: ReadonlySet<string>, sourceId?: string, literalKeys?: ReadonlySet<string>): string

/** 官方严格插值前移除未解析引用，并返回被移除的片段。 */
export function stripUnresolvedRefs(text: string, keep?: ReadonlySet<string>): { text: string; stripped: string[] }

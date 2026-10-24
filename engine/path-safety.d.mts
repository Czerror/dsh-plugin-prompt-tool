/** `path-safety.mjs` 的手写声明：只声明 `src/` 消费的导出。 */
export function resolveRealWithin(target: string, roots: readonly string[], label?: string): string

/** `conditions/index.mjs` 的手写声明：只声明 `src/` 消费的导出。 */

/** 官方 `standingMountFor` 的挂载事实；仅覆盖插件依赖面（引擎只读 `presetId`）。 */
export interface StandingMount {
  presetId?: string
}

/** 官方 `@deepseek-ai/dsh-agent-preset-registry` 的 `standingMountFor` 导出。 */
export type StandingMountFor = (ctx: unknown) => StandingMount | undefined

/**
 * 惰性解析官方 `standingMountFor`：包缺席（最小组合、测试）返回 `undefined`，
 * 不是错误——此时没有兜底，预设条件判定恒不命中。
 */
export function loadStandingMountFor(entry?: string): Promise<StandingMountFor | undefined>

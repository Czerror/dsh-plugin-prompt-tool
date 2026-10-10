/**
 * trigger — 触发器的两个运行时设施：waterfall 位置取值，与观察者谓词的会话事件接线。
 *
 * 本文件不承担声明校验、排序与注册：那些归 `rule-spec.mjs`（编译）与 `rule-runtime.mjs`
 * （挂载）——规则是唯一的声明载体，`engine/rules` 之外没有第二条触发通道。
 *
 * ## waterfallPosition 为什么与 channelOrder 分开
 *
 * 官方 Cordis（`node_modules/@deepseek-ai/cordis/src/events.ts`）**没有数字排序**：
 *   - `register()` 只做 `options.prepend ? 'unshift' : 'push'`；
 *   - `waterfall()` 用 `cbs.shift()` 从链首取，所以 unshift 的监听器最先执行（最外层），
 *     而**多个 prepend 之间后注册的更靠前**；不调用 `next()` 的监听器会否决其后整条链。
 *
 * 因此两个字段互不混淆，**不得**用一个字段同时承担两件事：
 *   - `channelOrder: number` —— 同一通道内的声明顺序，由 `rule-spec.mjs` 做有界稳定排序；
 *   - `waterfallPosition` —— 在宿主 waterfall 中的位置，只有 `'outermost'` 映射为 `prepend: true`。
 *
 * 跨九层的全局调度禁止：官方九层插入点彼此独立，`prepend` 也不得替代 `ctx.tools.guard()`
 * 的单调边界。
 */

/** 声明里的合法位置取值（与 events.ts 的布尔注册策略一一对应）。 */
export const WATERFALL_POSITIONS = new Set(['default', 'outermost'])

/**
 * 把 `session/event` 喂给带 `observe(session, event)` 入口的谓词（相位 / 计数两类）。
 *
 * 同一组观察者**共用一条**监听（不按规则各接一条，避免 N 倍监听）；没有这类谓词时
 * **不接**（返回 `undefined`，零开销）。观察者自身抛错只告警、不影响其它观察者
 * ——与判定失败的降级纪律一致。
 *
 * 由 `rule-runtime.mjs` 的 `mountRuleSources` 接线：规则条件里的观察者谓词共用这一条监听。
 *
 * @returns disposer，或 `undefined`（本组无观察者）
 */
export function wireTriggerObservers(ctx, triggers, { plugin, warnOnce } = {}) {
  const warn = typeof warnOnce === 'function' ? warnOnce : () => {}
  const observers = triggers.filter((trigger) => typeof trigger.when?.observe === 'function')
  if (observers.length === 0) return undefined
  return ctx.on('session/event', (session, event) => {
    for (const trigger of observers) {
      try {
        trigger.when.observe(session, event)
      } catch (error) {
        warn(`${plugin}: trigger ${trigger.id} observe failed: ${String(error?.message ?? error)}`)
      }
    }
  })
}

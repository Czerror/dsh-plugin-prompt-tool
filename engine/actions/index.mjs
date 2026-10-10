import { createWarnOnce, keepDisposer } from '../shared.mjs'
import { labelOf } from './shared.mjs'
import { ACTION_KINDS } from './catalog.mjs'
import { actionSupportsWhen, actionExecutionPoint, createTurnBudget, withWhen, channelBinder } from './registration.mjs'
import { prepareInjectText } from './inject-text.mjs'
import { prepareAssembly } from './assembly.mjs'
import { prepareDecision } from './decision.mjs'
import { prepareAppendContext } from './append-context.mjs'
import { prepareGuard } from './guard.mjs'
import { prepareToolNarrow } from './tool-narrow.mjs'
import { prepareSdkStrip } from './sdk-strip.mjs'
import { prepareRequestParams } from './request-params.mjs'
import { prepareInboxPrepend } from './inbox-prepend.mjs'
import { preparePreStepFilter } from './pre-step-filter.mjs'
export { ACTION_KINDS, ACTION_DEGRADE } from './catalog.mjs'
export { actionSupportsWhen, actionExecutionPoint } from './registration.mjs'
const DEFAULT_PLUGIN = 'prompt-actions'

const PREPARERS = {
  'inject-text': prepareInjectText,
  assembly: prepareAssembly,
  decision: prepareDecision,
  'append-context': prepareAppendContext,
  guard: prepareGuard,
  'tool-narrow': prepareToolNarrow,
  'sdk-strip': prepareSdkStrip,
  'request-params': prepareRequestParams,
  'inbox-prepend': prepareInboxPrepend,
  'pre-step-filter': preparePreStepFilter,
}

/**
 * 注入整批编译与动作准备共用选项校验；不装配服务，也不单独编译注入叶子。
 *
 * @param action `{ kind, id?, ... }`，形状见 {@link ACTION_KINDS}。
 * @param options.plugin 调用方插件名（错误消息 / 告警 / disposer 标签），与
 *   `mountTriggers(ctx, declarations, { plugin })` 同一约定；缺省 `prompt-actions`。
 * @param options.warnOnce 复用宿主模块的告警器；缺省为本文件自己的 warnOnce。
 * @param options.when 可选判定：不命中（非 `true`）即放行下游、不执行本动作。仅对
 *   {@link ON_REGISTERED_KINDS} 里的动作有效；对 `inject-text` / `guard` 传它会挂载期报错
 *   （那两类不走 `on(...)`，静默忽略就是"配了没效果"）。
 * @param options.prepend 让本动作落在宿主 waterfall 的**最外层**（否决型动作需要）。同样只对
 *   `ON_REGISTERED_KINDS` 有效；它表达的是**位置**，不承担声明之间的排序。
 * @param options.promptConfigOptions 宿主提供的 createPromptConfigs 选项（模板基准和策略目录），不从动作数据读取。
 * @returns 已校验的动作类别与调用方插件名。
 */
export function validateActionOptions(action, options = {}) {
  const kind = action?.kind
  const plugin = typeof options.plugin === 'string' && options.plugin.length > 0 ? options.plugin : DEFAULT_PLUGIN
  if (!Object.hasOwn(ACTION_KINDS, kind)) {
    throw new TypeError(`${plugin}: unknown action kind ${JSON.stringify(kind)} — known kinds: ${Object.keys(ACTION_KINDS).join(', ')}`)
  }
  if (!actionSupportsWhen(kind) && (options.when !== undefined || options.prepend === true)) {
    const feature = options.when !== undefined ? 'a when predicate' : 'prepend'
    throw new TypeError(`${plugin}: action ${kind} does not support ${feature} — 它不经 on(...) 注册（inject-text 注册层、guard 注册 agent scope 的最终拒绝）`)
  }
  // `maxPerTurn` 与 `when` 的支持面相同：都只对经 `on(...)` 注册的动作有效。
  if (!actionSupportsWhen(kind) && action?.maxPerTurn !== undefined) {
    throw new TypeError(`${plugin}: action ${kind} does not support maxPerTurn — 它不经 on(...) 注册`)
  }
  const max = action?.maxPerTurn
  if (max !== undefined && (!Number.isSafeInteger(max) || max <= 0)) {
    throw new TypeError(`${labelOf(action)}.maxPerTurn must be a positive integer`)
  }
  return { kind, plugin }
}

/** 纯准备阶段返回真实 ctx 的绑定函数；options.on 可由统一规则收集实际执行点。 */
export function prepareAction(action, options = {}) {
  const { kind, plugin } = validateActionOptions(action, options)
  const max = action?.maxPerTurn
  // 第 4 参是共享续跑预算：只有 append-context 的 continue 消费它（同模块一份），
  // 其余准备器忽略。缺省 undefined 时该准备器自己新建，旧路径不变。
  const bind = PREPARERS[kind](action, plugin, options.promptConfigOptions, options.turnStopBudget)
  const phase = actionSupportsWhen(kind) ? actionExecutionPoint(action).phase : undefined
  return (ctx) => {
    const warnOnce = options.warnOnce ?? createWarnOnce(ctx, plugin)
    const budget = createTurnBudget(max)
    const on = withWhen(options.on ?? channelBinder(ctx, kind, plugin, options.prepend === true), options.when, warnOnce, phase)
    const disposers = []
    const collect = (disposer) => { if (typeof disposer === 'function') disposers.push(disposer) }
    // 每轮预算的轮边界由 durable 事件驱动（与谓词的 observe 同一事件源，但**独立记账**：
    // 预算是「本动作生效次数」，不是 durable 事件计数）。
    if (budget !== undefined) collect(ctx.on('session/event', (session, event) => budget.observe(session, event)))
    const take = (subject) => budget?.take(subject) ?? true
    bind?.(ctx, { warnOnce, on, collect, take })
    const dispose = () => {
      for (const release of disposers.splice(0)) {
        try {
          release()
        } catch {
          // 释放失败不得反过来打断卸载流程。
        }
      }
    }
    keepDisposer(ctx, dispose, `${plugin}: action ${labelOf(action)}`)
    return dispose
  }
}

/** 校验后把动作接到其合法通道，返回释放函数。 */
export function registerAction(ctx, action, options = {}) {
  return prepareAction(action, options)(ctx)
}

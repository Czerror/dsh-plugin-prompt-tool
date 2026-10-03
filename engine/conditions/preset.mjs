import { importHostPackage } from '../host-package.mjs'
import { getService } from '../shared.mjs'
import { agentOf } from './subject.mjs'
import { UNAVAILABLE } from './availability.mjs'

const AGENT_PRESETS_PACKAGE = '@deepseek-ai/dsh-agent-preset-registry'

/**
 * 当前预设 id（进程内判定；官方唯一正确取法）。
 *
 *     const id = ctx.get?.('agentPresets')?.composedPreset?.(agent.ctx)   // 首选
 *       ?? standingMountFor(agent.ctx)?.presetId                          // 服务未就绪时的同源兜底
 *
 * 依据：官方 0.1.7 的 `agent-preset-registry/src/index.ts` 中 composedPreset
 * 直接包装 `standingMountFor(agentCtx)?.presetId`；mount.ts 读取 live scope chain，
 * invariant.ts 也以该结果判定 agent 是否已绑定预设，不依赖事件落盘。
 *
 * 三条硬约束（改这里之前先读 PLAN 的「审查结论」）：
 *  1. **禁止读 `session.header.agentPreset`**——它是出生预设。官方 `agent-preset-registry/src/session.ts`
 *     明写「Reconstruction reads the `agentPreset` Session projection, never the header alone」，
 *     投影初值取自 header、之后由 `agent-preset/selected` 推进；真机实测亦有 header 与
 *     实际挂载不一致的案例。
 *  2. **禁止用 registry 的 defaultId** 当当前预设——它是
 *     **新会话的默认值**，与任何已存在 agent 的挂载无关。
 *  3. **`undefined` 的含义是「该 agent 没有预设」**（裸 agent），不是「取不到」；
 *     **不得回退到默认值**，调用方按「不干预 / 不命中」处理。
 *
 * 适用边界：`composedPreset` 只在**进程内、拿得到 `agent.ctx`** 时可用（装配期
 * `context.agent.ctx`、子代理认领、引擎能力）。跨 API/客户端边界没有这个方法——
 * 官方 `ctx.remote.agentPresets` 提供 `list / select` 等远程操作，
 * 客户端拿不到 `agent.ctx` 也无法用本方法。**两种取法是分工而非替代**：
 * 进程内判定用本函数，跨边界用会话投影（`sessionProjections.stateOf(session, 'agentPreset')`）。
 *
 * @param {object|undefined} ctx 插件/运行时 ctx（服务查询基准）
 * @param {{ctx?: unknown}|undefined} agent 判定对象（读它的 `ctx` = agent scope context）
 * @param {Function} [standingMountFor] 官方模块导出兜底（服务未就绪时用）
 * @returns {string|undefined} 预设 id；`undefined` = 该 agent 没有预设
 */
export function agentPresetId(ctx, agent, standingMountFor) {
  try {
    const service = getService(ctx, 'agentPresets')
    const composed = typeof service?.composedPreset === 'function'
      ? service.composedPreset(agent?.ctx)
      : undefined
    if (composed !== undefined && composed !== null) return composed
    const mount = typeof standingMountFor === 'function' ? standingMountFor(agent?.ctx) : undefined
    return mount?.presetId
  } catch {
    // 判定不抛出：拿不到就是「没有预设」（不命中），与 condition.mjs 的降级纪律一致。
    return undefined
  }
}

/**
 * 惰性解析官方 `standingMountFor`（挂载期一次，判定期零 IO）。
 * 官方包缺席（最小组合、测试环境）＝没有兜底，不是错误：此时服务缺席即判定恒 undefined。
 * @param {string} [entry] 解析基准（缺省按宿主入口解析；测试/嵌入可显式指定）
 * @returns {Promise<Function|undefined>}
 */
export async function loadStandingMountFor(entry) {
  try {
    const module = await importHostPackage(AGENT_PRESETS_PACKAGE, entry)
    return typeof module?.standingMountFor === 'function' ? module.standingMountFor : undefined
  } catch {
    return undefined
  }
}

/**
 * 当前预设判断：`agentPresetId(...) === presetId`。
 *
 * `ctx` 在**构造期**绑定（服务查询基准，通常是触发器运行时的插件 ctx）；
 * 判定只读 payload（agent）。无可确定的当前预设事实时保持 UNAVAILABLE，not 也不能放行。
 *
 * @param {object} options
 * @param {string} options.presetId 目标预设 id
 * @param {object} [options.ctx] 插件/运行时 ctx
 * @param {Function} [options.standingMountFor] 官方模块导出兜底
 * @returns {(agent: unknown) => boolean|symbol}
 */
export function createPresetPredicate(options = {}) {
  const presetId = options.presetId
  if (typeof presetId !== 'string' || presetId.length === 0) {
    throw new TypeError('predicates: a preset predicate needs a presetId')
  }
  const ctx = options.ctx
  const standingMountFor = options.standingMountFor
  const predicate = (payload) => {
    const current = agentPresetId(ctx, agentOf(payload), standingMountFor)
    return typeof current === 'string' && current.length > 0 ? current === presetId : UNAVAILABLE
  }
  predicate.kind = 'preset'
  return predicate
}

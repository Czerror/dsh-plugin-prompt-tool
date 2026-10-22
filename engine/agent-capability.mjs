/**
 * Agent 级能力声明原语：受众判定 + Agent scope 声明/撤销 + 条件翻转的幂等重挂。
 *
 * 只收这三件事。冲突检测与晚到服务等待留给调用方：presentAs 的同 scope 二次声明是
 * 官方抛错语义，ptcRuntime 的晚到等待是一次性声明；把它们塞进同一接口会逼出模式开关。
 *
 * 键是 session：同一个 session 可以换 scope（预设重绑），scope 或能力自己的 key 任一
 * 变化都先挂新声明、成功后再撤旧的；mount 返回 undefined 表示依赖尚未就绪，保留旧声明、
 * 下次装配重试（旧闸比无闸安全）。不用 shared.mjs 的 sessionState：闸必须确定性撤销，
 * 不能按容量淘汰。
 */
import { isDelegated } from './shared.mjs'

/** 受众判定：delegationDepth > 0 即子代理（与 shared.mjs 的 isDelegated 同一判据）。 */
export function capabilityAudience(agent) {
  return isDelegated(agent?.session) ? 'subagent' : 'main'
}

/**
 * 建一个按 Agent 管理的声明表。
 *
 * @param mount - `(agent) => { disposers, data? } | undefined`：在 agent.ctx 上声明能力并
 *   返回撤销器；返回 undefined 表示这次没挂上（依赖未就绪），不记状态、下次 sync 重试。
 * @returns `{ sync(agent, key), get(session), release(session), releaseAll() }`
 */
export function createAgentCapability(mount) {
  /** session -> { scope, key, disposers, data }；条件翻转或 mask 变化时先撤再挂。 */
  const states = new Map()

  const release = (session) => {
    const state = states.get(session)
    if (state === undefined) return
    states.delete(session)
    for (const dispose of state.disposers.splice(0)) {
      try { dispose() } catch { /* 释放失败不得反过来打断卸载 */ }
    }
  }
  const releaseAll = () => { for (const session of [...states.keys()]) release(session) }

  const sync = (agent, key) => {
    const session = agent?.session
    const scope = agent?.ctx
    if (session === undefined || scope === undefined) return undefined
    const existing = states.get(session)
    if (existing !== undefined && existing.scope === scope && existing.key === key) return existing
    // 依赖未就绪时保留旧闸：先挂新声明，成功后再撤旧的；mount 返回 undefined 直接退出。
    const mounted = mount(agent)
    if (mounted === undefined) return existing
    release(session)
    const state = { scope, key, disposers: mounted.disposers ?? [], data: mounted.data }
    states.set(session, state)
    // 子代理与重绑都换 scope：父 mount 释放必须能撤销，scope 释放只移出自己。
    if (typeof scope.effect === 'function') {
      scope.effect(() => () => { if (states.get(session) === state) release(session) })
    }
    return state
  }

  return {
    sync,
    get: (session) => states.get(session),
    release,
    releaseAll,
  }
}

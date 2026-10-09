import { KNOWN_AUDIENCES } from '../schema.mjs'
import { labelOf, createMask, RUN_CODE } from './shared.mjs'

/**
 * guard 受众判据的唯一来源：省略 / `null` / `''` / `'all'` = 通用
 * （`'all'` 是编辑器侧的通用档，运行期判据只看 `=== 'subagent'`，见 Ruling 12）；
 * `main` / `subagent` 取自 schema 的 `KNOWN_AUDIENCES`——编辑器枚举的权威来源。
 */
const GUARD_AUDIENCES = new Set([undefined, null, '', 'all', ...KNOWN_AUDIENCES])

export function prepareGuard(action, plugin) {
  const label = labelOf(action)
  // 保存 / 导入即拒绝（与 createMask 同处）：拼错取值今天会静默退化成「通用」。
  if (!GUARD_AUDIENCES.has(action.audience)) {
    throw new TypeError(`${plugin}: ${label}.audience must be main or subagent (null / 省略 / 'all' = 通用) — got ${JSON.stringify(action.audience)}`)
  }
  // 信任边界：只接受布尔值（缺省 = false），显式 `'yes'` / `1` / `null` 等一律拒绝，
  // 与下面 audience 的严格化对称；静默当 false 会让「写了却没生效」无法察觉。
  if (action.includeSubagents !== undefined && typeof action.includeSubagents !== 'boolean') {
    throw new TypeError(`${plugin}: ${label}.includeSubagents must be a boolean (省略 = false) — got ${JSON.stringify(action.includeSubagents)}`)
  }
  // `audience:'subagent'` 只在子代理分支注册，而子代理分支还要求 `includeSubagents:true`；
  // 缺它时两条分支都不注册（永不生效），所以这是矛盾组合而非缺省。
  if (action.audience === 'subagent' && action.includeSubagents !== true) {
    throw new TypeError(`${plugin}: ${label}: audience:'subagent' 需配 includeSubagents:true — 缺省时该 guard 在主会话与子代理两侧都不注册`)
  }
  const mask = createMask(action.mask ?? action, `${label}.mask`, plugin)
  const includeSubagents = action.includeSubagents === true
  const reasonFor = (toolName) => String(action.reason ?? `${label}: tool ${JSON.stringify(toolName)} is denied by action`)

  return (_ctx, { warnOnce, on, collect }) => {
    /** session -> { ctx, disposers }：同一 agent.ctx 只注册一次，重绑后按新 ctx 重注册。 */
    const appliedBySession = new WeakMap()
    const states = new Set()
    const releaseState = (state) => {
      states.delete(state)
      for (const dispose of state.disposers.splice(0)) {
        try { dispose() } catch { /* 释放失败不得反过来打断卸载 */ }
      }
    }
    const releaseAll = () => { for (const state of [...states]) releaseState(state) }

    const applyTo = (agent) => {
      const session = agent?.session
      const scoped = agent?.ctx
      if (session === undefined || scoped === undefined) return
      // 受众不在本动作的裁决面内就不注册（子代理的 guard 由它自己的 assembly 决定；
      // 万一父 guard 经 scope 链被走到，guard 体内的同一道受众判定仍然放行）。
      const depth = session.header?.delegationDepth ?? 0
      if (depth > 0 ? !includeSubagents : action.audience === 'subagent') return
      const existing = appliedBySession.get(session)
      if (existing !== undefined) {
        // 预设切换/重绑会换掉 agent.ctx：旧 scope 的 guard 随旧 scope 失效，必须重注册。
        if (existing.ctx === scoped) return
        releaseState(existing)
        appliedBySession.delete(session)
      }
      const tools = scoped.tools
      if (tools === undefined || typeof tools.guard !== 'function') {
        warnOnce(`${plugin}: guard action ${label} found no agent-scoped tools service — execution guard not registered`)
        return
      }
      const state = { ctx: scoped, disposers: [] }
      const denials = {
        ...(mask.allow !== undefined ? { allow: [...mask.allow] } : {}),
        ...(mask.deny !== undefined ? { deny: [...mask.deny] } : {}),
      }
      try {
        // restrict 沿父 scope 链传播且不识别受众；只在子代理也受限时复用。
        if (includeSubagents && typeof tools.restrict === 'function') {
          try {
            const dispose = tools.restrict(denials)
            if (typeof dispose === 'function') state.disposers.push(dispose)
          } catch (error) {
            // restrict 只收继承面：本层/晚到工具不在它的可限制集合里，交给 guard 裁决。
            warnOnce(`${plugin}: guard action ${label} restrict skipped (own-layer/late tools stay covered by the guard): ${String(error?.message ?? error)}`)
          }
        }
        state.disposers.push(tools.guard((exec) => {
          const toolName = exec?.name
          if (toolName === RUN_CODE || typeof toolName !== 'string' || toolName.length === 0) return undefined
          const depth = exec?.agent?.session?.header?.delegationDepth ?? 0
          // 主子代理隔离：scope 注册之外再按受众判定一次（子代理 scope 可能挂在父链上）。
          if (depth > 0 ? !includeSubagents : action.audience === 'subagent') return undefined
          return mask.blocks(toolName) ? reasonFor(toolName) : undefined
        }))
      } catch (error) {
        // 注册失败不得留下半注册状态：登记过的 state 会让同一 agent.ctx 的下一次 assemble
        // 直接 return（永不重试）。releaseState 对未登记的 state 同样安全。
        releaseState(state)
        throw error
      }
      // 只在注册成功后才登记，且只登记主会话：子代理的 guard 随它自己的 scope 释放，
      // 回调内也按 exec 的 depth 重判，登记它们只会让 states 随父 mount 单调增长。
      // 失败时 state 未登记，下一次装配重新走完整注册。
      if (depth === 0) states.add(state)
      appliedBySession.set(session, state)
    }

    collect(releaseAll)
    collect(on('system-prompt/assemble', async (assembly, context, next) => {
      // Downstream errors propagate untouched; only this action's own logic is guarded.
      const assembled = await next()
      try {
        applyTo(context?.agent)
      } catch (error) {
        warnOnce(`${plugin}: guard action ${label} failed to register: ${String(error?.message ?? error)}`)
      }
      return assembled
    }))
  }
}

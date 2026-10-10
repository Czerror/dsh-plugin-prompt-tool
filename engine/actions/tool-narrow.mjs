/**
 * `tool-narrow` —— 用官方 `ctx.tools.restrict({ allow })` 在 agent scope 上收窄**继承的全局工具面**。
 *
 * 与工具面收窄模板（`assembly` 重写装配结果）的差别，两条都真实：
 *  - `restrict` 只作用于**继承的全局工具**（部署全局层 + 祖先链），scope 自己注册的工具
 *    既不过滤也不受影响——本插件的 `tool_search` / `skill_search` / 自定义工具 /
 *    角色卡、世界书、会话变量工具都注册在 agent scope，所以它们**裁不掉**；
 *  - 被过滤掉的全局工具**在执行层也拒绝**（`tools.get(name, scope)` 读作不存在，与不存在的
 *    工具无法区分），不再依赖另行配对的 `decision` / `guard`。
 *
 * 与本项目「按需解锁」的关系是**二选一**（2026-10-10 用户拍板）：`restrict` 会砍掉
 * `ctx.tools.schemas(agent)` 的视野，`tool_search` 因此只剩已解锁项可见、搜索不再覆盖
 * 全量目录。要么 `assembly` + `allowFrom` 动态解锁，要么本动作的静态收窄。
 *
 * 收窄是**静态**的：注册即生效、不随会话变化。`allow` 在注册那一刻按当前全局目录过滤
 * （`restrict` 对未知名字直接抛错），所以「注册之后才出现」的全局工具不在本次收窄内，
 * 要等重启 / 重绑后重新注册。
 */

import { NAME_LIST, RUN_CODE, labelOf } from './shared.mjs'

export function prepareToolNarrow(action, plugin) {
  const label = labelOf(action)
  const allow = NAME_LIST.parse(action.allow, plugin, `${label}.allow`)
  // 与 `createMask` 同一条挂载期拒绝：`allow` 是 fail-closed 白名单，空名单等于什么都没配。
  if (allow === undefined || allow.size === 0) {
    throw new TypeError(`${plugin}: ${label}.allow must list the global tool names to keep — 空名单收窄没有意义，而且几乎总是配置写错`)
  }
  if (action.includeSubagents !== undefined && typeof action.includeSubagents !== 'boolean') {
    throw new TypeError(`${plugin}: ${label}.includeSubagents must be a boolean (省略 = 只影响本 scope) — got ${JSON.stringify(action.includeSubagents)}`)
  }
  // 保留名在挂载期就拒：`restrict` 见它即抛错，而它本就在 capability 过滤之外。
  if (allow.has(RUN_CODE)) {
    throw new TypeError(`${plugin}: ${label}.allow must not name the reserved ${RUN_CODE} transport — restrict 拒收该名字`)
  }
  const includeSubagents = action.includeSubagents === true

  return (ctx, { warnOnce, collect }) => {
    /** 同一 scope 只挂一条：restrict 只收紧、多条取交集，重复注册只会让语义更难解释。 */
    const applied = new WeakSet()
    const applyTo = (agent, scoped) => {
      if (applied.has(scoped)) return
      const tools = scoped.tools
      if (tools === undefined || typeof tools.restrict !== 'function' || typeof tools.schemas !== 'function') {
        warnOnce(`${plugin}: tool-narrow action ${label} found no agent-scoped tools service — tool narrowing not applied`)
        return
      }
      // 只喂**当前已知的全局工具名**：名字写错、或工具尚未注册，都不该让整次装配失败
      // （restrict 抛错会穿到装配层）——丢弃并留痕，收窄维持在已知的那部分。
      const known = new Set((tools.schemas() ?? []).map((schema) => schema?.name).filter((name) => typeof name === 'string'))
      const wanted = [...allow].filter((name) => known.has(name))
      const missing = [...allow].filter((name) => !known.has(name))
      if (missing.length > 0) {
        warnOnce(`${plugin}: tool-narrow action ${label}: not known global tools (skipped): ${missing.join(', ')} — 名字写错或工具尚未注册`)
      }
      if (wanted.length === 0) {
        warnOnce(`${plugin}: tool-narrow action ${label}: none of the declared tools exist globally — nothing was narrowed`)
        return
      }
      try {
        const dispose = tools.restrict({ allow: wanted })
        if (typeof dispose === 'function') collect(dispose)
        applied.add(scoped)
        // scope 释放时撤销这条 restriction（restrict 的 disposer 是 layers effect，须显式调）。
        if (typeof scoped.effect === 'function') scoped.effect(() => () => { try { dispose?.() } catch { /* 释放失败不反噬卸载 */ } })
      } catch (error) {
        warnOnce(`${plugin}: tool-narrow action ${label} restrict failed (tool face left unchanged): ${String(error?.message ?? error)}`)
      }
    }
    // 与 guard 同一时机与理由：首次装配时按 agent scope 惰性注册——`restrict` 必须在 scoped ctx
    // 上调用（插件 root ctx 不是 scope，会抛「requires a scoped context」）。
    collect(ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next()
      try {
        const agent = context?.agent
        const scoped = agent?.ctx
        if (agent !== undefined && scoped !== undefined) {
          const depth = agent.session?.header?.delegationDepth ?? 0
          if (depth === 0 || includeSubagents) applyTo(agent, scoped)
        }
      } catch (error) {
        warnOnce(`${plugin}: tool-narrow action ${label} failed to register: ${String(error?.message ?? error)}`)
      }
      return assembled
    }))
  }
}

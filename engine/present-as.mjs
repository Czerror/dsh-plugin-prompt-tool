/**
 * present-as — 声明**本模块覆盖的 Agent** 以哪种形态呈现工具（官方 `ctx.tools.presentAs`）。
 *
 * 为什么需要它：官方 PTC 呈现由 `@deepseek-ai/dsh-agent-tool-presentation` 行声明，而那是
 * **预设侧**的装配（preset 的常驻 scope）。本插件的模块行挂载在 **Agent scope**
 * （`src/runtime/agent-assembly.ts` 的 `agent.ctx.plugin(...)` → `module.apply(scopeCtx, …)`），
 * 拿到的正是 `presentAs` 要求的 scoped ctx——所以模块可以直接声明呈现，不必在预设里再挂
 * 官方行，也不必动 `cordis.patch.yml`（那条只用于**进程级默认**呈现，见下）。
 *
 * 与官方行的关系：调的是同一个 `presentAs`，语义等价；差别在 scope——本行落在 Agent scope
 * （更近），`modeFor` 沿 scope 链**最近者优先**，所以它与预设里的官方行可以并存。但**同一
 * scope 二次声明会被官方拒绝**（挂载期抛错 `tools.presentAs("x") conflicts with "y" already
 * declared for this scope`）——本行不捕获、不降级，让它响亮失败（装配失败优于静默换形态）。
 *
 * `ptc` 需要 `ctx.ptcRuntime`（宿主 base bundle 的 `ptc-runtime` 行提供）：用 `ctx.inject`
 * 等它就绪再声明；等不到本行停在 pending，由预设注册表指名报告**不可用的行**——刻意不静默
 * 退回 native，否则「开了 PTC」的部署会悄悄以 native 跑。`native` 不需要运行时，直接声明。
 *
 * disposer：`presentAs` 本身就是 effect（它用调用方的 ctx 注册、并把那个 disposer 还回来），
 * 本行不再包一层，随 fiber 释放即撤销。
 *
 * 进程级默认呈现不走本行：那要改宿主 `tools` 行的 `config.mode`（部署选择）。
 */

import { bool, defineConfig, enumOf } from './fields.mjs'
import { capabilityAudience } from './agent-capability.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'present-as'

/**
 * 呈现声明走 `ctx.tools`。
 * `ptcRuntime` **刻意不进 inject**（官方同一取舍）：那样会让 `native` 行也被绑死在
 * 「部署里必须有 PTC 运行时」上，而它与运行时毫无关系。
 */
export const inject = ['tools']

/**
 * 配置契约：字段声明是白名单（未知键 = 打字错误）与逐字段归一化的单一来源
 * （导出供契约对拍测试使用）。`enabled` 未声明 = 关闭，组合源显式写 `enabled: true`。
 */
export const configContract = defineConfig({
  enabled: bool({ default: false }),
  mode: enumOf(['native', 'ptc'], { required: true }),
  mainMode: enumOf(['native', 'ptc']),
  subagentMode: enumOf(['native', 'ptc']),
})

/**
 * 把本 scope 的工具呈现声明成 `config.mode`。
 *
 * @param ctx - 本模块行的挂载作用域（Agent scope）上下文。
 * @param config - `mode` 为必填兼容默认；主/子覆盖独立、缺省继承 mode。
 * @param options - 配装方持有的 Agent；不从 Context 猜测会话身份。
 */
export function apply(ctx, config, { agent } = {}) {
  // 校验入口：未知键 / enabled 非布尔 / mode 缺失或不在枚举内一律挂载期 fail loud。
  const source = configContract.parse(config, name)
  if (!source.enabled) return
  const mode = (capabilityAudience(agent) === 'subagent' ? source.subagentMode : source.mainMode) ?? source.mode
  if (mode === 'native') {
    ctx.tools.presentAs('native')
    return
  }
  // ptcRuntime 晚到也继续等待；缺失时先告警，避免“ptc 已启用却按 native 跑”没有任何痕迹。
  let warnedPending = false
  if (typeof ctx.get === 'function' && ctx.get('ptcRuntime') === undefined) {
    warnedPending = true
    try { ctx.logger?.warn?.('present-as: ptcRuntime 尚未就绪；本行保持 pending，不会声明 native；若宿主始终不提供，装配停在未呈现状态') } catch { /* logger 不可用不阻断装配 */ }
  }
  ctx.inject(['ptcRuntime'], (runtimeCtx) => {
    if (warnedPending) {
      try { ctx.logger?.info?.('present-as: ptcRuntime 已就绪，声明 ptc') } catch { /* logger 不可用不阻断装配 */ }
    }
    runtimeCtx.tools.presentAs('ptc')
  })
}

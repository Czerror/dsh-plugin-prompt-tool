/**
 * present-as — 在本模块覆盖的 Agent scope 挂载官方 native/PTC 执行器。
 * 官方插件拥有声明、冲突检查与释放；本行只选受众模式并等待导入和初始化。
 * PTC 运行时晚到通过动态注入等待，不回退 native，也不阻塞 native。
 */

import { bool, defineConfig, enumOf } from './fields.mjs'
import { capabilityAudience } from './agent-capability.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'present-as'

/**
 * 执行器注册走 `ctx.tools`。
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
export async function apply(ctx, config, { agent } = {}) {
  // 校验入口：未知键 / enabled 非布尔 / mode 缺失或不在枚举内一律挂载期 fail loud。
  const source = configContract.parse(config, name)
  if (!source.enabled) return
  const mode = (capabilityAudience(agent) === 'subagent' ? source.subagentMode : source.mainMode) ?? source.mode
  if (mode === 'native') {
    await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
    return
  }
  // ptcRuntime 晚到也继续等待；缺失时先告警，避免“ptc 已启用却按 native 跑”没有任何痕迹。
  let warnedPending = false
  if (typeof ctx.get === 'function' && ctx.get('ptcRuntime') === undefined) {
    warnedPending = true
    try { ctx.logger?.warn?.('present-as: ptcRuntime 尚未就绪；本行保持 pending，不会声明 native；若宿主始终不提供，装配停在未呈现状态') } catch { /* logger 不可用不阻断装配 */ }
  }
  const executor = await import('@deepseek-ai/dsh-tool-executor-ptc')
  await ctx.inject(['ptcRuntime'], async (runtimeCtx) => {
    if (warnedPending) {
      try { ctx.logger?.info?.('present-as: ptcRuntime 已就绪，声明 ptc') } catch { /* logger 不可用不阻断装配 */ }
    }
    await runtimeCtx.plugin(executor, {})
  })
}

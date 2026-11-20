/** diagnostics 域端点：只读运行态（世界书激活诊断、规则判定计数）。
 *
 *  这两个端点走第二个注入域（agents+tools+webServer），注册通道与事务入口仍来自同一个运行时。 */
import { lastContextActivationDiagnostics } from '../../../engine/context-activation.mjs'
import { readModuleConfigOrder } from '../../host/module-config-order.ts'
import { userModulesDir } from '../../host/module-dirs.ts'
import { BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import { emptyRuleDiagnostics } from '../rule-diagnostics.ts'
import { readSessionIdField, type BridgeRuntime } from '../bridge-runtime.ts'

/** 本域用到的运行时面：只用这些，不加宽（新域照此声明自己的面）。 */
type DiagnosticsRuntime = Pick<BridgeRuntime, 'agentScope' | 'registerAgentRoute' | 'deps'>

export function registerDiagnostics(runtime: DiagnosticsRuntime): Array<() => void> {
  return [
    // 世界书诊断（只读）：返回当前会话最近一次选择的观测记录；读取不触发求值、抽样或时间窗推进。
    runtime.registerAgentRoute(BRIDGE_ENDPOINTS.contextActivationDiagnostics, { body: 'json', handle: async (tx) => {
      const session = readSessionIdField(tx.record)
      if (!session.ok) {
        tx.write(400, { ok: false, code: 'context-activation-diagnostics-invalid', message: session.message })
        return
      }
      const empty = { records: [], truncated: false, step: 0, evaluated: false }
      const agent = session.sessionId === undefined ? undefined : runtime.agentScope.agents.get(session.sessionId as never) as { session?: unknown } | undefined
      const snapshot = agent?.session === undefined ? empty : lastContextActivationDiagnostics(agent.session)
      tx.write(200, {
        ok: true,
        value: {
          records: Array.isArray(snapshot.records) ? snapshot.records.slice(0, 200) : [],
          truncated: snapshot.truncated === true,
          step: typeof snapshot.step === 'number' ? snapshot.step : 0,
          evaluated: snapshot.evaluated === true,
        },
      })
    } }),
    // 规则判定计数（只读）：按「模块 + 规则 + 通道」聚合，供状态栏显示「配了没生效」；
    // 读取不触发求值，也不回规则正文或事件载荷。
    runtime.registerAgentRoute(BRIDGE_ENDPOINTS.ruleDiagnostics, { body: 'json', handle: async (tx) => {
      // 超限丢弃只在真的丢弃过时进载荷：未超限的响应与既有契约逐字不变。
      const snapshot = runtime.deps.ruleDiagnostics?.() ?? emptyRuleDiagnostics()
      // 状态栏的「X/Y 规则」顺路带回全仓配置卡；配置读取失败只影响这一段，诊断照旧下发。
      let configs: ReturnType<typeof readModuleConfigOrder> | undefined
      try { configs = readModuleConfigOrder(userModulesDir()) } catch { configs = undefined }
      tx.write(200, { ok: true, value: { records: snapshot.records, ...(snapshot.dropped > 0 ? { dropped: snapshot.dropped } : {}), ...(configs === undefined ? {} : { configs }) } })
    } }),
  ]
}

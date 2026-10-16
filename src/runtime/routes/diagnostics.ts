/** diagnostics 域端点：只读运行态（工具面、世界书激活诊断、规则判定计数）。
 *
 *  这三个端点走第二个注入域（agents+tools+webServer），注册通道与事务入口仍来自同一个运行时。 */
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { lastContextActivationDiagnostics } from '../../../engine/context-activation.mjs'
import { readModuleConfigOrder } from '../../host/module-config-order.ts'
import { userModulesDir } from '../../host/module-dirs.ts'
import { BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import { ruleDiagnosticsDropped, ruleDiagnosticsSnapshot } from '../rule-diagnostics.ts'
import { readSessionIdField, type BridgeRuntime } from '../bridge-runtime.ts'

type ToolSchemaLike = { name?: unknown; description?: unknown }

/** 只投影模型可见的稳定摘要；不把完整 parameters/执行实现送进浏览器。 */
function projectToolSchemas(schemas: readonly ToolSchemaLike[]): Array<{ name: string; description: string }> {
  const unique = new Map<string, { name: string; description: string }>()
  for (const schema of schemas) {
    const name = typeof schema.name === 'string' ? schema.name.trim() : ''
    if (name.length === 0 || unique.has(name)) continue
    unique.set(name, {
      name,
      description: typeof schema.description === 'string' ? schema.description : '',
    })
  }
  return [...unique.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/** 本域用到的运行时面：只用这些，不加宽（新域照此声明自己的面）。 */
type DiagnosticsRuntime = Pick<BridgeRuntime, 'agentScope' | 'registerAgentRoute'>

export function registerDiagnostics(runtime: DiagnosticsRuntime): Array<() => void> {
  return [
    runtime.registerAgentRoute(BRIDGE_ENDPOINTS.toolSurface, { body: 'json', handle: async (tx) => {
      const record = tx.record
      const hasSessionId = Object.prototype.hasOwnProperty.call(record, 'sessionId')
      const hasPresetId = Object.prototype.hasOwnProperty.call(record, 'presetId')
      const sessionId = hasSessionId && typeof record.sessionId === 'string' ? record.sessionId.trim() : undefined
      const presetId = hasPresetId && typeof record.presetId === 'string' ? record.presetId.trim() : undefined
      if ((hasSessionId && sessionId === undefined) || (hasPresetId && presetId === undefined)
        || (sessionId === '' || presetId === '')) {
        tx.write(400, { ok: false, code: 'tool-surface-invalid', message: 'sessionId/presetId 必须是非空字符串' })
        return
      }
      if ((sessionId === undefined) === (presetId === undefined)) {
        tx.write(400, { ok: false, code: 'tool-surface-invalid', message: 'sessionId 与 presetId 必须且只能提供一个非空字符串' })
        return
      }
      if ((sessionId ?? presetId ?? '').length > 256) {
        tx.write(400, { ok: false, code: 'tool-surface-invalid', message: 'sessionId/presetId 长度不能超过 256' })
        return
      }
      if (sessionId !== undefined) {
        const agent = runtime.agentScope.agents.get(sessionId as never)
        if (agent === undefined) {
          tx.write(404, { ok: false, code: 'tool-surface-unknown-session', message: '当前没有存活的本地 Agent 对应此 sessionId（冷态/远程子代理不支持）' })
          return
        }
        try {
          const tools = projectToolSchemas(runtime.agentScope.tools.schemas(agent))
          tx.write(200, { ok: true, value: { source: 'session', sessionId, tools } })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          tx.write(409, { ok: false, code: 'tool-surface-failed', message })
        }
        return
      }
      // agentPresets 不在本端点的 inject 列表内：ctx.agentPresets 属性访问会被 Cordis
      // 拒绝（cannot get property "agentPresets" without inject），整条请求以 400 空响应
      // 结束；与官方 plugin-inventory/session-controller 一致，用 ctx.get 解析可选服务。
      const agentPresets = runtime.agentScope.get?.('agentPresets')
      if (agentPresets === undefined) {
        tx.write(503, { ok: false, code: 'tool-surface-unavailable', message: 'agentPresets 服务尚未就绪' })
        return
      }
      let roster: Awaited<ReturnType<NonNullable<typeof agentPresets>['list']>>
      try {
        roster = await agentPresets.list()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        tx.write(503, { ok: false, code: 'tool-surface-unavailable', message: `官方预设 roster 读取失败：${message}` })
        return
      }
      if (!roster.some((preset) => preset.id === presetId)) {
        tx.write(404, { ok: false, code: 'tool-surface-unknown-preset', message: `未知官方预设：${presetId}` })
        return
      }
      try {
        const lease = await agentPresets.acquireScope(presetId!)
        let tools: ReturnType<typeof projectToolSchemas>
        try {
          tools = projectToolSchemas(runtime.agentScope.tools.schemas(lease.key))
        } finally {
          await lease[Symbol.asyncDispose]()
        }
        tx.write(200, { ok: true, value: { source: 'preset', presetId, tools } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        tx.write(409, { ok: false, code: 'tool-surface-preset-failed', message })
      }
    } }),
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
      const dropped = ruleDiagnosticsDropped()
      // 状态栏的「X/Y 规则」顺路带回全仓配置卡；配置读取失败只影响这一段，诊断照旧下发。
      let configs: ReturnType<typeof readModuleConfigOrder> | undefined
      try { configs = readModuleConfigOrder(userModulesDir()) } catch { configs = undefined }
      tx.write(200, { ok: true, value: { records: ruleDiagnosticsSnapshot(), ...(dropped > 0 ? { dropped } : {}), ...(configs === undefined ? {} : { configs }) } })
    } }),
  ]
}

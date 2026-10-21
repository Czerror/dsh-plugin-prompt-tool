/** meta 域端点：首屏聚合读取、引擎 meta、describe 事实、模型目录与推理档位。 */
import { invalidateModelCatalog, listAdvertisedModels, refreshModelReasoning } from '../models.ts'
import { readGlobalLayerSettingsSafe } from '../../host/config-store.ts'
import { userModulesDir } from '../../host/module-dirs.ts'
import { BRIDGE_ENDPOINTS, type BridgeBootstrapExtras, type BridgeSessionExtras } from '../../shared/bridge-contract.ts'
import { writeLayerSettingsError } from '../module-subject-gate.ts'
import {
  declarationsOf,
  declaresAny,
  instructionOwner,
  mergeInstructionCards,
  readSessionIdField,
  resolveInstructionScope,
  type BridgeRuntime,
} from '../bridge-runtime.ts'

/** 本域用到的运行时面：只用这些，不加宽（新域照此声明自己的面）。 */
type MetaRuntime = Pick<BridgeRuntime,
  'scope' | 'register' | 'gate' | 'descriptor' | 'loadEngineMeta' | 'collectDescribeExtras' | 'readParamOverrides' | 'variableView'>

export function registerMeta(runtime: MetaRuntime): Array<() => void> {
  return [
    runtime.register(BRIDGE_ENDPOINTS.bootstrap, { handle: async (tx) => {
      // optional：空目标是合法状态，只回全局段（模块段缺席）。
      const dir = runtime.gate(tx, 'bootstrap').inspect()
      if (dir === undefined) return
      const descriptor = runtime.descriptor.find()
      if (descriptor === undefined) {
        tx.write(404, { ok: false, code: 'settings-not-exposed', message: 'prompt-tool settings namespace is not registered' })
        return
      }
      const session = readSessionIdField(tx.record)
      if (!session.ok) {
        tx.write(400, { ok: false, code: 'settings-rejected', message: session.message })
        return
      }
      // 工作台首屏/保存后刷新的聚合读取：meta + describe 事实 + 参数覆盖 +
      // 模板变量 + 实际生效配置 + 指令文件快照。此前客户端串行 5 个端点
      // （每端点独立读盘 parse module.yml）；聚合后单请求、module.yml 命中
      // mtime 缓存仅解析一次。文件卡正文与 /prompt-configs 走同一读取入口。
      try {
        const meta = await runtime.loadEngineMeta()
        const extras = await runtime.collectDescribeExtras(dir, session.sessionId)
        const scope = await resolveInstructionScope(runtime.scope, session.sessionId)
        // 变量段与模块参数同口径：只对声明面登记的节下发，未声明就整体缺席（客户端据此不发这次读；变量卡是通用卡，缺段时走添加入口）。
        const variables = dir.length > 0 && declaresAny(declarationsOf(dir), ['variables', 'variablesEnabled'])
          ? runtime.variableView(dir)
          : undefined
        tx.write(200, {
          ok: true,
          value: runtime.descriptor.forTarget(descriptor, dir),
          meta: { meta },
          overrides: { overrides: dir.length > 0 ? runtime.readParamOverrides(dir) : {} },
          // 全局层参数（存储根 config.yml 的 layerSettings）：固定卡指令卡的设置区读它。
          // 与「模块自己写了哪个键」无关；优先级判定只在 resolveModuleParams 一处。
          // 软失败：全局层坏掉只让这一段为空，首屏照常（诊断见 meta.moduleWarnings）。
          globalParams: readGlobalLayerSettingsSafe(userModulesDir()).params,
          ...(variables === undefined ? {} : { variables }),
          promptConfigs: { promptConfigs: mergeInstructionCards(scope.files) },
          instructions: { context: scope.context, files: scope.files, owner: instructionOwner() },
          ...extras,
        } satisfies { ok: true; value: unknown } & BridgeBootstrapExtras & BridgeSessionExtras)
      } catch (error) {
        if (writeLayerSettingsError(tx.write, error)) return
        const message = error instanceof Error ? error.message : String(error)
        tx.write(500, { ok: false, code: 'bootstrap-failed', message })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.meta, { body: 'none', handle: async (tx) => {
      try {
        const meta = await runtime.loadEngineMeta()
        tx.write(200, { ok: true, value: { meta } })
      } catch (error) {
        tx.write(503, { ok: false, code: 'meta-unavailable', message: String(error) })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.describe, { body: 'none', handle: async (tx) => {
      // required：describe 的主体就是模块段，空目标在门处 400。
      const dir = runtime.gate(tx, 'describe').inspect()
      if (dir === undefined) return
      const descriptor = runtime.descriptor.find()
      if (descriptor === undefined) {
        tx.write(404, { ok: false, code: 'settings-not-exposed', message: 'prompt-tool settings namespace is not registered' })
        return
      }
      try {
        tx.write(200, { ok: true, value: runtime.descriptor.forTarget(descriptor, dir), ...await runtime.collectDescribeExtras(dir) } satisfies { ok: true; value: unknown } & BridgeSessionExtras)
      } catch (error) {
        if (!writeLayerSettingsError(tx.write, error)) throw error
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.models, { handle: async (tx) => {
      const record = tx.record as { refresh?: unknown }
      // 显式刷新（客户端重连、用户重试）越过 10 分钟 TTL：先失效再全量查询。
      // 目录查询失败不影响下一次调用，也不返回空目录冒充成功。
      if (record.refresh === true) invalidateModelCatalog(runtime.scope)
      const modelCatalog = await listAdvertisedModels(runtime.scope)
      tx.write(200, { ok: true, value: { modelCatalog } })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.modelReasoning, { handle: async (tx) => {
      const { provider, model } = tx.record as { provider?: unknown; model?: unknown }
      if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
        tx.write(400, { ok: false, code: 'reasoning-invalid-shape', message: 'provider and model must be non-empty strings' })
        return
      }
      // 查询失败/超时返回 known:false：客户端据此保持「未查到」，不虚构档位。
      const reasoning = await refreshModelReasoning(runtime.scope, provider, model) ?? { known: false, efforts: [] }
      tx.write(200, { ok: true, value: { reasoning } })
    } }),
  ]
}

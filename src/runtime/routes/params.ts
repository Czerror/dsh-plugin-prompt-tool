/** params 域端点：模块/全局层引擎参数与模块变量的读写。 */
import { basename, dirname } from 'node:path'
import { PARAM_KEYS } from '../../config.ts'
import { readGlobalLayerSettingsSafe, writeGlobalLayerSettings } from '../../host/config-store.ts'
import { userModulesDir } from '../../host/module-dirs.ts'
import { loadModuleDefinition } from '../../host/module-slices.ts'
import { ModuleWriteError } from '../../host/module-write.ts'
import { editModuleVariables, readModuleVariables } from '../../host/module-variables.ts'
import { saveModuleParams } from '../../host/module-definition-edit.ts'
import { validateEngineParamValues } from '../../shared/engine-params.ts'
import type { ModuleVariableRevisions } from '../../shared/module-variables.ts'
import { BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import { writeLayerSettingsError } from '../module-subject-gate.ts'
import { declarationsOf, declaresAny, isRecord, type BridgeRuntime } from '../bridge-runtime.ts'

/** 本域用到的运行时面：只用这些，不加宽（新域照此声明自己的面）。 */
type ParamsRuntime = Pick<BridgeRuntime,
  'deps' | 'register' | 'gate' | 'pendingVariableSettings' | 'runOverridesChange' | 'readParamOverrides' | 'variableView'>

export function registerParams(runtime: ParamsRuntime): Array<() => void> {
  return [
    runtime.register(BRIDGE_ENDPOINTS.paramOverrides, { handle: async (tx) => {
      const record = tx.record
      // 声明面只在读侧拦（无载荷 = 读 layerSettings 展平后的参数子集）。
      const dir = runtime.gate(tx, 'paramOverrides').inspect(record.overrides !== undefined)
      if (dir === undefined) return
      // 空主语 = **全局层**（存储根 config.yml 的 layerSettings）：固定卡（指令卡）是全局段，
      // 它的设置区写这里；有主语才读写该模块自己的 module.yml。
      const global = dir.length === 0
      // 参数按模块存储——读写激活模块 module.yml 的 params（+ promptConfigs）。
      const moduleRoot = dirname(dir)
      const templateName = basename(dir)
      // promptConfigs 全量数组随配置卡数量增长；所有 JSON bridge 端点统一使用 32 MiB
      // 内存缓冲上限，超过后由调用方收到明确 413，不再静默降级为读取分支。
      if (record.rebuild !== undefined && typeof record.rebuild !== 'boolean') {
        tx.write(400, { ok: false, code: 'overrides-invalid-shape', message: 'rebuild must be a boolean' })
        return
      }
      // 无载荷 = 读取当前 layerSettings 展平后的参数子集。
      if (record.promptConfigs !== undefined) {
        tx.write(410, { ok: false, code: 'rules-route-retired', message: '提示词配置已统一为 rules，请使用带版本的 /rules 事务编辑。' })
        return
      }
      if (record.overrides === undefined) {
        if (record.rebuild !== undefined) {
          tx.write(400, { ok: false, code: 'overrides-invalid-shape', message: 'rebuild requires overrides or promptConfigs' })
          return
        }
        // 全局层读同样软失败（坏文件按空读回；**写**仍然响亮拒绝，不覆盖用户内容）。
        tx.write(200, { ok: true, value: { overrides: global ? readGlobalLayerSettingsSafe(userModulesDir()).params : runtime.readParamOverrides(dir) } })
        return
      }
      if (record.overrides !== undefined && !isRecord(record.overrides)) {
        tx.write(400, { ok: false, code: 'overrides-invalid-shape', message: 'overrides must be an object' })
        return
      }
      // 全局层不是模块目录：可写判据（模块根之下）对它不适用，只有模块主语才过这道闸。
      if (!global && runtime.gate(tx, 'paramOverrides').authorize() === undefined) return
      const rawOverrides = record.overrides as Record<string, unknown> | undefined
      // 参数键白名单：未知键 fail loud，避免写入「读回/参数桥都不消费」的死键。
      if (rawOverrides !== undefined) {
        const unknownKeys = Object.keys(rawOverrides).filter((key) => key === 'promptConfigs' || !PARAM_KEYS.has(key))
        if (unknownKeys.length > 0) {
          tx.write(400, {
            ok: false,
            code: 'overrides-unknown-key',
            message: `未知引擎参数键：${unknownKeys.join(', ')}`,
          })
          return
        }
      }
      // 数值参数保存前校验（契约层同源规则）：temperature 有限数 / maxTokens 正整数。
      // 渲染层保持宽容（never-brick），保存层响亮失败直达 UI notice。
      const valueErrors = rawOverrides !== undefined ? validateEngineParamValues(rawOverrides) : []
      if (valueErrors.length > 0) {
        tx.write(400, {
          ok: false,
          code: 'overrides-invalid-value',
          message: valueErrors.map((item) => item.message).join('; '),
        })
        return
      }
      try {
        if (global) writeGlobalLayerSettings(userModulesDir(), rawOverrides ?? {})
        else saveModuleParams(
          moduleRoot,
          templateName,
          rawOverrides,
          undefined,
        )
        // 模块切换前保存当前配置卡时只需落盘，不立即重建；
        // 后续运行刷新按目标模块执行。全局层影响所有已启用模块：主语缺席即整轮刷新。
        if (record.rebuild !== false && !await runtime.runOverridesChange(tx.write, global ? undefined : basename(dir))) return
        tx.write(200, {
          ok: true,
          value: { overrides: record.overrides },
        })
      } catch (error) {
        if (writeLayerSettingsError(tx.write, error)) return
        const message = error instanceof Error ? error.message : String(error)
        tx.write(500, { ok: false, code: 'overrides-write-failed', message })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleVariables, { handle: async (tx) => {
      const record = tx.record
      // 声明面只在读侧拦：写变量/开关是给模块添加第一节，放行。
      // 全局变量跨模块共享，与「这个模块有没有声明 variables」无关：`scope: 'global'` 显式跳过声明面。
      const dir = runtime.gate(tx, 'moduleVariables').inspect(
        record.refreshOnly === true || record.variables !== undefined || record.enabled !== undefined,
        { declaration: record.scope === 'global' ? false : undefined },
      )
      if (dir === undefined) return
      if ((record.scope !== 'global' && record.scope !== 'module')
        || Object.keys(record).some(key => !['scope', 'variables', 'enabled', 'expectedModuleId', 'expectedRevisions', 'refreshOnly'].includes(key))) {
        tx.write(400, { ok: false, code: 'module-variables-invalid', message: '变量请求必须声明 global/module 范围，且只包含已声明字段' })
        return
      }
      if (record.refreshOnly !== undefined && (typeof record.refreshOnly !== 'boolean'
        || (record.refreshOnly === true && (record.variables !== undefined || record.enabled !== undefined || record.expectedRevisions !== undefined)))) {
        tx.write(400, { ok: false, code: 'module-variables-invalid', message: 'refreshOnly 不能与变量写入混用' })
        return
      }
      try {
        if (record.refreshOnly === true) {
          if (runtime.gate(tx, 'moduleVariables').authorize() === undefined) return
          if (typeof record.expectedModuleId !== 'string') throw new ModuleWriteError('刷新变量必须提供 expectedModuleId')
          const state = readModuleVariables(dir)
          if (runtime.pendingVariableSettings.has(dir)) {
            try { await runtime.deps.overridesChanged?.(basename(dir)); runtime.pendingVariableSettings.delete(dir) }
            catch (error) { runtime.pendingVariableSettings.set(dir, `变量开关已保存，但运行发布失败：${String(error)}`) }
          }
          tx.write(200, { ok: true, value: { ...state, ...runtime.variableView(dir), persisted: true } })
          return
        }
        if (record.variables === undefined && record.enabled === undefined) {
          if (record.expectedRevisions !== undefined) throw new ModuleWriteError('读取变量不接受写入版本')
          tx.write(200, { ok: true, value: runtime.variableView(dir) })
          return
        }
        if (runtime.gate(tx, 'moduleVariables').authorize() === undefined) return
        if (typeof record.expectedModuleId !== 'string') throw new ModuleWriteError('保存变量必须提供 expectedModuleId')
        // 未声明 variables／variablesEnabled 的模块首次写入＝**创建**：没有前状态就没有可冲突的对象，
        // 允许 `expectedRevisions` 整键缺席——按当次定义的版本补齐（写盘前仍逐键复核，冲突照旧 409）。
        const creating = record.scope === 'module' && record.expectedRevisions === undefined
          && !declaresAny(declarationsOf(dir), ['variables', 'variablesEnabled'])
        if (!creating && !isRecord(record.expectedRevisions)) throw new ModuleWriteError('保存变量或开关必须提供对应 expectedRevisions')
        const definition = creating ? loadModuleDefinition(dir) : undefined
        const expectedRevisions = definition === undefined
          ? record.expectedRevisions as Partial<ModuleVariableRevisions>
          : {
            module: definition.revisions.variables,
            ...(record.enabled === undefined ? {} : { settings: definition.revisions.settings }),
          }
        const settingsChanged = record.enabled !== undefined && record.enabled !== loadModuleDefinition(dir).variablesEnabled
        const committed = editModuleVariables(dir, {
          scope: record.scope as 'global' | 'module', expectedRevisions,
          ...(record.variables === undefined ? {} : { values: record.variables as Record<string, string> }),
          ...(record.enabled === undefined ? {} : { enabled: record.enabled as boolean }),
        })
        if (settingsChanged) runtime.pendingVariableSettings.set(dir, '变量开关已保存，等待运行发布')
        if (committed.publicationPending) {
          tx.write(200, { ok: true, value: committed })
          return
        }
        if (settingsChanged) {
          try { await runtime.deps.overridesChanged?.(basename(dir)); runtime.pendingVariableSettings.delete(dir) }
          catch (error) { runtime.pendingVariableSettings.set(dir, `变量开关已保存，但运行发布失败：${String(error)}`) }
        }
        tx.write(200, { ok: true, value: { ...committed, publicationPending: runtime.pendingVariableSettings.has(dir),
          ...(runtime.pendingVariableSettings.has(dir) ? { publicationError: runtime.pendingVariableSettings.get(dir)! } : {}) } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        tx.write(error instanceof ModuleWriteError ? error.status : 409, { ok: false, code: error instanceof ModuleWriteError ? error.code : 'module-variables-rejected', message: `变量读取或保存失败：${message}` })
      }
    } }),
  ]
}

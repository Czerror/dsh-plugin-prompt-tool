/** lifecycle 域端点：模块删除/复制/打开/改名/启用与排序。 */
import { basename } from 'node:path'
import { cloneBuiltinModule, duplicateUserModule, openModuleLocation } from '../../host/module-catalog.ts'
import { removeUserModule } from '../../host/module-capabilities.ts'
import { moduleDirExists, userModulesDir } from '../../host/module-dirs.ts'
import { appendModuleConfigOrder, readModuleConfigOrder, saveModuleConfigOrder } from '../../host/module-config-order.ts'
import { ModuleNameError, readModuleName, writeModuleName } from '../../host/module-name.ts'
import { ModuleWriteError } from '../../host/module-write.ts'
import { enabledModuleIds, setModuleEnabled } from '../../host/config-store.ts'
import type { ModuleConfigIdentity } from '../../shared/module-config-order.ts'
import { BRIDGE_ENDPOINTS, readEditTarget } from '../../shared/bridge-contract.ts'
import { isRecord, SHA256_HEX_RE, type BridgeRuntime } from '../bridge-runtime.ts'

/** 本域用到的运行时面：只用这些，不加宽（新域照此声明自己的面）。 */
type LifecycleRuntime = Pick<BridgeRuntime,
  'deps' | 'register' | 'gate' | 'moduleOrderQueue' | 'runOverridesChange' | 'refreshModuleList' | 'writeModuleOrderError'>

export function registerLifecycle(runtime: LifecycleRuntime): Array<() => void> {
  return [
    runtime.register(BRIDGE_ENDPOINTS.moduleDelete, { handle: async (tx) => {
      const record = tx.record
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (id.length === 0) {
        tx.write(400, { ok: false, code: 'module-delete-rejected', message: '缺少模块 id' })
        return
      }
      // 当前使用中的模块不可删除（先切换再删）。optional：编辑目标只当「在用」判据，
      // 不核形状——损坏的模块必须仍能删掉；声明不存在即没有在用模块。
      const activeDir = runtime.gate(tx, 'moduleDelete').inspect()
      if (activeDir === undefined) return
      if (activeDir.length > 0 && basename(activeDir) === id) {
        tx.write(400, { ok: false, code: 'module-in-use', message: `模块「${id}」正在使用中，请先切换其他模块再删除` })
        return
      }
      // 删除插件自有模块存储中的用户副本，包内模板保留。
      // 模块不在宿主预设注册表里，删除后无需撤销任何官方登记。
      const result = removeUserModule(id)
      if (!result.ok) {
        tx.write(400, { ok: false, code: 'module-delete-rejected', message: result.message })
        return
      }
      if (!await runtime.refreshModuleList(tx.write, id)) return
      tx.write(200, { ok: true, value: { id } })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleClone, { handle: async (tx) => {
      const record = tx.record
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (id.length === 0) {
        tx.write(400, { ok: false, code: 'module-clone-rejected', message: '缺少模块 id' })
        return
      }
      const result = cloneBuiltinModule(id, record.autoSuffix === true)
      if (!result.ok) {
        tx.write(400, { ok: false, code: 'module-clone-rejected', message: result.message })
        return
      }
      if (!await runtime.refreshModuleList(tx.write, result.id)) return
      tx.write(200, { ok: true, value: { id: result.id } })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleDuplicate, { handle: async (tx) => {
      const record = tx.record
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (id.length === 0) {
        tx.write(400, { ok: false, code: 'module-duplicate-rejected', message: '缺少模块 id' })
        return
      }
      const result = duplicateUserModule(id)
      if (!result.ok) {
        tx.write(400, { ok: false, code: 'module-duplicate-rejected', message: result.message })
        return
      }
      if (!await runtime.refreshModuleList(tx.write, result.id)) return
      tx.write(200, { ok: true, value: { id: result.id } })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleOpen, { handle: async (tx) => {
      const record = tx.record
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (id.length === 0) {
        tx.write(400, { ok: false, code: 'module-open-rejected', message: '缺少模块 id' })
        return
      }
      const result = openModuleLocation(id)
      if (!result.ok) {
        tx.write(400, { ok: false, code: 'module-open-rejected', message: `${result.message}（${result.path}）` })
        return
      }
      tx.write(200, { ok: true, value: { path: result.path } })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleName, { handle: async (tx) => {
      const dir = runtime.gate(tx, 'moduleName').inspect(tx.record.name !== undefined)
      if (dir === undefined) return
      try {
        const record = tx.record
        const allowed = record.name === undefined ? [] : ['name', 'expectedRevision', 'expectedModuleId']
        if (Object.keys(record).some((key) => !allowed.includes(key))) throw new ModuleNameError('名称请求包含未知字段')
        if (record.name === undefined) {
          tx.write(200, { ok: true, value: readModuleName(dir) })
          return
        }
        if (record.expectedRevision === undefined || record.expectedModuleId === undefined) throw new ModuleNameError('保存名称必须提供 expectedRevision 和 expectedModuleId')
        const value = writeModuleName(dir, record as { name: unknown; expectedRevision: unknown; expectedModuleId: unknown })
        let publicationError: string | undefined
        try { await runtime.deps.overridesChanged?.(basename(dir)) }
        catch (error) { publicationError = String(error) }
        tx.write(200, { ok: true, value: { ...value, persisted: true, ...(publicationError === undefined ? {} : { publicationError }) } })
      } catch (error) {
        if (error instanceof ModuleWriteError && error.persisted) {
          tx.write(200, { ok: true, value: { ...readModuleName(dir), persisted: true, publicationError: error.message } })
          return
        }
        const typed = error instanceof ModuleNameError || error instanceof ModuleWriteError ? error : undefined
        tx.write(typed?.status ?? 400, { ok: false, code: typed?.code ?? 'module-name-rejected', message: error instanceof Error ? error.message : String(error) })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleEnable, { handle: async (tx) => {
      const record = tx.record
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (id.length === 0) {
        tx.write(400, { ok: false, code: 'module-enable-rejected', message: '缺少模块 id' })
        return
      }
      if (typeof record.enabled !== 'boolean') {
        tx.write(400, { ok: false, code: 'module-enable-rejected', message: 'enabled 必须是布尔值' })
        return
      }
      // 只允许启用磁盘上真实存在的模块：启用表写进一个不存在的 id 会让装配静默少装一个。
      if (record.enabled && !moduleDirExists(userModulesDir(), id)) {
        tx.write(400, { ok: false, code: 'module-enable-rejected', message: `模块 ${id} 不存在` })
        return
      }
      const enabled = record.enabled
      const run = runtime.moduleOrderQueue.run(async () => {
        try {
          if (enabled) {
            const changed = appendModuleConfigOrder(userModulesDir(), id)
            // 上次可能已保存序号却未物化成功；从停用态启用有卡模块时仍须重建。
            if (!changed.includes(id) && !enabledModuleIds(userModulesDir()).includes(id)
              && readModuleConfigOrder(userModulesDir(), id).entries.length > 0) changed.push(id)
            for (const changedId of changed) {
              if (!await runtime.runOverridesChange(tx.write, changedId)) return
            }
          }
          setModuleEnabled(userModulesDir(), id, enabled)
          if (!await runtime.runOverridesChange(tx.write)) return
          tx.write(200, { ok: true, value: { enabled: enabledModuleIds(userModulesDir()) } })
        } catch (error) {
          runtime.writeModuleOrderError(tx.write, error)
        }
      })
      await run
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleConfigOrder, { handle: async (tx) => {
      const body = tx.record
      // 客户端无参数读取序列化为 {}；与空请求体一样读取全局排序。
      const writing = body.entries !== undefined || body.expectedRevision !== undefined
      if (Object.keys(body).some((key) => key !== 'moduleId' && key !== 'entries' && key !== 'expectedRevision')
        || (body.moduleId !== undefined && (typeof body.moduleId !== 'string' || readEditTarget(body.moduleId) !== body.moduleId))
        || (writing && (typeof body.expectedRevision !== 'string' || !SHA256_HEX_RE.test(body.expectedRevision)
          || !Array.isArray(body.entries)
          || body.entries.some((entry) => !isRecord(entry)
          || Object.keys(entry).some((key) => key !== 'moduleId' && key !== 'configId')
          || typeof entry.moduleId !== 'string' || readEditTarget(entry.moduleId) !== entry.moduleId
          || typeof entry.configId !== 'string' || entry.configId.length === 0 || entry.configId.length > 256)))) {
        tx.write(400, { ok: false, code: 'module-config-order-invalid', message: '排序只接受配置身份列表和读取时的版本' })
        return
      }
      const run = runtime.moduleOrderQueue.run(async () => {
        try {
          const moduleId = body.moduleId as string | undefined
          if (writing) {
            const changedIds = saveModuleConfigOrder(userModulesDir(), body.expectedRevision as string, body.entries as ModuleConfigIdentity[], moduleId)
            for (const id of changedIds) {
              if (!await runtime.runOverridesChange(tx.write, id)) return
            }
          }
          tx.write(200, { ok: true, value: readModuleConfigOrder(userModulesDir(), moduleId) })
        } catch (error) {
          runtime.writeModuleOrderError(tx.write, error)
        }
      })
      await run
    } }),
  ]
}

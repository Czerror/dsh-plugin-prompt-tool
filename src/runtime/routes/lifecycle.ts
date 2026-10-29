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
import { published, type PublicationFields } from '../../shared/publication.ts'
import { isRecord, SHA256_HEX_RE, type BridgeRuntime } from '../bridge-runtime.ts'

/** 本域用到的运行时面：只用这些，不加宽（新域照此声明自己的面）。 */
type LifecycleRuntime = Pick<BridgeRuntime,
  'deps' | 'register' | 'gate' | 'moduleOrderQueue' | 'runOverridesChange' | 'refreshModuleList' | 'schedulePublication' | 'writeModuleOrderError'>

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
      if (record.refreshOnly === true) {
        const publication = await runtime.refreshModuleList()
        tx.write(200, { ok: true, value: { id, ...publication } })
        return
      }
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
      // 删除已提交：运行发布失败回 200 + 待发布，客户端按已删除处理并保留重试。
      const publication = await runtime.schedulePublication(undefined, 'list')
      if (publication.publicationPending) runtime.deps.warn?.(`删除模块 ${id} 后刷新运行实例失败：${publication.publicationError}`)
      tx.write(200, {
        ok: true,
        value: {
          id,
          ...(result.backupPath === undefined ? {} : { backupPath: result.backupPath }),
          ...publication,
        },
      })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleClone, { handle: async (tx) => {
      const record = tx.record
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (id.length === 0) {
        tx.write(400, { ok: false, code: 'module-clone-rejected', message: '缺少模块 id' })
        return
      }
      if (record.refreshOnly === true) {
        if (record.autoSuffix !== undefined) {
          tx.write(400, { ok: false, code: 'module-clone-rejected', message: 'refreshOnly 不能与 autoSuffix 混用' })
          return
        }
        const publication = await runtime.refreshModuleList()
        tx.write(200, { ok: true, value: { id, ...publication } })
        return
      }
      const result = cloneBuiltinModule(id, record.autoSuffix === true, undefined, runtime.deps.warn)
      if (!result.ok) {
        tx.write(400, { ok: false, code: 'module-clone-rejected', message: result.message })
        return
      }
      const publication = await runtime.schedulePublication(undefined, 'list')
      tx.write(200, { ok: true, value: { id: result.id, ...publication } })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleDuplicate, { handle: async (tx) => {
      const record = tx.record
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (id.length === 0) {
        tx.write(400, { ok: false, code: 'module-duplicate-rejected', message: '缺少模块 id' })
        return
      }
      if (record.refreshOnly === true) {
        const publication = await runtime.refreshModuleList()
        tx.write(200, { ok: true, value: { id, ...publication } })
        return
      }
      const result = duplicateUserModule(id, undefined, runtime.deps.warn)
      if (!result.ok) {
        tx.write(400, { ok: false, code: 'module-duplicate-rejected', message: result.message })
        return
      }
      const publication = await runtime.schedulePublication(undefined, 'list')
      tx.write(200, { ok: true, value: { id: result.id, ...publication } })
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

        if (record.refreshOnly === true) {
          if (record.name !== undefined) throw new ModuleNameError('refreshOnly 不能与改名混用')
          if (record.expectedRevision !== undefined || record.expectedModuleId !== undefined) throw new ModuleNameError('refreshOnly 不接受写入版本')
          if (runtime.gate(tx, 'moduleName').authorize() === undefined) return
          const publication = await runtime.runOverridesChange(basename(dir))
          tx.write(200, { ok: true, value: { ...readModuleName(dir), ...publication } })
          return
        }
        if (record.name === undefined) {
          if (record.expectedRevision !== undefined || record.expectedModuleId !== undefined) throw new ModuleNameError('读取名称不接受写入版本')
          tx.write(200, { ok: true, value: readModuleName(dir) })
          return
        }
        if (record.expectedRevision === undefined || record.expectedModuleId === undefined) throw new ModuleNameError('保存名称必须提供 expectedRevision 和 expectedModuleId')
        const value = writeModuleName(dir, record as { name: unknown; expectedRevision: unknown; expectedModuleId: unknown })
        const publication = await runtime.schedulePublication(basename(dir))
        tx.write(200, { ok: true, value: { ...value, ...publication } })
      } catch (error) {
        if (error instanceof ModuleWriteError && error.persisted) {
          tx.write(200, { ok: true, value: { ...readModuleName(dir), ...published(error.message) } })
          return
        }
        const typed = error instanceof ModuleNameError || error instanceof ModuleWriteError ? error : undefined
        tx.write(typed?.status ?? 400, { ok: false, code: typed?.code ?? 'module-name-rejected', message: error instanceof Error ? error.message : String(error) })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleEnable, { handle: async (tx) => {
      const record = tx.record
      if (record.refreshOnly === true) {
        if (record.id !== undefined || record.enabled !== undefined) {
          tx.write(400, { ok: false, code: 'module-enable-rejected', message: 'refreshOnly 不能与启用写入混用' })
          return
        }
        const run = runtime.moduleOrderQueue.run(async () => {
          const publication = await runtime.runOverridesChange()
          tx.write(200, { ok: true, value: { enabled: enabledModuleIds(userModulesDir()), ...publication } })
        })
        await run
        return
      }
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
            appendModuleConfigOrder(userModulesDir(), id)
          }
          setModuleEnabled(userModulesDir(), id, enabled)
          const publication = await runtime.schedulePublication()
          tx.write(200, { ok: true, value: { enabled: enabledModuleIds(userModulesDir()), ...publication } })
        } catch (error) {
          runtime.writeModuleOrderError(tx.write, error)
        }
      })
      await run
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleConfigOrder, { handle: async (tx) => {
      const body = tx.record
      if (body.refreshOnly === true) {
        if (body.entries !== undefined || body.expectedRevision !== undefined) {
          tx.write(400, { ok: false, code: 'module-config-order-invalid', message: 'refreshOnly 不能与排序写入混用' })
          return
        }
        if (body.moduleId !== undefined && (typeof body.moduleId !== 'string' || readEditTarget(body.moduleId) !== body.moduleId)) {
          tx.write(400, { ok: false, code: 'module-config-order-invalid', message: 'moduleId 形状非法' })
          return
        }
        const moduleId = typeof body.moduleId === 'string' ? body.moduleId : undefined
        const run = runtime.moduleOrderQueue.run(async () => {
          const publication = await runtime.runOverridesChange()
          tx.write(200, { ok: true, value: { ...readModuleConfigOrder(userModulesDir(), moduleId), ...publication } })
        })
        await run
        return
      }
      // 客户端无参数读取序列化为 {}；与空请求体一样读取全局排序。
      const writing = body.entries !== undefined || body.expectedRevision !== undefined
      if ((body.moduleId !== undefined && (typeof body.moduleId !== 'string' || readEditTarget(body.moduleId) !== body.moduleId))
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
          let publication: PublicationFields = published()
          if (writing) {
            const changedIds = saveModuleConfigOrder(userModulesDir(), body.expectedRevision as string, body.entries as ModuleConfigIdentity[], moduleId)
            for (const id of changedIds) {
              publication = await runtime.schedulePublication(id)
              if (publication.publicationPending) break
            }
          }
          const snapshot = readModuleConfigOrder(userModulesDir(), moduleId)
          // 读响应不带发布字段：没有写盘时 published() 只是占位，不能被当成「已持久化」事实。
          tx.write(200, { ok: true, value: writing ? { ...snapshot, ...publication } : snapshot })
        } catch (error) {
          runtime.writeModuleOrderError(tx.write, error)
        }
      })
      await run
    } }),
  ]
}

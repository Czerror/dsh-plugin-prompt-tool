import { MODULE_ACTIVATION_FAILED } from '../../shared/bridge-contract.ts'
import { bridgeCall, errorMessage, type BridgeResult } from './bridge-client.ts'
import { BLANK_MODULE_TEMPLATE } from './module-subject.ts'

export type ModuleActionResult<T> = BridgeResult<T> & { committed?: boolean; refreshError?: string }

/** 模块修改与事实刷新共用保存队列；刷新失败不重放已提交的操作。 */
export function createModuleActions(deps: {
  enqueue: <T>(task: () => Promise<T>) => Promise<T>
  refresh: () => Promise<boolean>
}) {
  const refresh = async (): Promise<boolean> => {
    try { return await deps.refresh() } catch { return false }
  }
  const write = <T>(request: () => Promise<BridgeResult<T>>): Promise<ModuleActionResult<T>> => deps.enqueue(async () => {
    let result: BridgeResult<T>
    try { result = await request() } catch (error) { return { ok: false, message: errorMessage(error) } }
    const committed = result.ok || result.code === MODULE_ACTIVATION_FAILED
    if (!committed) return result
    const refreshed = await refresh()
    return { ...result, committed: true, ...(refreshed ? {} : { refreshError: 'module-refresh-failed' }) }
  })
  let creating: Promise<ModuleActionResult<{ id: string }>> | undefined
  return {
    create: () => creating ??= write(() => bridgeCall('moduleClone', { id: BLANK_MODULE_TEMPLATE, autoSuffix: true })).finally(() => { creating = undefined }),
    clone: (id: string, autoSuffix = false) => write(() => bridgeCall('moduleClone', { id, autoSuffix })),
    duplicate: (id: string) => write(() => bridgeCall('moduleDuplicate', { id })),
    remove: (id: string) => write(() => bridgeCall('moduleDelete', { id })),
    enable: (id: string, enabled: boolean) => write(() => bridgeCall('moduleEnable', { id, enabled })),
    readName: (id: string) => bridgeCall('moduleName', {}, id),
    rename: (id: string, name: string, expectedRevision: string) => write(() => bridgeCall('moduleName', { name, expectedRevision, expectedModuleId: id }, id)),
    open: (id: string) => bridgeCall('moduleOpen', { id }),
    refresh,
  }
}
export type ModuleActions = ReturnType<typeof createModuleActions>

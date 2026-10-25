import { bridgeCall, errorMessage, type BridgeResult } from './bridge-client.ts'
import { BLANK_MODULE_TEMPLATE } from './module-subject.ts'
import { readPublication, type PublicationFields } from '../../shared/publication.ts'

export type ModuleActionResult<T> = BridgeResult<T> & {
  refreshError?: string
  publication?: { pending: boolean; error?: string }
}

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
    if (!result.ok) return result
    const publication = readPublication(result.value as PublicationFields)
    const refreshed = await refresh()
    return { ...result, ...(refreshed ? {} : { refreshError: 'module-refresh-failed' }), publication }
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
    /** 下列 refreshOnly 只重建运行实例，不重跑创建/改名/启用/删除。 */
    retryName: (id: string) => write(() => bridgeCall('moduleName', { refreshOnly: true, expectedModuleId: id }, id)),
    retryEnable: () => write(() => bridgeCall('moduleEnable', { refreshOnly: true })),
    retryClone: (id: string) => write(() => bridgeCall('moduleClone', { id, refreshOnly: true })),
    retryDuplicate: (id: string) => write(() => bridgeCall('moduleDuplicate', { id, refreshOnly: true })),
    retryDelete: (id: string) => write(() => bridgeCall('moduleDelete', { id, refreshOnly: true })),
    refresh,
  }
}
export type ModuleActions = ReturnType<typeof createModuleActions>

import { bridgeCall, errorMessage, type BridgeResult } from './bridge-client.ts'
import { BLANK_MODULE_TEMPLATE } from './module-subject.ts'
import { readPublication, type PublicationFields } from '../../shared/publication.ts'
import type { BridgeRequestMap, BridgeValueMap } from '../../shared/bridge-contract.ts'

/** 能力变更后的发布重试请求：只重建，不重复 create/remove。 */
export const capabilityRefreshBody = (moduleId: string): { refreshOnly: true; expectedModuleId: string } => ({ refreshOnly: true, expectedModuleId: moduleId })

export type ModuleActionResult<T> = BridgeResult<T> & {
  refreshError?: string
  publication?: { pending: boolean; error?: string }
}

interface ModuleEnableState {
  busy: boolean
  publication?: ModuleActionResult<unknown>['publication']
  error?: string
  refreshFailed: boolean
}

/** 模块修改与事实刷新共用保存队列；刷新失败不重放已提交的操作。 */
export function createModuleActions(deps: {
  enqueue: <T>(task: () => Promise<T>) => Promise<T>
  refresh: () => Promise<boolean>
}) {
  const refresh = async (): Promise<boolean> => {
    try { return await deps.refresh() } catch { return false }
  }
  const performWrite = async <T>(request: () => Promise<BridgeResult<T>>, refreshMeta = true): Promise<ModuleActionResult<T>> => {
    let result: BridgeResult<T>
    try { result = await request() } catch (error) { return { ok: false, message: errorMessage(error) } }
    if (!result.ok) return result
    const publication = readPublication(result.value as PublicationFields)
    const refreshed = !refreshMeta || await refresh()
    return { ...result, ...(refreshed ? {} : { refreshError: 'module-refresh-failed' }), publication }
  }
  const write = <T>(request: () => Promise<BridgeResult<T>>): Promise<ModuleActionResult<T>> => deps.enqueue(() => performWrite(request))

  let enableState: ModuleEnableState = { busy: false, refreshFailed: false }
  let enableJobs = 0
  const enableListeners = new Set<() => void>()
  const publishEnable = (next: ModuleEnableState): void => {
    if (next.busy === enableState.busy && next.error === enableState.error && next.refreshFailed === enableState.refreshFailed
      && next.publication?.error === enableState.publication?.error && next.publication?.pending === enableState.publication?.pending) return
    enableState = next
    for (const listener of enableListeners) listener()
  }
  const beginEnable = (): void => {
    enableJobs++
    publishEnable({ ...enableState, busy: true, error: undefined })
  }
  const finishEnable = (change: Partial<ModuleEnableState>): void => {
    enableJobs--
    publishEnable({ ...enableState, ...change, busy: enableJobs > 0 })
  }
  const writeEnable = async (body: BridgeRequestMap['moduleEnable']): Promise<ModuleActionResult<BridgeValueMap['moduleEnable']>> => {
    beginEnable()
    const retry = body.refreshOnly === true
    let change: Partial<ModuleEnableState> = {}
    try {
      const result = await deps.enqueue(() => performWrite(() => bridgeCall('moduleEnable', body), !retry || enableState.refreshFailed))
      if (result.ok) {
        change = { publication: result.publication?.pending ? result.publication : undefined, refreshFailed: result.refreshError !== undefined }
      } else {
        const error = result.message ?? result.code ?? 'module-enable-failed'
        change = retry ? { publication: { pending: true, error } } : { error }
      }
      return result
    } catch (error) {
      const message = errorMessage(error)
      change = retry ? { publication: { pending: true, error: message } } : { error: message }
      return { ok: false, message }
    } finally {
      finishEnable(change)
    }
  }
  const retryEnable = async (): Promise<void> => {
    if (enableState.busy) return
    if (enableState.publication?.pending) {
      await writeEnable({ refreshOnly: true })
    } else if (enableState.refreshFailed) {
      beginEnable()
      const refreshed = await deps.enqueue(refresh).catch(() => false)
      finishEnable({ refreshFailed: !refreshed })
    }
  }
  let creating: Promise<ModuleActionResult<{ id: string }>> | undefined
  return {
    create: () => creating ??= write(() => bridgeCall('moduleClone', { id: BLANK_MODULE_TEMPLATE, autoSuffix: true })).finally(() => { creating = undefined }),
    clone: (id: string, autoSuffix = false) => write(() => bridgeCall('moduleClone', { id, autoSuffix })),
    duplicate: (id: string) => write(() => bridgeCall('moduleDuplicate', { id })),
    remove: (id: string) => write(() => bridgeCall('moduleDelete', { id })),
    enable: (id: string, enabled: boolean) => writeEnable({ id, enabled }),
    getEnableState: () => enableState,
    subscribeEnable: (listener: () => void) => { enableListeners.add(listener); return () => { enableListeners.delete(listener) } },
    retryEnable,
    readName: (id: string) => bridgeCall('moduleName', {}, id),
    rename: (id: string, name: string, expectedRevision: string) => write(() => bridgeCall('moduleName', { name, expectedRevision, expectedModuleId: id }, id)),
    open: (id: string) => bridgeCall('moduleOpen', { id }),
    /** 下列 refreshOnly 只重建运行实例，不重跑创建/改名/启用/删除。 */
    retryName: (id: string) => write(() => bridgeCall('moduleName', { refreshOnly: true }, id)),
    retryClone: (id: string) => write(() => bridgeCall('moduleClone', { id, refreshOnly: true })),
    retryDuplicate: (id: string) => write(() => bridgeCall('moduleDuplicate', { id, refreshOnly: true })),
    retryDelete: (id: string) => write(() => bridgeCall('moduleDelete', { id, refreshOnly: true })),
    refresh,
  }
}
export type ModuleActions = ReturnType<typeof createModuleActions>

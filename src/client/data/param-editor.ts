/** 参数读改写的 owner：条目、有效基线、已存键与迟到应答只在此处维护。 */
import { bridgeCall } from './bridge-client.ts'
import { deepEqual } from './dirty-state.ts'
import { buildParamOverrides, EMPTY_PARAMS, paramSnapshot, readParamOverridesPatch, updateLoadedParamKeys, type ParamSnapshot } from './param-overrides.ts'
import { SHARED_PARAM_KEYS } from './prompt-tool-fields.ts'
import type { ParamsPort } from './store-ports.ts'
import type { SerialTaskQueue } from './save-queue.ts'
import { MODULE_PENDING_MESSAGE, NO_SUBJECT_MESSAGE } from './module-subject.ts'
import { readPublication } from '../../shared/publication.ts'

interface ParamEntry {
  values: ParamSnapshot
  baseline: ParamSnapshot
  loadedKeys: Set<string>
  loaded: boolean
  publicationPending?: boolean
  publicationError?: string
}

export interface ParamEditorDependencies {
  isPresent: (moduleId: string) => boolean
  declares: (moduleId: string) => boolean
  canEdit: (moduleId: string) => boolean
  globalEnabled: () => boolean
  hasRawDraft: (moduleId: string) => boolean
  enqueue: SerialTaskQueue['enqueue']
  changed: () => void
  edited: () => void
  showNotice: (kind: 'ok' | 'error', message: string) => void
  /** 入队前捕获跨域刷新资格，成功后才执行；规则/变量草稿不归参数 owner。 */
  prepareRefresh: (scope: 'module' | 'global') => () => Promise<void>
}

export interface ParamEditor extends ParamsPort {
  applyGlobal: (patch: Record<string, unknown>) => void
  reloadModules: () => void
  refreshModules: () => void
}

const emptyEntry = (): ParamEntry => ({ values: { ...EMPTY_PARAMS }, baseline: { ...EMPTY_PARAMS }, loadedKeys: new Set(), loaded: false })

/** 每个工作台一个实例；接线可随渲染更新，参数状态始终留在闭包中。 */
export function createParamEditor(deps: ParamEditorDependencies): ParamEditor {
  const entries = new Map<string, ParamEntry>()
  const reading = new Set<string>()
  const global = emptyEntry()
  const entryOf = (moduleId: string): ParamEntry => {
    const retained = entries.get(moduleId)
    if (retained !== undefined) return retained
    const created = emptyEntry()
    entries.set(moduleId, created)
    return created
  }

  const read = async (moduleId: string): Promise<void> => {
    const entry = entryOf(moduleId)
    const readingValues = entry.values
    if (!deps.declares(moduleId)) { entry.loaded = true; return }
    if (reading.has(moduleId)) return
    reading.add(moduleId)
    try {
      const result = await bridgeCall('paramOverrides', {}, moduleId)
      if (!deps.isPresent(moduleId) || entries.get(moduleId) !== entry || !deps.declares(moduleId)) return
      if (!result.ok) {
        deps.showNotice('error', `模块 ${moduleId} 参数读取失败：` + (result.message ?? 'settings bridge unavailable'))
        return
      }
      const patch = readParamOverridesPatch(result.value.overrides ?? {})
      const next = paramSnapshot(readParamOverridesPatch(result.value.effective ?? result.value.overrides ?? {}))
      entry.baseline = { ...next }
      for (const key of SHARED_PARAM_KEYS) if (!deepEqual(entry.values[key], readingValues[key])) Object.assign(next, { [key]: entry.values[key] })
      entry.values = next
      entry.loadedKeys = new Set(SHARED_PARAM_KEYS.filter(key => Object.hasOwn(patch, key)))
      entry.loaded = true
      deps.changed()
    } finally { reading.delete(moduleId) }
  }

  const persistParamOverrides = async (moduleId: string): Promise<void> => {
    if (!deps.canEdit(moduleId)) { deps.showNotice('error', NO_SUBJECT_MESSAGE); return }
    const entry = entryOf(moduleId)
    if (!entry.loaded) { deps.showNotice('error', MODULE_PENDING_MESSAGE); return }
    const refresh = deps.prepareRefresh('module')
    await deps.enqueue(async () => {
      // 模块保存沿用执行时快照；与全局参数的入队时快照不同。
      const submitted = entry.values
      const overrides = buildParamOverrides(submitted, { loadedKeys: entry.loadedKeys, baseline: entry.baseline })
      const result = await bridgeCall('paramOverrides', { overrides, expectedModuleId: moduleId }, moduleId)
      if (entry.values !== submitted) return
      if (result.ok) {
        updateLoadedParamKeys(entry.loadedKeys, overrides)
        entry.baseline = submitted
        const publication = readPublication(result.value)
        entry.publicationPending = publication.pending
        entry.publicationError = publication.error
        await refresh()
      } else deps.showNotice('error', '参数保存失败：' + (result.message ?? 'settings bridge unavailable'))
    })
  }

  const persistGlobalParams = async (): Promise<void> => {
    if (!deps.globalEnabled()) { deps.showNotice('error', NO_SUBJECT_MESSAGE); return }
    if (!global.loaded) { deps.showNotice('error', MODULE_PENDING_MESSAGE); return }
    const submitted = global.values
    const overrides = buildParamOverrides(submitted, { loadedKeys: global.loadedKeys, baseline: global.baseline })
    const refresh = deps.prepareRefresh('global')
    await deps.enqueue(async () => {
      const result = await bridgeCall('paramOverrides', { overrides })
      if (global.values !== submitted) return
      if (result.ok) {
        updateLoadedParamKeys(global.loadedKeys, overrides)
        global.baseline = submitted
        const publication = readPublication(result.value)
        global.publicationPending = publication.pending
        global.publicationError = publication.error
        await refresh()
      } else deps.showNotice('error', '参数保存失败：' + (result.message ?? 'settings bridge unavailable'))
    })
  }

  /** 参数发布态：组件据此显示「已保存，待发布」与重试入口。 */
  const publicationOf = (scope: 'module' | 'global', moduleId?: string): { pending: boolean; error?: string } => {
    const entry = scope === 'global' ? global : entryOf(moduleId ?? '')
    return { pending: entry.publicationPending === true, ...(entry.publicationError === undefined ? {} : { error: entry.publicationError }) }
  }
  /** 只重试运行发布：不重写参数，重试与保存共用同一队列。 */
  const retryParamPublication = async (scope: 'module' | 'global', moduleId?: string): Promise<void> => {
    if (scope === 'module' && (moduleId === undefined || !deps.canEdit(moduleId))) {
      deps.showNotice('error', NO_SUBJECT_MESSAGE)
      return
    }
    const entry = scope === 'global' ? global : entryOf(moduleId ?? '')
    await deps.enqueue(async () => {
      const result = scope === 'global'
        ? await bridgeCall('paramOverrides', { refreshOnly: true })
        : await bridgeCall('paramOverrides', { refreshOnly: true, expectedModuleId: moduleId }, moduleId)
      if (!result.ok) {
        deps.showNotice('error', '参数发布重试失败：' + (result.message ?? 'settings bridge unavailable'))
        return
      }
      const publication = readPublication(result.value)
      entry.publicationPending = publication.pending
      entry.publicationError = publication.error
      deps.showNotice(publication.pending ? 'error' : 'ok', publication.error ?? '参数发布已完成')
      deps.changed()
    })
  }
  return {
    moduleParamsOf: moduleId => entryOf(moduleId).values,
    ensureModuleParams: moduleId => { if (!entryOf(moduleId).loaded) void read(moduleId) },
    setModuleParam: (moduleId, key, value) => {
      const entry = entryOf(moduleId)
      entry.values = { ...entry.values, [key]: value } as ParamSnapshot
      deps.edited()
    },
    persistParamOverrides,
    get globalParams() { return global.values },
    get globalParamsLoaded() { return global.loaded },
    setGlobalParam: (key, value) => {
      global.values = { ...global.values, [key]: value } as ParamSnapshot
      deps.edited()
    },
    persistGlobalParams,
    publicationOf,
    retryParamPublication,
    applyGlobal: patch => {
      global.values = paramSnapshot(readParamOverridesPatch(patch))
      global.baseline = { ...global.values }
      global.loadedKeys = new Set(SHARED_PARAM_KEYS.filter(key => Object.hasOwn(patch, key)))
      global.loaded = true
      deps.changed()
    },
    reloadModules: () => {
      for (const [moduleId, entry] of entries) {
        if (!deps.isPresent(moduleId)) { entries.delete(moduleId); continue }
        entry.loaded = false
        void read(moduleId)
      }
    },
    refreshModules: () => {
      for (const [moduleId, entry] of entries) {
        if (!deps.isPresent(moduleId)) { entries.delete(moduleId); continue }
        if (deps.hasRawDraft(moduleId) || !deepEqual(entry.values, entry.baseline)) continue
        if (!deps.declares(moduleId)) {
          entry.values = { ...EMPTY_PARAMS }; entry.baseline = { ...EMPTY_PARAMS }; entry.loadedKeys.clear(); entry.loaded = true
          continue
        }
        entry.loaded = false
        void read(moduleId)
      }
    },
  }
}

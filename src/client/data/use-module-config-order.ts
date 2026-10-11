import { useEffect, useRef, useState } from 'react'
import { configIdentityKey, type ModuleConfigOrderSnapshot } from '../../shared/module-config-order.ts'
import type { PromptConfigDraft } from '../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../locales.ts'
import { bridgeCall, errorMessage, type BridgeResult } from './bridge-client.ts'
import { moduleOrderConfigs } from './prompt-config-order.ts'

/** 排序载荷：完整身份列表 + 读取时的版本；正文、路径与序号都不进排序请求。 */
export interface ModuleConfigOrderRequest {
  expectedRevision: string
  entries: Array<{ moduleId: string; configId: string }>
}

/** 会话状态；hook 把它投影成 React state，测试直接读它。 */
export interface ModuleConfigOrderState {
  snapshot?: ModuleConfigOrderSnapshot
  configs: PromptConfigDraft[]
  busy: boolean
  error: string
}

export interface ModuleConfigOrderDeps {
  t: PromptToolTranslate
  /** 发一次排序请求：无载荷 = 读取，带载荷 = 保存。 */
  request: (body?: ModuleConfigOrderRequest) => Promise<BridgeResult<ModuleConfigOrderSnapshot>>
  /** 保存成功后刷新各模块规则版本；返回 `false` 表示刷新失败。 */
  reloadConfigs?: () => Promise<boolean>
  /** 状态变化通知（hook 用它触发重渲染）。 */
  notify?: (state: ModuleConfigOrderState) => void
}

export interface ModuleConfigOrderSession {
  readonly state: ModuleConfigOrderState
  load(): Promise<boolean>
  save(next: PromptConfigDraft[]): Promise<void>
  reset(): void
  dispose(): void
}

const emptyState = (): ModuleConfigOrderState => ({ configs: [], busy: false, error: '' })

/**
 * 跨模块排序的请求生命周期，全仓唯一一份：
 * 序号失效（`reset`／`dispose` 后迟到响应不写入）、busy 去重、保存携带完整身份列表与当次 revision、
 * 失败后重读、成功后刷新各模块规则版本。
 *
 * 独立成会话对象而不是全塞进 hook：React state 在 SSR 下不可观察，而「迟到响应不写入」这类
 * 时序断言只能在会话自己的状态对象上做——hook 只负责把状态投影成 React state。
 */
export function createModuleConfigOrderSession(deps: ModuleConfigOrderDeps): ModuleConfigOrderSession {
  let state = emptyState()
  let generation = 0
  let busy = false
  const commit = (next: Partial<ModuleConfigOrderState>): void => {
    state = { ...state, ...next }
    deps.notify?.(state)
  }
  /** 读取排序；`keepError` 为真时保留已有错误——失败后的自动重读不得静默清掉那次失败。 */
  const read = async (keepError: boolean): Promise<boolean> => {
    const request = generation
    try {
      const result = await deps.request()
      if (request !== generation) return false
      if (!result.ok) throw new Error(result.message ?? deps.t('moduleOrder.unavailable'))
      commit({
        snapshot: result.value,
        configs: moduleOrderConfigs(result.value.entries),
        ...(keepError ? {} : { error: '' }),
      })
      return true
    } catch (cause) {
      if (request !== generation) return false
      commit({ error: deps.t('moduleOrder.readFailed', { reason: errorMessage(cause) }) })
      return false
    }
  }
  const load = async (): Promise<boolean> => {
    if (busy) return false
    busy = true
    const request = generation
    commit({ busy: true })
    const loaded = await read(false)
    if (request === generation) { busy = false; commit({ busy: false }) }
    return loaded
  }
  const save = async (next: PromptConfigDraft[]): Promise<void> => {
    const snapshot = state.snapshot
    if (busy || snapshot === undefined || next === state.configs) return
    busy = true
    const request = generation
    commit({ busy: true, configs: next })
    try {
      const byId = new Map(snapshot.entries.map(entry => [configIdentityKey(entry), entry]))
      const result = await deps.request({
        expectedRevision: snapshot.revision,
        entries: next.map(config => {
          const entry = byId.get(config.id)
          if (entry === undefined) throw new Error(deps.t('moduleOrder.unavailable'))
          return { moduleId: entry.moduleId, configId: entry.configId }
        }),
      })
      if (request !== generation) return
      if (!result.ok) throw new Error(result.message ?? deps.t('moduleOrder.unavailable'))
      // 即使已切到另一页也刷新 store，避免后续单模块编辑沿用旧序号。
      const refreshed = await deps.reloadConfigs?.()
      if (request !== generation) return
      busy = false
      commit({
        snapshot: result.value,
        configs: moduleOrderConfigs(result.value.entries),
        error: refreshed === false ? deps.t('moduleOrder.refreshFailed') : '',
        busy: false,
      })
    } catch (cause) {
      if (request !== generation) return
      busy = false
      commit({ busy: false, error: deps.t('moduleOrder.saveFailed', { reason: errorMessage(cause) }) })
      // 失败后重读：拖拽用的 revision 已过期，不重读会反复 409；重读不静默清掉这次失败。
      await read(true)
    }
  }
  const invalidate = (): void => { generation += 1; busy = false }
  return {
    get state() { return state },
    load,
    save,
    reset() { invalidate(); commit({ snapshot: undefined, configs: [], busy: false, error: '' }) },
    dispose() { invalidate() },
  }
}

/**
 * 跨模块范围只持有排序摘要；正文草稿始终留在当前模块的 store 中。
 *
 * **hook 不自带首读**：调用方必须在 effect 里调用 `load()`（`RulesWorkspace` 在规则版本与
 * 启用表变化时读），否则排序列表恒空；`reset()` 用于编辑目标变化，`save(next)` 需要先有快照。
 */
export function useModuleConfigOrder(t: PromptToolTranslate, reloadConfigs?: () => Promise<boolean>) {
  const [state, setState] = useState<ModuleConfigOrderState>(emptyState)
  const latest = useRef({ t, reloadConfigs })
  latest.current = { t, reloadConfigs }
  const session = useRef<ModuleConfigOrderSession | null>(null)
  session.current ??= createModuleConfigOrderSession({
    get t() { return latest.current.t },
    get reloadConfigs() { return latest.current.reloadConfigs },
    request: (body) => bridgeCall('moduleConfigOrder', body),
    notify: setState,
  })
  useEffect(() => () => { session.current?.dispose() }, [])
  const current = session.current
  return { ...state, load: current.load, save: current.save, reset: current.reset }
}

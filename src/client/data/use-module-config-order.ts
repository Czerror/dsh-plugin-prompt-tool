import { useCallback, useEffect, useRef, useState } from 'react'
import { configIdentityKey, type ModuleConfigOrderSnapshot } from '../../shared/module-config-order.ts'
import type { PromptConfigDraft } from '../prompt-tool-types.ts'
import type { PromptToolTranslate } from '../locales.ts'
import { bridgeCall, errorMessage } from './bridge-client.ts'
import { moduleOrderConfigs } from './prompt-config-order.ts'

/** 跨模块范围只持有排序摘要；正文草稿始终留在当前模块的 store 中。 */
export function useModuleConfigOrder(t: PromptToolTranslate, reloadConfigs?: () => Promise<boolean>) {
  const [snapshot, setSnapshot] = useState<ModuleConfigOrderSnapshot>()
  const [configs, setConfigs] = useState<PromptConfigDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const generation = useRef(0)
  useEffect(() => () => { generation.current += 1 }, [])
  const reset = useCallback(() => {
    generation.current += 1
    busyRef.current = false
    setBusy(false)
    setSnapshot(undefined)
    setConfigs([])
    setError('')
  }, [])
  const load = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    const request = generation.current
    try {
      const result = await bridgeCall('moduleConfigOrder')
      if (request !== generation.current) return false
      if (!result.ok) throw new Error(result.message ?? t('moduleOrder.unavailable'))
      setSnapshot(result.value)
      setConfigs(moduleOrderConfigs(result.value.entries))
      setError('')
      return true
    } catch (cause) {
      if (request === generation.current) setError(t('moduleOrder.readFailed', { reason: errorMessage(cause) }))
      return false
    } finally {
      if (request === generation.current) { busyRef.current = false; setBusy(false) }
    }
  }, [t])
  const save = useCallback(async (next: PromptConfigDraft[]): Promise<void> => {
    if (busyRef.current || snapshot === undefined || next === configs) return
    busyRef.current = true
    setBusy(true)
    setConfigs(next)
    const request = generation.current
    try {
      const byId = new Map(snapshot.entries.map(entry => [configIdentityKey(entry), entry]))
      const result = await bridgeCall('moduleConfigOrder', {
        expectedRevision: snapshot.revision,
        entries: next.map(config => {
          const entry = byId.get(config.id)
          if (entry === undefined) throw new Error(t('moduleOrder.unavailable'))
          return { moduleId: entry.moduleId, configId: entry.configId }
        }),
      })
      if (!result.ok) throw new Error(result.message ?? t('moduleOrder.unavailable'))
      // 即使已切到另一页也刷新 store，避免后续单模块编辑沿用旧序号。
      const refreshed = await reloadConfigs?.()
      if (request !== generation.current) return
      setSnapshot(result.value)
      setConfigs(moduleOrderConfigs(result.value.entries))
      setError(refreshed === false ? t('moduleOrder.refreshFailed') : '')
    } catch (cause) {
      if (request === generation.current) setError(t('moduleOrder.saveFailed', { reason: errorMessage(cause) }))
    } finally {
      if (request === generation.current) { busyRef.current = false; setBusy(false) }
    }
  }, [snapshot, configs, reloadConfigs, t])
  return { snapshot, configs, busy, error, load, save, reset }
}

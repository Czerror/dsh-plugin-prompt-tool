import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { bridgeCall } from '../../data/bridge-client.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { ToggleRow } from '../../ui/ToggleRow.tsx'
import type { PromptToolWorkbenchFace } from './workbench-face.ts'
import ui from '../../ui/controls.module.css'
/** settings.plugins.tab：基础开关（settings 命名空间直读直写，官方 SettingsScope 通道）。 */
type TabProps = PropsRuntime<'settings.plugins.tab'> & InjectFace<PromptToolWorkbenchFace> & PropsLocale<'prompt-tool'>

export function SettingsTab(props: TabProps): ReactNode {
  const { t } = props
  const scope = props.settings.scope
  // useSyncExternalStore 需要稳定的函数引用；直接传方法引用会脱离 this 调用。
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const value = (snapshot.value ?? {}) as Record<string, unknown>
  const [presets, setPresets] = useState<Array<{ id: string; name: string }>>([])
  const [switchingPreset, setSwitchingPreset] = useState(false)
  const [presetNotice, setPresetNotice] = useState<{ kind: 'ok' | 'error'; message: string }>()
  useEffect(() => {
    void bridgeCall('meta')
      .then((res) => {
        if (!res.ok) return
        const meta = res.value.meta as { presets?: Array<{ id: string; name: string }> }
        if (meta.presets !== undefined) setPresets(meta.presets)
      })
      .catch(() => {})
  }, [])
  const set = (field: string, next: unknown): void => { void scope.set(field, next) }
  const switchPreset = async (id: string): Promise<void> => {
    if (switchingPreset || id === value.presetTemplate) return
    setSwitchingPreset(true)
    setPresetNotice(undefined)
    try {
      // 先持久化默认值：Host applyState 会物化目标预设并同步 agent-presets default；
      // settlement 后再重组当前空会话，避免目标生成物尚未就绪。
      await scope.set('presetTemplate', id)
      const result = await props.api.switchPreset(id)
      if (result.applied) {
        setPresetNotice({ kind: 'ok', message: t('settings.switched', { id }) })
      } else if (result.message !== undefined) {
        setPresetNotice({ kind: 'error', message: t('settings.switchDefaultOnly', { id, reason: result.message }) })
      } else {
        setPresetNotice({ kind: 'ok', message: t('settings.switchPending', { id }) })
      }
    } catch (error) {
      setPresetNotice({ kind: 'error', message: t('settings.switchFailed', { reason: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setSwitchingPreset(false)
    }
  }

  return (
    <section className={ui.section} aria-label={t('settings.aria')}>
      <ToggleRow id="pt-writePreset" label={t('settings.writePreset.label')} hint={t('settings.writePreset.hint')} checked={value.writePreset === true} onChange={(v) => set('writePreset', v)} />
      <div className={ui.rowGroup}>
        <div className={ui.settingRowStack}>
          <span className={ui.settingCopy}><strong>{t('settings.presetTemplate.title')}</strong><small>{t('settings.presetTemplate.hint')}</small></span>
          <MenuSelect className={ui.directoryInput} ariaLabel={t('settings.presetTemplate.title')}
            value={typeof value.presetTemplate === 'string' ? value.presetTemplate : ''}
            disabled={!snapshot.writable || switchingPreset}
            compact={false}
            options={presets.map((preset) => ({ value: preset.id, label: preset.name }))}
            onChange={(id) => { void switchPreset(id) }} />
          {presetNotice !== undefined && (
            <p className={presetNotice.kind === 'error' ? ui.noticeError : ui.notice} role="status">
              {presetNotice.message}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

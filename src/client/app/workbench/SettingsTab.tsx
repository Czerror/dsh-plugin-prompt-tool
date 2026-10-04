import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ToggleRow } from '../../ui/ToggleRow.tsx'
import { modulesEnabledOps, readModulesEnabled } from '../../../shared/module-settings.ts'
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
  const setModulesEnabled = (next: boolean): void => { void scope.mutate(modulesEnabledOps(next)) }

  return (
    <section className={ui.section} aria-label={t('settings.aria')}>
      <ToggleRow id="pt-modules-enabled" label={t('settings.modulesEnabled.label')} hint={t('settings.modulesEnabled.hint')}
        disabled={!snapshot.writable} checked={readModulesEnabled(value)} onChange={setModulesEnabled} />
    </section>
  )
}

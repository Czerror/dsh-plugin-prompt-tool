/** 模块列表统一管理所有导入来源；编辑目标与模块启用集合独立。 */
import { memo, useEffect, type ReactNode } from 'react'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { ModuleSwitcher } from './ModuleSwitcher.tsx'
import sharedCss from '../../ui/controls.module.css'

const ui = sharedCss
import type { DraftsPort, ModuleActionsPort, ModuleFactsPort, NoticePort } from '../../data/store-ports.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { RuleDiagnosticsSession } from '../../data/rule-diagnostics-session.ts'
import { DiagnosticsPanel } from './DiagnosticsPanel.tsx'

export const ModulesPage = memo(function ModulesPage(
  /** 本页只读 `meta.moduleWarnings`，其余面透传给子组件（并集）。 */
  props: {
    store: ModuleActionsPort & ModuleFactsPort & NoticePort & DraftsPort
    t: PromptToolTranslate; onReady?: () => void; diagnostics?: RuleDiagnosticsSession
  },
): ReactNode {
  const { store, t } = props
  useEffect(() => { props.onReady?.() }, [props.onReady])
  const fields = usePromptToolFields(store, (value) => value)
  return (
    <>
      {!fields.modulesEnabled && <p className={ui.configFieldHint}>{t('configs.readOnly.disabled')}</p>}
      {store.meta.moduleWarnings?.map(message => <p key={message} role="alert" className={ui.configFieldHint}>{message}</p>)}
      {props.diagnostics !== undefined && <DiagnosticsPanel diagnostics={props.diagnostics} t={t} />}
      <ModuleSwitcher store={store} t={t} />
    </>
  )
})

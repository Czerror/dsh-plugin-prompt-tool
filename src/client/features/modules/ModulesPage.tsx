/** 模块列表统一管理所有导入来源；编辑目标与模块启用集合独立。 */
import { memo, useEffect, useState, type ReactNode } from 'react'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { ModuleSwitcher } from './ModuleSwitcher.tsx'
import { ModuleMergeDialog } from './ModuleMergeDialog.tsx'
import { Button } from '../../ui/Button.tsx'
import sharedCss from '../../ui/controls.module.css'

const ui = sharedCss
import type { DraftsPort, ModuleActionsPort, ModuleFactsPort, NoticePort } from '../../data/store-ports.ts'
import type { PromptToolTranslate } from '../../locales.ts'

export const ModulesPage = memo(function ModulesPage(
  /** 本页只读 `meta.moduleWarnings`，其余面透传给子组件（并集）。 */
  props: {
    store: ModuleActionsPort & ModuleFactsPort & NoticePort & DraftsPort
    t: PromptToolTranslate; onReady?: () => void
  },
): ReactNode {
  const { store, t } = props
  const [mergeOpen, setMergeOpen] = useState(false)
  useEffect(() => { props.onReady?.() }, [props.onReady])
  const fields = usePromptToolFields(store, (value) => value)
  return (
    <>
      {!fields.modulesEnabled && <p className={ui.configFieldHint}>{t('configs.readOnly.disabled')}</p>}
      {store.meta.moduleWarnings?.map(message => <p key={message} role="alert" className={ui.configFieldHint}>{message}</p>)}
      <ModuleSwitcher store={store} t={t} />
      <Button variant="outline" shape="pill" size="md" onClick={() => setMergeOpen(true)}>{t('moduleMerge.title')}</Button>
      {mergeOpen && <ModuleMergeDialog store={store} t={t} onClose={() => setMergeOpen(false)} />}
    </>
  )
})

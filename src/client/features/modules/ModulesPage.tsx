/** 模块列表统一管理所有导入来源；编辑目标与模块启用集合独立。 */
import { memo, useEffect, type ReactNode } from 'react'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { ModuleSwitcher } from './ModuleSwitcher.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './modules.module.css'

const ui = { ...sharedCss, ...featureCss }
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'

export const ModulesPage = memo(function ModulesPage(
  props: { store: PromptToolStore; t: PromptToolTranslate; onReady?: () => void },
): ReactNode {
  const { store, t } = props
  useEffect(() => { props.onReady?.() }, [props.onReady])
  const fields = usePromptToolFields(store, (value) => value)
  return (
    <>
      {!fields.modulesEnabled && <p className={ui.configFieldHint}>{t('configs.readOnly.disabled')}</p>}
      {store.meta.moduleWarnings?.map(message => <p key={message} role="alert" className={ui.configFieldHint}>{message}</p>)}
      <ModuleSwitcher store={store} t={t} />
    </>
  )
})

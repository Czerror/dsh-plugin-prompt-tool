import { memo, useCallback, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../../data/use-prompt-tool-fields.ts'
import { PromptConfigList } from '../../../PromptConfigList.tsx'
import { TemplatePicker } from '../../../TemplatePicker.tsx'
import { useTemplatePicker } from '../../../useTemplatePicker.ts'
import ui from '../../../PromptUi.module.css'
/** 配置列表 + 新建模板：六层页按 layer 过滤，子代理页按 scope 过滤（subagent 只列子代理可见模板）。 */
export const ConfigListWithTemplates = memo(function ConfigListWithTemplates(props: { store: PromptToolStore; layer?: string; scope?: 'main' | 'subagent'; beforeCards?: ReactNode }): ReactNode {
  const { store, layer, scope, beforeCards } = props
  const fields = usePromptToolFields(store, (value) => value)
  // 稳定回调：卡片 memo 的生效前提（store 引用已稳定）。
  const patchConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    store.patch({ promptConfigs: configs })
  }, [store])
  const saveConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    void store.persistConfigs(configs)
  }, [store])
  // 当前预设模板消息批层无配置时，pre-step 层空状态追加提示（列表仍可自定义：
  // 新建配置作为 settings 覆盖层保存，切换预设后保留）。
  const preStepEmpty = store.templatePreStepCount === 0 && (layer === undefined || layer === 'pre-step')
  const templatePicker = useTemplatePicker(
    fields.promptConfigs,
    (config) => store.patch({ promptConfigs: [...fields.promptConfigs, config] }),
    store.showNotice,
  )
  return (
    <>
      <PromptConfigList
        meta={store.meta}
        configs={fields.promptConfigs}
        savedConfigs={store.savedConfigs}
        layer={layer}
        scope={scope}
        beforeCards={beforeCards}
        emptyHint={preStepEmpty ? '当前预设模板消息批层无配置；可新建自定义配置（作为 settings 覆盖层，切换预设后仍保留）。' : undefined}
        extraActions={
          <button type="button" className={ui.primaryPill} onClick={templatePicker.openPicker}>新建</button>
        }
        onPatchConfigs={patchConfigs}
        onSaveConfigs={saveConfigs}
        onNotice={store.showNotice}
      />
      {templatePicker.open && (
        <TemplatePicker templates={templatePicker.templates} layer={layer} onPick={templatePicker.pickTemplate} onClose={templatePicker.closePicker} />
      )}
    </>
  )
})

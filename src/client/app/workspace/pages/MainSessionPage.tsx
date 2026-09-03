import { memo, useCallback, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../../data/use-prompt-tool-fields.ts'
import { PromptConfigsEditor } from '../../../features/prompts/PromptConfigsEditor.tsx'
import { ModelRouteStatus } from './ModelRouteStatus.tsx'
import ui from '../../../PromptUi.module.css'
/** 主会话页：主对话参数 + Preset/AGENTS 内容 + 管线状态卡 + 模块库（层筛选）。
 *  注入层 tab 已并入本页（层专属开关与内容资产卡片），模块库按层级下拉筛选浏览。 */
export const MainSessionPage = memo(function MainSessionPage(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  // L3 selector 化：fields 引用变化才重渲染（父级 loading/notice/page 变化不再级联）。
  const fields = usePromptToolFields(store, (value) => value)
  // 稳定回调：卡片 memo 的生效前提（store 引用已稳定）。
  const patchConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    store.patch({ promptConfigs: configs })
  }, [store])
  const saveConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    void store.persistConfigs(configs)
  }, [store])
  return (
    <section className={ui.section} aria-label="主会话与全局">
      <ModelRouteStatus store={store} />
      <PromptConfigsEditor
        meta={store.meta}
        configs={fields.promptConfigs}
        savedConfigs={store.savedConfigs}
        onPatchConfigs={patchConfigs}
        onSaveConfigs={saveConfigs}
        onNotice={store.showNotice}
        templateVariables={store.templateVariables}
        setTemplateVariables={store.setTemplateVariables}
        templateVariablesEnabled={store.templateVariablesEnabled}
        setTemplateVariablesEnabled={store.setTemplateVariablesEnabled}
        saveTemplateVariables={store.saveTemplateVariables}
        store={store}
        currentSessionId={store.api.currentSessionId()}
      />
    </section>
  )
})

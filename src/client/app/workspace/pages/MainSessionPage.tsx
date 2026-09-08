import { memo, useCallback, useState, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../../data/use-prompt-tool-fields.ts'
import { PromptConfigsEditor } from '../../../features/prompts/PromptConfigsEditor.tsx'
import { ModelRouteModuleCard } from '../../../features/models/ModelRouteCard.tsx'
import { EngineModuleActions, EngineModuleCards, EnginePromptDefaultsCard } from '../../../features/modules/EngineModuleList.tsx'
import { CustomToolsCard } from '../../../features/tools/CustomToolsCard.tsx'
import ui from '../../../ui/controls.module.css'
/** 主会话页：公共配置与按六个插入点归类的统一模块列表。 */
export const MainSessionPage = memo(function MainSessionPage(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  // L3 selector 化：fields 引用变化才重渲染（父级 loading/notice/page 变化不再级联）。
  const fields = usePromptToolFields(store, (value) => value)
  const [layerFilter, setLayerFilter] = useState('all')
  const changeLayerFilter = useCallback((value: string) => {
    setLayerFilter(value)
  }, [])
  // 稳定回调：卡片 memo 的生效前提（store 引用已稳定）。
  const patchConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    store.patch({ promptConfigs: configs })
  }, [store])
  const saveConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    void store.persistConfigs(configs)
  }, [store])
  const renderLayerCards = useCallback((layer: string): ReactNode => (
    <>
      <EngineModuleCards store={store} layerFilter={layer} showActions={false} showPromptDefaults={false} showStatus={false} />
      {layer === 'tool-pipeline' && (
        <CustomToolsCard
          key={fields.presetTemplate}
          presetId={fields.presetTemplate}
          onNotice={store.showNotice}
          disabled={store.moduleFacts?.editable !== true || !fields.writePreset}
        />
      )}
    </>
  ), [fields.presetTemplate, fields.writePreset, store, store.moduleFacts?.editable])
  return (
    <section className={ui.section} aria-label="主会话与全局">
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
        viewFilter={layerFilter}
        onViewFilterChange={changeLayerFilter}
        commonCards={
          <div className={ui.configList}>
            <ModelRouteModuleCard store={store} scope="main" />
            <EnginePromptDefaultsCard store={store} />
          </div>
        }
        toolbarActions={<EngineModuleActions store={store} />}
        layerCards={renderLayerCards}
      />
    </section>
  )
})

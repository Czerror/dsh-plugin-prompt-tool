import { memo, useCallback, useState, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../../data/use-prompt-tool-fields.ts'
import { PromptConfigsEditor } from '../../../features/prompts/PromptConfigsEditor.tsx'
import { useTemplatePicker } from '../../../features/prompts/useTemplatePicker.ts'
import { ModelRouteModuleCard } from '../../../features/models/ModelRouteCard.tsx'
import { EngineModuleActions, EngineModuleCards, EnginePromptDefaultsCard } from '../../../features/modules/EngineModuleList.tsx'
import { CustomToolsCard, type ToolCreateIntent } from '../../../features/tools/CustomToolsCard.tsx'
import { TemplatePicker } from '../../../ui/TemplatePicker.tsx'
import ui from '../../../ui/controls.module.css'
/** 主会话页：公共配置 + 平铺模块列表 + 合并创建菜单（提示词配置 / 工具 / 能力模块）。 */
export const MainSessionPage = memo(function MainSessionPage(props: { store: PromptToolStore }): ReactNode {
  const { store } = props
  // L3 selector 化：fields 引用变化才重渲染（父级 loading/notice/page 变化不再级联）。
  const fields = usePromptToolFields(store, (value) => value)
  const [viewFilter, setViewFilter] = useState('all')
  const changeViewFilter = useCallback((value: string) => {
    setViewFilter(value)
  }, [])
  const [variablesExpanded, setVariablesExpanded] = useState(false)
  const [toolCreate, setToolCreate] = useState<ToolCreateIntent>()
  // 稳定回调：卡片 memo 的生效前提（store 引用已稳定）。
  const patchConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    store.patch({ promptConfigs: configs })
  }, [store])
  const saveConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    void store.persistConfigs(configs)
  }, [store])
  // 模板浮层由页面持有：合并菜单的「从模板新建」同时提供提示词模板、工具模板和变量入口。
  const picker = useTemplatePicker(
    fields.promptConfigs,
    (config) => patchConfigs([...fields.promptConfigs, config]),
    store.showNotice,
  )
  const canEditPreset = store.fields.writePreset && store.moduleFacts?.editable === true
  const createItems = [
    { id: 'create:template', label: '从模板新建…' },
    ...(canEditPreset ? [{ id: 'create:blank-tool', label: '新建空白工具' }] : []),
  ]
  const onCreateSelect = useCallback((id: string) => {
    if (id === 'create:template') picker.openPicker()
    else if (id === 'create:blank-tool') setToolCreate({ kind: 'blank' })
  }, [picker])
  const insertToolTemplate = useCallback((spec: Record<string, unknown>) => {
    setToolCreate({ kind: 'template', spec })
  }, [])
  const pickVariables = useCallback(() => {
    store.setTemplateVariables({ ...store.templateVariables, '': '' })
    setVariablesExpanded(true)
    picker.closePicker()
  }, [picker, store])
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
        viewFilter={viewFilter}
        onViewFilterChange={changeViewFilter}
        variablesExpanded={variablesExpanded}
        onVariablesExpandedChange={setVariablesExpanded}
        commonCards={
          <div className={ui.configList}>
            <ModelRouteModuleCard store={store} scope="main" />
            <EnginePromptDefaultsCard store={store} />
          </div>
        }
        toolbarActions={<EngineModuleActions store={store} anchorRef={picker.anchorRef} extraItems={createItems} onExtraSelect={onCreateSelect} />}
        afterCards={
          <>
            <EngineModuleCards store={store} showActions={false} showPromptDefaults={false} showStatus={false} />
            <CustomToolsCard
              key={fields.presetTemplate}
              presetId={fields.presetTemplate}
              onNotice={store.showNotice}
              disabled={!canEditPreset}
              createIntent={toolCreate}
              onIntentConsumed={() => setToolCreate(undefined)}
            />
          </>
        }
      />
      {picker.open && (
        <TemplatePicker
          anchorRef={picker.anchorRef}
          templates={picker.templates}
          toolTemplates={picker.toolTemplates}
          onPick={picker.pickTemplate}
          onPickTool={insertToolTemplate}
          onPickVariables={pickVariables}
          onClose={picker.closePicker}
        />
      )}
    </section>
  )
})

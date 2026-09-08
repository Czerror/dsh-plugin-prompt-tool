import { memo, useCallback, useState, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../../data/use-prompt-tool-fields.ts'
import { PromptConfigsEditor } from '../../../features/prompts/PromptConfigsEditor.tsx'
import { useTemplatePicker } from '../../../features/prompts/useTemplatePicker.ts'
import { INSERTION_LAYERS, LAYER_LABELS } from '../../../features/prompts/prompt-config-policy.ts'
import { ModelRouteModuleCard } from '../../../features/models/ModelRouteCard.tsx'
import { PresetPersonaCard } from '../../../features/persona/PresetPersonaCard.tsx'
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
  // 模板浮层由页面持有：合并菜单按插入点层级平铺「添加模板 · 层级」入口，浮层只列该层模板。
  const picker = useTemplatePicker(
    fields.promptConfigs,
    (config) => patchConfigs([...fields.promptConfigs, config]),
    store.showNotice,
  )
  const canEditPreset = store.fields.writePreset && store.moduleFacts?.editable === true
  const pickVariables = useCallback(() => {
    store.setTemplateVariables({ ...store.templateVariables, '': '' })
    setVariablesExpanded(true)
    picker.closePicker()
  }, [picker, store])
  const createItems = [
    ...INSERTION_LAYERS.map((layer) => ({ id: `tpl:${layer}`, label: `添加模板 · ${LAYER_LABELS[layer] ?? layer}` })),
    { id: 'create:tool-template', label: '添加工具模板…' },
    { id: 'create:variables', label: '添加模板变量' },
    ...(canEditPreset ? [{ id: 'create:blank-tool', label: '新建空白工具' }] : []),
  ]
  const onCreateSelect = useCallback((id: string) => {
    if (id.startsWith('tpl:')) picker.openPicker(id.slice(4))
    else if (id === 'create:tool-template') picker.openTools()
    else if (id === 'create:variables') pickVariables()
    else if (id === 'create:blank-tool') setToolCreate({ kind: 'blank' })
  }, [picker, pickVariables])
  const insertToolTemplate = useCallback((spec: Record<string, unknown>) => {
    setToolCreate({ kind: 'template', spec })
  }, [])
  return (
    <section className={ui.section} aria-label="主会话与全局">
      <PromptConfigsEditor
        meta={store.meta}
        configs={fields.promptConfigs}
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
            <PresetPersonaCard presetId={fields.presetTemplate} disabled={!canEditPreset} onNotice={store.showNotice} />
            <ModelRouteModuleCard store={store} scope="main" />
            <EnginePromptDefaultsCard store={store} />
          </div>
        }
        toolbarActions={<EngineModuleActions store={store} anchorRef={picker.anchorRef} extraItems={createItems} onExtraSelect={onCreateSelect} />}
        afterCards={
          <>
            <EngineModuleCards store={store} layerFilter={viewFilter} showActions={false} showPromptDefaults={false} showStatus={viewFilter !== 'all'} />
            {(viewFilter === 'all' || viewFilter === 'tool-pipeline') && (
              <CustomToolsCard
                key={fields.presetTemplate}
                presetId={fields.presetTemplate}
                onNotice={store.showNotice}
                disabled={!canEditPreset}
                createIntent={toolCreate}
                onIntentConsumed={() => setToolCreate(undefined)}
              />
            )}
          </>
        }
      />
      {picker.open && (
        <TemplatePicker
          anchorRef={picker.anchorRef}
          templates={picker.toolsOnly ? [] : picker.templates}
          layer={picker.layer}
          toolTemplates={picker.layer === undefined ? picker.toolTemplates : undefined}
          onPick={picker.pickTemplate}
          onPickTool={insertToolTemplate}
          onPickVariables={picker.layer === undefined && !picker.toolsOnly ? pickVariables : undefined}
          onClose={picker.closePicker}
        />
      )}
    </section>
  )
})

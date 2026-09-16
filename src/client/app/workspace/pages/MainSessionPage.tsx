import { memo, useCallback, useState, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../../data/use-prompt-tool-fields.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { PromptConfigsEditor } from '../../../features/prompts/PromptConfigsEditor.tsx'
import { WorldBookDiagnosticsCard } from '../../../features/prompts/WorldBookDiagnosticsCard.tsx'
import { useTemplatePicker } from '../../../features/prompts/useTemplatePicker.ts'
import { INSERTION_LAYERS, LAYER_LABEL_KEYS, translateLabel } from '../../../features/prompts/prompt-config-policy.ts'
import { ModelRouteModuleCard } from '../../../features/models/ModelRouteCard.tsx'
import { PresetPersonaCard } from '../../../features/persona/PresetPersonaCard.tsx'
import { EngineModuleActions, EngineModuleCards, EnginePromptDefaultsCard } from '../../../features/modules/EngineModuleList.tsx'
import { CustomToolsCard, type ToolCreateIntent } from '../../../features/tools/CustomToolsCard.tsx'
import { SubagentToolPolicyCard } from '../../../features/subagents/SubagentToolPolicyCard.tsx'
import { TemplatePicker } from '../../../ui/TemplatePicker.tsx'
import ui from '../../../ui/controls.module.css'
import type { InstructionPolicyFileOverride } from '../../../../shared/instructions.ts'
/** 主会话页：公共配置 + 平铺模块列表 + 合并创建菜单（提示词配置 / 工具 / 能力模块）。 */
export const MainSessionPage = memo(function MainSessionPage(props: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  const { store, t } = props
  // L3 selector 化：fields 引用变化才重渲染（父级 loading/notice/page 变化不再级联）。
  const fields = usePromptToolFields(store, (value) => value)
  const [viewFilter, setViewFilter] = useState('all')
  const changeViewFilter = useCallback((value: string) => {
    setViewFilter(value)
  }, [])
  const [variablesExpanded, setVariablesExpanded] = useState(false)
  const [toolCreate, setToolCreate] = useState<ToolCreateIntent>()
  /** 新建能力后的定位信号：token 递增，保证重复创建同一能力仍会再次展开并跳转。 */
  const [focusCapability, setFocusCapability] = useState<{ id: string; token: number }>()
  // 创建后只定位并展开新卡，不改动用户选定的列表筛选。
  const revealCapability = useCallback((id: string) => {
    setFocusCapability((current) => ({ id, token: (current?.token ?? 0) + 1 }))
  }, [])
  // 稳定回调：卡片 memo 的生效前提（store 引用已稳定）。
  const patchConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    store.patch({ promptConfigs: configs })
  }, [store])
  const saveConfigs = useCallback((configs: PromptToolStore['fields']['promptConfigs']) => {
    return store.persistConfigs(configs)
  }, [store])
  // 指令文件卡：正文只显式写盘（不随预设 debounce），冲突时用重新读取恢复。
  const saveInstructionFile = useCallback((fileId: string) => {
    void store.persistInstructionFiles([fileId])
  }, [store])
  const reloadInstructionFile = useCallback((fileId: string) => {
    void store.reloadInstructionFile(fileId)
  }, [store])
  // 指令卡行为策略：独立存储，改动按 revision 乐观提交（不写 preset.yml）。
  const patchInstructionPolicy = useCallback((fileId: string, override: InstructionPolicyFileOverride) => {
    void store.updateInstructionPolicy(fileId, override)
  }, [store])
  // 模板浮层由页面持有：合并菜单按插入点层级平铺「添加模板 · 层级」入口，浮层只列该层模板。
  // 作用域 = 主会话：新建配置清除模板自带的「仅子代理」限制（缺省 = 公用，两侧都可见）。
  const picker = useTemplatePicker(
    fields.promptConfigs,
    (config) => patchConfigs([...store.getFields().promptConfigs, config]),
    store.showNotice,
    t,
    'main',
  )
  const canEditPreset = store.fields.writePreset && store.moduleFacts?.editable === true
  const pickVariables = useCallback(() => {
    store.setTemplateVariables({ ...store.templateVariables, '': '' })
    setVariablesExpanded(true)
    picker.closePicker()
  }, [picker, store])
  const createItems = [
    ...INSERTION_LAYERS.map((layer) => ({ id: `tpl:${layer}`, label: t('main.addTemplate', { layer: translateLabel(t, LAYER_LABEL_KEYS, layer) }) })),
    { id: 'create:tool-template', label: t('main.addToolTemplate') },
    { id: 'create:variables', label: t('main.addVariables') },
    ...(canEditPreset ? [{ id: 'create:blank-tool', label: t('main.newBlankTool') }] : []),
  ]
  const onCreateSelect = useCallback((id: string) => {
    if (id.startsWith('tpl:')) picker.openPicker(id.slice(4))
    else if (id === 'create:tool-template') picker.openTools()
    else if (id === 'create:variables') pickVariables()
    else if (id === 'create:blank-tool') {
      setToolCreate({ kind: 'blank', presetId: fields.presetTemplate })
    }
  }, [fields.presetTemplate, picker, pickVariables])
  const insertToolTemplate = useCallback((spec: Record<string, unknown>) => {
    setToolCreate({ kind: 'template', spec, presetId: fields.presetTemplate })
    picker.closePicker()
  }, [fields.presetTemplate, picker])
  return (
    <section className={ui.section} aria-label={t('main.aria')}>
      <PromptConfigsEditor
        t={t}
        meta={store.meta}
        configs={fields.promptConfigs}
        createdConfigId={picker.createdConfigId}
        onPatchConfigs={patchConfigs}
        onSaveConfigs={saveConfigs}
        instructionPolicy={store.instructionPolicy}
        onToggleInstructionSource={store.setInstructionSourceEnabled}
        onSaveInstructionFile={saveInstructionFile}
        onReloadInstructionFile={reloadInstructionFile}
        onPatchInstructionPolicy={patchInstructionPolicy}
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
        beforeCards={
          <>
            <PresetPersonaCard t={t} presetId={fields.presetTemplate} disabled={!canEditPreset} onNotice={store.showNotice} />
            <div hidden={viewFilter !== 'world-book'}>
              <WorldBookDiagnosticsCard store={store} t={t} />
            </div>
          </>
        }
        commonCards={
          <div className={ui.configList}>
            <ModelRouteModuleCard store={store} scope="main" />
            <EnginePromptDefaultsCard store={store} t={t} />
          </div>
        }
        toolbarActions={<EngineModuleActions store={store} t={t} anchorRef={picker.anchorRef} extraItems={createItems} onExtraSelect={onCreateSelect} onCreated={revealCapability} />}
        moduleCards={
          <>
            <EngineModuleCards store={store} t={t} layerFilter={viewFilter} focusCapability={focusCapability} showActions={false} showPromptDefaults={false} showStatus={viewFilter !== 'all'}
              renderCapabilityExtra={({ capabilityId }) => capabilityId === 'subagent-tool-policy'
                ? (
                  <SubagentToolPolicyCard
                    key={fields.presetTemplate}
                    presetId={fields.presetTemplate}
                    t={t}
                    onNotice={store.showNotice}
                  />
                )
                : undefined} />
            <div hidden={viewFilter !== 'all' && viewFilter !== 'tool-pipeline'}>
              <CustomToolsCard
                key={fields.presetTemplate}
                presetId={fields.presetTemplate}
                t={t}
                onNotice={store.showNotice}
                disabled={!canEditPreset}
                createIntent={toolCreate}
                onIntentConsumed={() => setToolCreate(undefined)}
              />
            </div>
          </>
        }
      />
      {picker.open && (
        <TemplatePicker
          t={t}
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

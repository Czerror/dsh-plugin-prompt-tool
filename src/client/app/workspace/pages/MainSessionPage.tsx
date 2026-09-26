import { memo, useCallback, useState, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import { usePromptToolFields } from '../../../data/use-prompt-tool-fields.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { PromptConfigsEditor } from '../../../features/prompts/PromptConfigsEditor.tsx'
import { useTemplatePicker } from '../../../features/prompts/useTemplatePicker.ts'
import { INSERTION_LAYERS, LAYER_LABEL_KEYS, translateLabel } from '../../../features/prompts/prompt-config-policy.ts'
import { EngineModuleActions } from '../../../features/modules/EngineModuleList.tsx'
import { engineCapability } from '../../../../shared/engine-capabilities.ts'
import { engineLayerSlots } from './EngineLayersPanel.tsx'
import { TemplatePicker } from '../../../ui/TemplatePicker.tsx'
import { useCustomToolsEditor } from '../../../features/tools/CustomToolsCard.tsx'
import ui from '../../../ui/controls.module.css'
import type { InstructionPolicyFileOverride } from '../../../../shared/instructions.ts'
import type { ConfigPageBrowse } from '../workspace-browse-state.ts'
import type { WorkspacePage } from '../workspace-pages.ts'
/** 主会话页：公共配置 + 平铺模块列表 + 合并创建菜单（提示词配置 / 工具 / 能力模块）。 */
export const MainSessionPage = memo(function MainSessionPage(props: { store: PromptToolStore; t: PromptToolTranslate; browse?: ConfigPageBrowse; onNavigate?: (page: WorkspacePage) => void }): ReactNode {
  const { store, t } = props
  // L3 selector 化：fields 引用变化才重渲染（父级 loading/notice/page 变化不再级联）。
  const fields = usePromptToolFields(store, (value) => value)
  const [viewFilter, setViewFilter] = useState(props.browse?.viewFilter ?? 'all')
  const changeViewFilter = useCallback((value: string) => {
    if (props.browse !== undefined) props.browse.viewFilter = value
    setViewFilter(value)
  }, [props.browse])
  // 搜索词由页面持有：同一搜索词同时过滤配置实例、层设置区与本层资产。
  const [keyword, setKeyword] = useState(props.browse?.filter ?? '')
  /** 新建能力后的定位信号：token 递增；layer 用于滚动到该层实例卡内的设置区。 */
  const [focusCapability, setFocusCapability] = useState<{ id: string; token: number; layer?: string }>()
  const [createdHidden, setCreatedHidden] = useState(false)
  // 创建后只定位并展开新卡，不改动用户选定的列表筛选。
  const revealCapability = useCallback((id: string) => {
    setCreatedHidden(viewFilter !== 'all')
    // 能力卡已退场：定位锚改到该层实例卡内的设置区（层从共享契约派生）。
    const layer = engineCapability(id)?.displayLayer
    setFocusCapability((current) => ({ id, layer, token: (current?.token ?? 0) + 1 }))
  }, [viewFilter])
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
  const canEditPreset = store.fields.writePreset && store.moduleFacts?.editable === true
  // 顶部只提供九层注入模板；其它创建由所属层设置承载。
  // 作用域 = 主会话：新建配置清除模板自带的「仅子代理」限制（缺省 = 公用，两侧都可见）。
  const picker = useTemplatePicker(
    fields.promptConfigs,
    (config) => { if (canEditPreset) patchConfigs([...store.getFields().promptConfigs, config]) },
    store.showNotice,
    t,
    'main',
  )
  const toolEditor = useCustomToolsEditor({ t, presetId: fields.presetTemplate, disabled: !canEditPreset, drafts: store.editorDrafts, onNotice: store.showNotice, onChooseTemplate: picker.openTools })
  const createItems = INSERTION_LAYERS.map((layer) => ({ id: `tpl:${layer}`, label: t('main.addTemplate', { layer: translateLabel(t, LAYER_LABEL_KEYS, layer) }) }))
  const onCreateSelect = useCallback((id: string) => {
    if (canEditPreset && id.startsWith('tpl:')) picker.openPicker(id.slice(4))
  }, [canEditPreset, picker])
  const insertToolTemplate = useCallback((spec: Record<string, unknown>) => {
    setCreatedHidden(viewFilter !== 'all' && viewFilter !== 'tool-pipeline')
    toolEditor.createTool({ kind: 'template', spec, presetId: fields.presetTemplate })
    picker.closePicker()
  }, [fields.presetTemplate, picker, viewFilter, toolEditor.createTool])
  // 九层归位、层内设置与资产编辑器统一由 EngineLayersPanel 提供：本页只声明受众视图与
  // 页面编排（创建菜单、模板浮层、指令回调），不再自己手写层名判断或注入单例卡。
  const layers = engineLayerSlots({
    store,
    t,
    viewFilter,
    audience: 'main',
    keyword,
    focusCapability,
    onCreated: revealCapability,
    toolEditor: toolEditor.content,
  })
  return (
    <section className={ui.section} aria-label={t('main.aria')}>
      <PromptConfigsEditor
        t={t}
        meta={store.meta}
        configs={fields.promptConfigs}
        browse={props.browse}
        fieldDrafts={store.editorDrafts?.fields}
        draftScope={fields.presetTemplate}
        readOnlyReason={!canEditPreset ? t(fields.writePreset ? 'configs.readOnly.system' : 'configs.readOnly.disabled') : undefined}
        onChoosePreset={() => props.onNavigate?.('presets')}
        onCreate={() => picker.openPicker(INSERTION_LAYERS.find((layer) => layer === viewFilter) ?? 'pre-step')}
        createdHidden={createdHidden}
        onShowCreated={() => { changeViewFilter('all'); setCreatedHidden(false) }}
        createdConfigId={picker.createdConfigId}
        onPatchConfigs={patchConfigs}
        onSaveConfigs={saveConfigs}
        onSaveInstructions={store.persistInstructionFiles}
        instructionPolicy={store.instructionPolicy}
        onToggleInstructionSource={store.setInstructionSourceEnabled}
        onSaveInstructionFile={saveInstructionFile}
        onReloadInstructionFile={reloadInstructionFile}
        onPatchInstructionPolicy={patchInstructionPolicy}
        onNotice={store.showNotice}
        viewFilter={viewFilter}
        onViewFilterChange={changeViewFilter}
        keyword={keyword}
        onKeywordChange={setKeyword}
        renderLayerSettings={layers.renderLayerSettings}
        hasLayerSettings={layers.hasLayerSettings}
        matchesLayerSettings={layers.matchesLayerSettings}
        beforeCards={layers.beforeCards}
        commonCards={layers.commonCards}
        toolbarActions={<EngineModuleActions store={store} t={t} anchorRef={picker.anchorRef} extraItems={createItems} templatesOnly onExtraSelect={onCreateSelect} />}
        moduleCards={layers.moduleCards}
      />
      {picker.open && (
        <TemplatePicker
          t={t}
          anchorRef={picker.popoverAnchorRef}
          templates={picker.toolsOnly ? [] : picker.templates}
          layer={picker.layer}
          toolTemplates={picker.layer === undefined ? picker.toolTemplates : undefined}
          onPick={picker.pickTemplate}
          onPickTool={insertToolTemplate}
          onClose={picker.closePicker}
        />
      )}
    </section>
  )
})

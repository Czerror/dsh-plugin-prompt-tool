import { memo, useCallback, useState, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { EngineModuleActions } from '../../../features/modules/EngineModuleList.tsx'
import { SubagentToolPolicyCard } from '../../../features/subagents/SubagentToolPolicyCard.tsx'
import { INSERTION_LAYERS, LAYER_LABEL_KEYS, translateLabel } from '../../../features/prompts/prompt-config-policy.ts'
import { useTemplatePicker } from '../../../features/prompts/useTemplatePicker.ts'
import type { ToolCreateIntent } from '../../../features/tools/CustomToolsCard.tsx'
import { TemplatePicker } from '../../../ui/TemplatePicker.tsx'
import { engineLayerSlots } from './EngineLayersPanel.tsx'
import { ConfigListWithTemplates } from './ConfigListWithTemplates.tsx'
import ui from '../../../ui/controls.module.css'
import type { ConfigPageBrowse } from '../workspace-browse-state.ts'
import type { WorkspacePage } from '../workspace-pages.ts'
/** 子代理页：子代理引擎模块区块（列表上方，与主会话同构）+ 子代理配置列表
 *  （audience != main 即公用或仅子代理）。
 *
 *  入口对等（与主会话同款创建能力，只改作用域）：
 *  - 合并创建菜单：引擎能力/recipe、按插入点层级的模板、工具模板、模板变量；
 *  - 能力模块卡与自定义工具卡（与主会话同一份激活预设，视图过滤联动）；
 *  - 子代理独有：子代理模型、工具与深度（子代理工具策略 / allowKinds / maxDepth）。
 *
 *  例外：`tool-filter`（主对话常驻工具过滤）**不在本页创建、也不在本页显示卡片**——
 *  它对子代理不生效（includeSubagents 缺省 false 且无 UI 开关）；子代理工具面由
 *  「工具与深度」卡里的实例级「子代理工具策略」授权。
 *
 *  纪律：过滤抽屉与搜索词只由用户手动改变；新建只做「展开新卡 + 滚动定位」两件事。 */
export const SubagentPage = memo(function SubagentPage(props: { store: PromptToolStore; t: PromptToolTranslate; browse?: ConfigPageBrowse; onNavigate?: (page: WorkspacePage) => void }): ReactNode {
  const { store, t } = props
  const [viewFilter, setViewFilter] = useState(props.browse?.viewFilter ?? 'all')
  const changeViewFilter = (value: string): void => {
    if (props.browse !== undefined) props.browse.viewFilter = value
    setViewFilter(value)
  }
  /** 新建能力后的定位信号：token 递增，保证重复创建同一能力仍会再次展开并跳转。 */
  const [focusCapability, setFocusCapability] = useState<{ id: string; token: number }>()
  const [toolCreate, setToolCreate] = useState<ToolCreateIntent>()
  const [variablesExpanded, setVariablesExpanded] = useState(props.browse?.variablesExpanded ?? false)
  const [createdHidden, setCreatedHidden] = useState(false)
  const canEditPreset = store.fields.writePreset && store.moduleFacts?.editable === true
  /** 仅主对话生效的能力：本页既不提供创建，也不渲染卡片。 */
  const mainSessionOnly = ['tool-filter']
  // 合并创建菜单：按插入点层级平铺「添加模板 · 层级」入口，浮层只列该层模板。
  const picker = useTemplatePicker(
    store.fields.promptConfigs,
    (config) => store.patch({ promptConfigs: [...store.getFields().promptConfigs, config] }),
    store.showNotice,
    t,
    'subagent',
  )
  const pickVariables = useCallback(() => {
    store.setTemplateVariables({ ...store.templateVariables, '': '' })
    if (props.browse !== undefined) props.browse.variablesExpanded = true
    setVariablesExpanded(true)
    picker.closePicker()
  }, [picker, store, props.browse])
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
      setCreatedHidden(viewFilter !== 'all' && viewFilter !== 'tool-pipeline')
      setToolCreate({ kind: 'blank', presetId: store.fields.presetTemplate })
    }
  }, [picker, pickVariables, store, viewFilter])
  const insertToolTemplate = useCallback((spec: Record<string, unknown>) => {
    setCreatedHidden(viewFilter !== 'all' && viewFilter !== 'tool-pipeline')
    setToolCreate({ kind: 'template', spec, presetId: store.fields.presetTemplate })
    picker.closePicker()
  }, [picker, store, viewFilter])
  // 能力创建成功后只定位并展开新卡；不改动用户选定的视图过滤。
  const revealCapability = useCallback((id: string) => {
    setCreatedHidden(viewFilter !== 'all')
    setFocusCapability((current) => ({ id, token: (current?.token ?? 0) + 1 }))
  }, [viewFilter])
  // 与主会话同源的层内装配：本页只声明受众视图与子代理专属编排。
  const layers = engineLayerSlots({
    store,
    t,
    viewFilter,
    audience: 'subagent',
    focusCapability,
    toolCreate,
    onToolIntentConsumed: () => setToolCreate(undefined),
    variablesExpanded,
    onToggleVariables: () => {
      if (props.browse !== undefined) props.browse.variablesExpanded = !variablesExpanded
      setVariablesExpanded(!variablesExpanded)
    },
    excludeCapabilities: mainSessionOnly,
    moduleHint: t('modules.subagentScopeHint'),
    moduleEmptyHint: t('modules.subagentEmptyHint'),
    renderCapabilityExtra: ({ capabilityId }) => capabilityId === 'subagent-tool-policy'
      ? (
        <SubagentToolPolicyCard
          key={store.fields.presetTemplate}
          presetId={store.fields.presetTemplate}
          disabled={!canEditPreset}
          t={t}
          onNotice={store.showNotice}
          drafts={store.editorDrafts}
        />
      )
      : undefined,
  })
  return (
    <>
      <section className={ui.section} aria-label={t('subagent.aria')}>
        <ConfigListWithTemplates
          store={store}
          t={t}
          scope="subagent"
          browse={props.browse}
          onChoosePreset={() => props.onNavigate?.('presets')}
          onCreate={() => picker.openPicker('pre-step')}
          createdHidden={createdHidden}
          onShowCreated={() => { changeViewFilter('all'); setCreatedHidden(false) }}
          createdConfigId={picker.createdConfigId}
          commonCards={layers.commonCards}
          beforeCards={layers.beforeCards}
          toolbarActions={
            <EngineModuleActions
              store={store}
              t={t}
              anchorRef={picker.anchorRef}
              extraItems={createItems}
              onExtraSelect={onCreateSelect}
              onCreated={revealCapability}
              excludeCapabilities={mainSessionOnly}
            />
          }
          moduleCards={layers.moduleCards}
          viewFilter={viewFilter}
          onViewFilterChange={changeViewFilter}
        />
      </section>
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
    </>
  )
})

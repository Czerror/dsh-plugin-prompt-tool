import { memo, useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { DraftsPort, HostApiPort, InstructionFilesPort, ModelsPort, ModuleActionsPort, ModuleFactsPort, NoticePort, ParamsPort, RuleEditingPort, VariablesPort } from '../../../data/store-ports.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { moduleCapability } from '../../../../shared/engine-capabilities.ts'
import { INSERTION_LAYERS, LAYER_LABEL_KEYS, translateLabel } from '../../../features/prompts/prompt-config-policy.ts'
import { RulesWorkspace } from '../../../features/prompts/RulesWorkspace.tsx'
import { injectionPointSlots } from './InjectionPointsPanel.tsx'
import ui from '../../../ui/controls.module.css'
import type { ConfigPageBrowse } from '../workspace-browse-state.ts'
import type { WorkspacePage } from '../workspace-pages.ts'

/**
 * 本页取用的 store 面：本页自己零读取，面＝两张子面需求的并集
 * （`injectionPointSlots` 的 `PanelStore` ＋ `RulesWorkspace` 要的 `RuleEditingPort` 等）。
 * 不写成 `InjectionPointSlotsInput['store']`：后者**不含** `RulesWorkspace` 要的 `enqueueRuleTask`／`createTemplateRule`。
 */
type AudienceStore = ModuleFactsPort & DraftsPort & ParamsPort & VariablesPort & RuleEditingPort
  & InstructionFilesPort & ModuleActionsPort & NoticePort & ModelsPort & HostApiPort

const subscribeEmpty = () => () => {}
const emptyRevision = () => 0

/**
 * 统一画布：按装配集合呈现各启用模块全部受众规则与层内资产。
 *
 * 纪律：过滤抽屉与搜索词只由用户手动改变；新建只做「展开新卡 + 滚动定位」两件事。
 * 九层归位、层内设置与资产编辑器统一由 `InjectionPointsPanel` 提供，本页只声明受众视图与页面编排。
 */
export const AudiencePage = memo(function AudiencePage(props: {
  store: AudienceStore
  t: PromptToolTranslate; browse?: ConfigPageBrowse; onNavigate?: (page: WorkspacePage) => void
  onRuleEdit?: () => void; onReturnToDiagnostics?: () => void
}): ReactNode {
  const { store, t } = props
  useSyncExternalStore(props.browse?.subscribe ?? subscribeEmpty, props.browse?.revision ?? emptyRevision, props.browse?.revision ?? emptyRevision)
  const [localViewFilter, setViewFilter] = useState('all')
  const viewFilter = props.browse?.viewFilter ?? localViewFilter
  const changeViewFilter = useCallback((value: string) => {
    if (props.browse !== undefined) { props.browse.viewFilter = value; props.browse.publish() }
    else setViewFilter(value)
  }, [props.browse])
  // 搜索词由页面持有：同一搜索词同时过滤配置实例、层设置区与本层资产。
  const [localKeyword, setKeyword] = useState('')
  const keyword = props.browse?.filter ?? localKeyword
  /** 新建能力后的定位信号：token 递增（重复创建同一能力仍会再次展开），layer 用于滚动到该层设置区。 */
  const [focusCapability, setFocusCapability] = useState<{ id: string; token: number; layer?: string }>()
  const [createdHidden, setCreatedHidden] = useState(false)
  // 创建后只定位并展开新卡，不改动用户选定的列表筛选。
  const revealCapability = useCallback((id: string) => {
    setCreatedHidden(viewFilter !== 'all')
    // 创建入口位于规则卡设置区，仍按共享层归属定位。
    const layer = moduleCapability(id)?.displayLayer
    setFocusCapability((current) => ({ id, layer, token: (current?.token ?? 0) + 1 }))
  }, [viewFilter])
  const layers = injectionPointSlots({
    store,
    t,
    viewFilter,
    keyword,
    focusCapability,
    onCreated: revealCapability,
  })
  // 页级创建入口的清单（编排与浮层都在 RulesWorkspace 里，主语由那次目标选择给出）。
  const createItems = INSERTION_LAYERS.map((layer) => ({ id: `tpl:${layer}`, label: t('main.addTemplate', { layer: translateLabel(t, LAYER_LABEL_KEYS, layer) }) }))
  return (
    <section className={ui.section} aria-label={t('rules.ruleEditor')}>
      <RulesWorkspace
        store={store}
        t={t}
        browse={props.browse}
        onRuleEdit={props.onRuleEdit}
        onReturnToDiagnostics={props.onReturnToDiagnostics}
        createdHidden={createdHidden}
        onShowCreated={() => { changeViewFilter('all'); setCreatedHidden(false) }}
        viewFilter={viewFilter}
        onViewFilterChange={changeViewFilter}
        keyword={keyword}
        onKeywordChange={setKeyword}
        renderLayerSettings={layers.renderLayerSettings}
        renderInstructionSettings={layers.renderInstructionSettings}
        hasLayerSettings={layers.hasLayerSettings}
        layerCards={layers.layerCards}
        renderModuleSettings={layers.renderModuleSettings}
        beforeCards={layers.beforeCards}
        createItems={createItems}
      />
    </section>
  )
})

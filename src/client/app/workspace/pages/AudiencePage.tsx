import { memo, useCallback, useState, type ReactNode } from 'react'
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

/**
 * 受众差异**只有这四样**，其余编排与子面完全同构；两个受众页因此合成一个参数化页。
 * `exclude`：仅主对话生效的能力不在子代理页创建、也不在子代理页显示卡片
 * （B7 T3 后暂无此类能力，清单保留给后续重构）。
 */
const AUDIENCE_CONFIG = {
  main: { scope: undefined, aria: 'main.aria', exclude: undefined },
  subagent: { scope: 'subagent', aria: 'subagent.aria', exclude: ['main-model'] as readonly string[] },
} as const

/**
 * 受众页：按装配集合呈现各启用模块的规则与层内资产（主语由每张卡的归属模块给出）。
 *
 * 纪律：过滤抽屉与搜索词只由用户手动改变；新建只做「展开新卡 + 滚动定位」两件事。
 * 九层归位、层内设置与资产编辑器统一由 `InjectionPointsPanel` 提供，本页只声明受众视图与页面编排。
 */
export const AudiencePage = memo(function AudiencePage(props: {
  store: AudienceStore
  audience: keyof typeof AUDIENCE_CONFIG
  t: PromptToolTranslate; browse?: ConfigPageBrowse; onNavigate?: (page: WorkspacePage) => void
}): ReactNode {
  const { store, t, audience } = props
  const config = AUDIENCE_CONFIG[audience]
  const [viewFilter, setViewFilter] = useState(props.browse?.viewFilter ?? 'all')
  const changeViewFilter = useCallback((value: string) => {
    if (props.browse !== undefined) props.browse.viewFilter = value
    setViewFilter(value)
  }, [props.browse])
  // 搜索词由页面持有：同一搜索词同时过滤配置实例、层设置区与本层资产。
  const [keyword, setKeyword] = useState(props.browse?.filter ?? '')
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
    audience,
    keyword,
    focusCapability,
    onCreated: revealCapability,
    ...(config.exclude === undefined ? {} : { excludeCapabilities: config.exclude }),
  })
  // 页级创建入口的清单（编排与浮层都在 RulesWorkspace 里，主语由那次目标选择给出）。
  const createItems = INSERTION_LAYERS.map((layer) => ({ id: `tpl:${layer}`, label: t('main.addTemplate', { layer: translateLabel(t, LAYER_LABEL_KEYS, layer) }) }))
  return (
    <section className={ui.section} aria-label={t(config.aria)}>
      <RulesWorkspace
        store={store}
        t={t}
        scope={config.scope}
        browse={props.browse}
        createdHidden={createdHidden}
        onShowCreated={() => { changeViewFilter('all'); setCreatedHidden(false) }}
        viewFilter={viewFilter}
        onViewFilterChange={changeViewFilter}
        keyword={keyword}
        onKeywordChange={setKeyword}
        renderLayerSettings={layers.renderLayerSettings}
        renderInstructionSettings={layers.renderInstructionSettings}
        hasLayerSettings={layers.hasLayerSettings}
        matchesLayerSettings={layers.matchesLayerSettings}
        renderModuleSettings={layers.renderModuleSettings}
        beforeCards={layers.beforeCards}
        createItems={createItems}
      />
    </section>
  )
})

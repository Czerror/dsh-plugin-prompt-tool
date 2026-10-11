import { memo, useCallback, useState, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { RulesWorkspace } from '../../../features/prompts/RulesWorkspace.tsx'
import { moduleCapability } from '../../../../shared/engine-capabilities.ts'
import { injectionPointSlots } from './InjectionPointsPanel.tsx'
import ui from '../../../ui/controls.module.css'
import type { ConfigPageBrowse } from '../workspace-browse-state.ts'
import type { WorkspacePage } from '../workspace-pages.ts'
/** 主会话页：按装配集合呈现各启用模块的规则与层内资产（主语由每张卡的归属模块给出）。 */
export const MainSessionPage = memo(function MainSessionPage(props: { store: PromptToolStore; t: PromptToolTranslate; browse?: ConfigPageBrowse; onNavigate?: (page: WorkspacePage) => void }): ReactNode {
  const { store, t } = props
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
    const layer = moduleCapability(id)?.displayLayer
    setFocusCapability((current) => ({ id, layer, token: (current?.token ?? 0) + 1 }))
  }, [viewFilter])
  // 九层归位、层内设置与资产编辑器统一由 InjectionPointsPanel 提供：本页只声明受众视图与
  // 页面编排（定位信号、搜索词），不再自己手写层名判断或注入单例卡。
  const layers = injectionPointSlots({
    store,
    t,
    viewFilter,
    audience: 'main',
    keyword,
    focusCapability,
    onCreated: revealCapability,
  })
  return (
    <section className={ui.section} aria-label={t('main.aria')}>
      <RulesWorkspace
        store={store}
        t={t}
        browse={props.browse}
        createdHidden={createdHidden}
        onShowCreated={() => { changeViewFilter('all'); setCreatedHidden(false) }}
        viewFilter={viewFilter}
        onViewFilterChange={changeViewFilter}
        keyword={keyword}
        onKeywordChange={setKeyword}
        renderLayerSettings={layers.renderLayerSettings}
        hasLayerSettings={layers.hasLayerSettings}
        matchesLayerSettings={layers.matchesLayerSettings}
        beforeCards={layers.beforeCards}
      />
    </section>
  )
})

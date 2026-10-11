import { memo, useCallback, useState, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { moduleCapability } from '../../../../shared/engine-capabilities.ts'
import { injectionPointSlots } from './InjectionPointsPanel.tsx'
import { RulesWorkspace } from '../../../features/prompts/RulesWorkspace.tsx'
import ui from '../../../ui/controls.module.css'
import type { ConfigPageBrowse } from '../workspace-browse-state.ts'
import type { WorkspacePage } from '../workspace-pages.ts'
/** 子代理页：与主会话同构的装配集合视图（按归属模块呈现），只改受众视图与页面编排。
 *
 *  例外：仅主对话生效的能力**不在本页创建、也不在本页显示卡片**。
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
  const [createdHidden, setCreatedHidden] = useState(false)
  // 搜索词由页面持有：同一搜索词同时过滤配置实例、能力卡、共享设置区与单例卡。
  const [keyword, setKeyword] = useState(props.browse?.filter ?? '')
  /** 仅主对话生效的能力：本页既不提供创建，也不渲染卡片。B7 T3 后暂无此类能力，清单留待重构。 */
  const mainSessionOnly: readonly string[] = ['main-model']
  // 能力创建成功后只定位并展开新卡；不改动用户选定的视图过滤。
  const revealCapability = useCallback((id: string) => {
    setCreatedHidden(viewFilter !== 'all')
    // 能力卡已退场：定位锚改到该层实例卡内的设置区（层从共享契约派生）。
    const layer = moduleCapability(id)?.displayLayer
    setFocusCapability((current) => ({ id, layer, token: (current?.token ?? 0) + 1 }))
  }, [viewFilter])
  // 与主会话同源的层内装配：本页只声明受众视图与子代理专属编排。
  const layers = injectionPointSlots({
    store,
    t,
    viewFilter,
    audience: 'subagent',
    keyword,
    focusCapability,
    onCreated: revealCapability,
    excludeCapabilities: mainSessionOnly,
  })
  return (
    <section className={ui.section} aria-label={t('subagent.aria')}>
      <RulesWorkspace
        store={store}
        t={t}
        scope="subagent"
        browse={props.browse}
        createdHidden={createdHidden}
        onShowCreated={() => { changeViewFilter('all'); setCreatedHidden(false) }}
        beforeCards={layers.beforeCards}
        viewFilter={viewFilter}
        onViewFilterChange={changeViewFilter}
        keyword={keyword}
        onKeywordChange={setKeyword}
        renderLayerSettings={layers.renderLayerSettings}
        hasLayerSettings={layers.hasLayerSettings}
        matchesLayerSettings={layers.matchesLayerSettings}
      />
    </section>
  )
})

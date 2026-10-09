import clsx from 'clsx'
import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { useRuleDiagnostics } from '../../data/use-rule-diagnostics.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { WorkspaceNavigation } from './WorkspaceNavigation.tsx'
import { WORKSPACE_PAGES, type WorkspacePage } from './workspace-pages.ts'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { Button } from '../../ui/Button.tsx'
import ui from '../../ui/controls.module.css'
import css from './PromptWorkspace.module.css'

export function WorkspaceFrame(props: {
  store: PromptToolStore
  page: WorkspacePage
  t: PromptToolTranslate
  onPageChange: (page: WorkspacePage) => void
  scrollKey?: string
  scrollPositions?: Map<string, number>
  focusPage?: number
  contentReady?: boolean
  onClose: () => void
  children: ReactNode
}): ReactNode {
  const { store, t } = props
  useSyncExternalStore(store.subscribeDrafts, store.getDraftRevision, store.getDraftRevision)
  const canvasRef = useRef<HTMLElement>(null)
  const restoredKey = useRef<string>()
  const lastFocusPage = useRef(props.focusPage)
  const scrollKey = props.scrollKey ?? props.page
  // 状态栏报全仓口径：已启用模块里的配置启用/总条数（服务端统计），模块启用/总数（模块列表）。
  // 重载键只由「模块 + 启用位」组成：启停模块（启用表变了）重算计数，切模块或编辑规则不重算。
  const summary = useRuleDiagnostics(store.meta.layers.length > 0, (store.meta.modules ?? []).map(module => `${module.id}:${module.enabled === true ? 1 : 0}`).join(','))
  const modules = store.meta.modules ?? []
  const modulesEnabled = modules.filter(module => module.enabled === true).length
  // 条件因缺事实无法判定的规则数；>0 才在状态栏出现，空态不占位。
  const unavailableCount = summary.unavailableCount
  // 角色库与工具面拥有独立请求，不能以全局配置数量判定它们的加载/空态。
  const usesBootstrap = props.page !== 'modules' && props.page !== 'tools'
  const loadingInitial = usesBootstrap && store.loading && store.meta.layers.length === 0
  const loadFailed = usesBootstrap && !store.loading && store.meta.layers.length === 0 && store.noticeKind === 'error'
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (restoredKey.current !== scrollKey) restoredKey.current = undefined
    if (canvas === null || loadingInitial || props.contentReady === false) return
    const focusPanel = props.focusPage !== lastFocusPage.current
    if (restoredKey.current === scrollKey && !focusPanel) return
    restoredKey.current = undefined
    const frame = requestAnimationFrame(() => {
      canvas.scrollTop = focusPanel ? 0 : (props.scrollPositions?.get(scrollKey) ?? 0)
      if (focusPanel) canvas.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')?.focus({ preventScroll: true })
      lastFocusPage.current = props.focusPage
      restoredKey.current = scrollKey
    })
    return () => cancelAnimationFrame(frame)
  }, [scrollKey, loadingInitial, props.contentReady, props.scrollPositions, props.focusPage])
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const toolbar = canvas?.querySelector<HTMLElement>('[data-workspace-sticky]')
    if (canvas == null) return
    if (toolbar == null) { canvas.style.setProperty('--pt-sticky-height', '0px'); return }
    const measure = (): void => {
      const height = toolbar.getBoundingClientRect().height
      // 保留至少同样高的正文编辑空间；软键盘/窄视口使操作区过高时回归文档流。
      const disabled = height * 2 >= canvas.clientHeight
      canvas.dataset.stickyDisabled = String(disabled)
      canvas.style.setProperty('--pt-sticky-height', `${disabled ? 0 : height}px`)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(toolbar)
    observer.observe(canvas)
    measure()
    return () => observer.disconnect()
  }, [scrollKey, loadingInitial])
  return (
    <div className={css.shell}>
      <header className={css.masthead}>
        <div className={css.brand}>
          <span className={css.brandLogo} aria-hidden="true">⌁</span>
          <h1>{t('app.title')}</h1>
        </div>
        {/* 状态反馈住在标题行：内容区不再为它留行；长文本单行截断，title 给全文。
            加载失败时这里与内容区的重试块并存——同一条消息，标题行先让人看见错误。 */}
        {store.notice !== '' && (
          <p className={clsx(css.mastheadNotice, store.noticeKind === 'error' && css.mastheadNoticeError)} role="status" data-workspace-notice="true" title={store.notice}>
            {store.noticePill === undefined
              ? store.notice
              : <><StatusBadge tone="success" label={store.noticePill} /> {store.notice}</>}
          </p>
        )}
        <div className={css.statusCluster}>
          <StatusDot tone={store.loading ? 'neutral' : 'success'} />
          {/* 只有首次读取才用文字顶替计数：重载（切模块、启停模块）期间计数照旧显示，加载由圆点变灰表达。
              两个计数都是全仓口径：规则 = 已启用模块里的配置卡（X 启用 / Y 总数），模块 = 启用 / 全部。 */}
          <span>{loadingInitial
            ? t('app.loading')
            : summary.configs.total > 0
              ? `${t('app.statusRules', summary.configs)} · ${t('app.statusModules', { enabled: modulesEnabled, total: modules.length })}`
              : t('app.statusModules', { enabled: modulesEnabled, total: modules.length })}
            {unavailableCount > 0 ? ` · ${t('app.statusUnavailable', { count: unavailableCount })}` : ''}</span>
        </div>
        <Button shape="pill" variant="outline" className={css.backButton} onClick={props.onClose}>{t('app.backToChat')}</Button>
      </header>

      <WorkspaceNavigation page={props.page} onChange={(page) => {
        if (canvasRef.current !== null && restoredKey.current === scrollKey) props.scrollPositions?.set(scrollKey, canvasRef.current.scrollTop)
        props.onPageChange(page)
      }} t={t} />

      <main ref={canvasRef} className={css.canvas} data-workspace-canvas onScroll={(event) => {
        if (restoredKey.current === scrollKey) props.scrollPositions?.set(scrollKey, event.currentTarget.scrollTop)
      }}>
        {WORKSPACE_PAGES.map((item) => {
          const active = item.id === props.page
          return (
            <div
              key={item.id}
              id={`pt-workspace-panel-${item.id}`}
              role="tabpanel"
              aria-labelledby={`pt-workspace-tab-${item.id}`}
              tabIndex={active ? 0 : undefined}
              hidden={!active}
            >
              {active && (
                <>
                  {loadFailed ? <div className={ui.actionFeedback}>
                    <p className={ui.noticeError} role="status">{store.notice}</p>
                    <Button shape="pill" variant="outline" size="md" onClick={() => void store.load()}>{t('workspace.retry')}</Button>
                  </div> : loadingInitial ? (
                    <div aria-busy="true" aria-label={t('app.loading')}>
                      <div className={props.page === 'modules' ? ui.presetGrid : ui.skeletonStack} aria-hidden="true">
                        {[0, 1, 2, 3].map((row) => <div key={row} className={ui.skeletonRow} />)}
                      </div>
                    </div>
                  ) : props.children}
                </>
              )}
            </div>
          )
        })}
      </main>
    </div>
  )
}

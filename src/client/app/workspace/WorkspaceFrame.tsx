import clsx from 'clsx'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { WorkspaceNavigation } from './WorkspaceNavigation.tsx'
import { WORKSPACE_PAGES, type WorkspacePage } from './workspace-pages.ts'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import { StatusDot } from '../../ui/StatusDot.tsx'
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
  const canvasRef = useRef<HTMLElement>(null)
  const restoredKey = useRef<string>()
  const lastFocusPage = useRef(props.focusPage)
  const scrollKey = props.scrollKey ?? props.page
  const enabledCount = store.fields.promptConfigs.filter((config) => config.enabled !== false).length
  // 角色库与工具面拥有独立请求，不能以全局配置数量判定它们的加载/空态。
  const usesBootstrap = props.page !== 'characters' && props.page !== 'tools'
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
        <div className={css.statusCluster}>
          <StatusDot tone={store.loading ? 'neutral' : 'success'} />
          <span>{store.loading
            ? t('app.loading')
            : t('app.statusSummary', { configs: store.fields.promptConfigs.length, enabled: enabledCount })}</span>
        </div>
        <button type="button" className={css.backButton} onClick={props.onClose}>{t('app.backToChat')}</button>
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
                    <button type="button" className={ui.pillButton} onClick={() => void store.load()}>{t('workspace.retry')}</button>
                  </div> : loadingInitial ? (
                    <div aria-busy="true" aria-label={t('app.loading')}>
                      <div className={props.page === 'presets' ? ui.presetGrid : ui.skeletonStack} aria-hidden="true">
                        {[0, 1, 2, 3].map((row) => <div key={row} className={ui.skeletonRow} />)}
                      </div>
                    </div>
                  ) : props.children}
                  {store.notice && !loadFailed && props.page !== 'features' && props.page !== 'subagent' && (
                    <p className={clsx(ui.notice, store.noticeKind === 'error' && ui.noticeError)} role="status">
                      {/* 会话名前导胶囊（绿色）：与消息同一条 live region，只播报一次。 */}
                      {store.noticePill === undefined
                        ? store.notice
                        : <><StatusBadge tone="success" label={store.noticePill} /> {store.notice}</>}
                    </p>
                  )}
                </>
              )}
            </div>
          )
        })}
      </main>
    </div>
  )
}

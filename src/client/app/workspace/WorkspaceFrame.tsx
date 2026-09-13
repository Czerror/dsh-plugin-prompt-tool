import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { WorkspaceNavigation } from './WorkspaceNavigation.tsx'
import { WORKSPACE_PAGES, workspacePageMeta, type WorkspacePage } from './workspace-pages.ts'
import { StatusDot } from '../../ui/StatusDot.tsx'
import ui from '../../ui/controls.module.css'
import css from './PromptWorkspace.module.css'

function PageHeader(props: { title: string; description: string; meta: string }): ReactNode {
  return (
    <div className={ui.pageHeader}>
      <div><h2>{props.title}</h2><p>{props.description}</p></div>
      <div className={css.pageHeaderMeta}><code>{props.meta}</code></div>
    </div>
  )
}

export function WorkspaceFrame(props: {
  store: PromptToolStore
  page: WorkspacePage
  pageMeta: string
  t: PromptToolTranslate
  onPageChange: (page: WorkspacePage) => void
  onClose: () => void
  children: ReactNode
}): ReactNode {
  const { store, t } = props
  const descriptor = workspacePageMeta(props.page)
  const enabledCount = store.fields.promptConfigs.filter((config) => config.enabled !== false).length
  const hasData = store.meta.layers.length > 0
    || store.fields.skillCatalog.length > 0
    || store.fields.promptConfigs.length > 0
  return (
    <div className={css.shell}>
      <header className={css.masthead}>
        <div className={css.brand}>
          <span className={css.brandLogo} aria-hidden="true">⌁</span>
          <h1>{t('app.title')}</h1>
        </div>
        <div className={css.statusCluster}>
          <StatusDot tone={store.loading ? 'neutral' : 'success'} pulse={!store.loading} />
          <span>{store.loading
            ? t('app.loading')
            : t('app.statusSummary', { configs: store.fields.promptConfigs.length, enabled: enabledCount })}</span>
        </div>
        <button type="button" className={css.backButton} onClick={props.onClose}>{t('app.backToChat')}</button>
      </header>

      <WorkspaceNavigation page={props.page} onChange={props.onPageChange} t={t} />

      <main className={css.canvas}>
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
                  <PageHeader title={t(descriptor.titleKey)} description={t(descriptor.detailKey)} meta={props.pageMeta} />
                  {store.loading && !hasData ? (
                    <div className={ui.skeletonStack} aria-hidden="true">
                      {[0, 1, 2, 3].map((row) => <div key={row} className={ui.skeletonRow} />)}
                    </div>
                  ) : props.children}
                  {store.notice && <p className={clsx(ui.notice, store.noticeKind === 'error' && ui.noticeError)} role="status">{store.notice}</p>}
                </>
              )}
            </div>
          )
        })}
      </main>
    </div>
  )
}

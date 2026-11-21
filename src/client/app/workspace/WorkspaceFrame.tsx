import type { ReactNode } from 'react'
import type { ModuleFactsPort, NoticePort } from '../../data/store-ports.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { Button } from '../../ui/Button.tsx'
import css from './PromptWorkspace.module.css'

export function WorkspaceFrame(props: {
  store: ModuleFactsPort & NoticePort
  t: PromptToolTranslate
  children: ReactNode
}): ReactNode {
  const { store, t } = props
  const loadingInitial = store.loading && store.meta.layers.length === 0
  const loadFailed = !store.loading && store.meta.layers.length === 0 && store.noticeKind === 'error'
  return <div className={css.shell} data-d-surface>
    {store.notice !== '' && <p className={css.surfaceNotice} role="status" title={store.notice}>{store.notice}</p>}
    <main className={css.canvas} data-workspace-canvas>
      <div className={css.surfaceContent} tabIndex={-1} data-workspace-page="features">
        {loadFailed ? <div className={css.surfaceFeedback}><p role="status">{store.notice}</p><Button shape="pill" variant="outline" onClick={() => void store.load()}>{t('workspace.retry')}</Button></div>
          : loadingInitial ? <div className={css.surfaceFeedback} role="status" aria-busy="true">{t('app.loading')}</div> : props.children}
      </div>
    </main>
  </div>
}

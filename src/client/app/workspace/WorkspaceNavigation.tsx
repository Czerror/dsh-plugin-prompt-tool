import { useEffect, useRef, type ReactNode } from 'react'
import { tabKeyHandler } from '../../ui/tab-key.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { WORKSPACE_PAGE_IDS, WORKSPACE_PAGES, type WorkspacePage } from './workspace-pages.ts'
import css from './PromptWorkspace.module.css'

export function WorkspaceNavigation(props: { page: WorkspacePage; onChange: (page: WorkspacePage) => void; t: PromptToolTranslate }): ReactNode {
  const navRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    navRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [props.page])
  return (
    <div className={css.topNavigation}>
      <div ref={navRef} className={css.nav} role="tablist" aria-label={props.t('nav.aria')}>
        {WORKSPACE_PAGES.map((item) => {
          const active = props.page === item.id
          return (
            <button
              key={item.id}
              id={`pt-workspace-tab-${item.id}`}
              type="button"
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              aria-controls={`pt-workspace-panel-${item.id}`}
              data-active={active ? '' : undefined}
              onClick={() => props.onChange(item.id)}
              onKeyDown={tabKeyHandler(WORKSPACE_PAGE_IDS, props.page, props.onChange)}
            >
              <span><strong>{props.t(item.labelKey)}</strong></span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

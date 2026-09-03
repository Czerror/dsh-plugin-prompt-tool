import type { ReactNode } from 'react'
import { tabKeyHandler } from '../../tab-key.ts'
import { WORKSPACE_PAGE_IDS, WORKSPACE_PAGES, type WorkspacePage } from './workspace-pages.ts'
import css from './PromptWorkspace.module.css'

export function WorkspaceNavigation(props: { page: WorkspacePage; onChange: (page: WorkspacePage) => void }): ReactNode {
  return (
    <div className={css.topNavigation}>
      <div className={css.nav} role="tablist" aria-label="提示词工具页面">
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
              <span><strong>{item.label}</strong></span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

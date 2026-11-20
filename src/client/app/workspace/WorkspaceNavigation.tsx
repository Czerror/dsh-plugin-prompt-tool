import type { ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import type { WorkspacePage } from './workspace-pages.ts'
import { Button } from '../../ui/Button.tsx'
import css from './PromptWorkspace.module.css'

export function WorkspaceNavigation(props: { id?: string; page: WorkspacePage; onChange: (page: WorkspacePage) => void; t: PromptToolTranslate }): ReactNode {
  return (
    <nav className={css.surfaceNavigation} aria-label={props.t('nav.aria')}>
      <Button className={css.moduleCenterEntry} variant="outline" onClick={() => props.onChange('modules')}>{props.t('rules.moduleCenter')}</Button>
    </nav>
  )
}

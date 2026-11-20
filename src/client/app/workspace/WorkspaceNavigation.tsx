import type { ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import type { WorkspacePage } from './workspace-pages.ts'
import { Button } from '../../ui/Button.tsx'
import { IconFolderOpenOutlineRegular } from '../../ui/icons.tsx'
import css from './PromptWorkspace.module.css'

export function WorkspaceNavigation(props: { id?: string; page: WorkspacePage; onChange: (page: WorkspacePage) => void; t: PromptToolTranslate }): ReactNode {
  return (
    <nav className={css.surfaceNavigation} aria-label={props.t('nav.aria')}>
      <Button className={css.moduleCenterEntry} variant="outline" aria-label={props.t('rules.moduleCenter')} onClick={() => props.onChange('modules')}>
        <IconFolderOpenOutlineRegular />
        <span>{props.t('rules.moduleCenter')}</span>
      </Button>
    </nav>
  )
}

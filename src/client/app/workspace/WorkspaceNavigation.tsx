import type { ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import { WORKSPACE_PAGES, type WorkspacePage } from './workspace-pages.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { Button } from '../../ui/Button.tsx'
import css from './PromptWorkspace.module.css'

export function WorkspaceNavigation(props: { id?: string; page: WorkspacePage; audience: 'features' | 'subagent'; onChange: (page: WorkspacePage) => void; t: PromptToolTranslate }): ReactNode {
  return (
    <nav className={css.surfaceNavigation} aria-label={props.t('nav.aria')}>
      <Button className={css.moduleCenterEntry} variant="outline" onClick={() => props.onChange('modules')}>{props.t('rules.moduleCenter')}</Button>
      <MenuSelect compact ariaLabel={props.t('nav.aria')} value={props.audience}
        options={WORKSPACE_PAGES.filter(item => item.id === 'features' || item.id === 'subagent').map(item => ({ value: item.id, label: props.t(item.labelKey) }))}
        onChange={page => props.onChange(page as WorkspacePage)} />
    </nav>
  )
}

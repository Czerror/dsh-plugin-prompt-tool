import { useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import type { RuleDiagnosticsSession } from '../../../data/rule-diagnostics-session.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { ModulesPage } from '../../../features/modules/ModulesPage.tsx'
import { ContextActivationDiagnosticsCard } from '../../../features/prompts/ContextActivationDiagnosticsCard.tsx'
import { DiagnosticsPanel } from '../../../features/modules/DiagnosticsPanel.tsx'
import { Button } from '../../../ui/Button.tsx'
import css from './diagnostics.module.css'

export function ModulesWorkspacePage(props: {
  store: PromptToolStore
  diagnostics: RuleDiagnosticsSession
  t: PromptToolTranslate
  onReady: () => void
}): ReactNode {
  const snapshot = useSyncExternalStore(props.diagnostics.subscribe, props.diagnostics.getSnapshot, props.diagnostics.getSnapshot)
  const sessionId = props.store.api.currentSessionId()
  return <>
    <section className={css.card} aria-label={props.t('diagnostics.title')} aria-busy={snapshot.busy}>
      <header className={css.header}>
        <div><h2>{props.t('diagnostics.title')}</h2><p>{props.t('diagnostics.hint')}</p></div>
        <Button shape="pill" variant="outline" disabled={snapshot.busy} onClick={() => { void props.diagnostics.run(sessionId) }}>
          {props.t(snapshot.busy ? 'diagnostics.running' : 'diagnostics.run')}
        </Button>
      </header>
      <div className={css.groups}>
        <DiagnosticsPanel diagnostics={props.diagnostics} t={props.t} />
        <ContextActivationDiagnosticsCard snapshot={snapshot.context?.sessionId === sessionId ? snapshot.context : undefined} sessionId={sessionId} t={props.t} />
      </div>
    </section>
    <ModulesPage {...props} />
  </>
}

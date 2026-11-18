import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import type { RuleDiagnosticsSession } from '../../../data/rule-diagnostics-session.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { ModulesPage } from '../../../features/modules/ModulesPage.tsx'
import { ContextActivationDiagnosticsCard } from '../../../features/prompts/ContextActivationDiagnosticsCard.tsx'
import { DiagnosticsPanel } from '../../../features/modules/DiagnosticsPanel.tsx'
import { Button } from '../../../ui/Button.tsx'
import css from './diagnostics.module.css'

function DiagnosticResults({ children, t }: { children: ReactNode; t: PromptToolTranslate }): ReactNode {
  const [open, setOpen] = useState(false)
  return <details className={css.results} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t(open ? 'diagnostics.hideResults' : 'diagnostics.results')}</summary>
    {open && <div className={css.groups}>{children}</div>}
  </details>
}

export function ModulesWorkspacePage(props: {
  store: PromptToolStore
  diagnostics: RuleDiagnosticsSession
  t: PromptToolTranslate
  onReady: () => void
}): ReactNode {
  const snapshot = useSyncExternalStore(props.diagnostics.subscribe, props.diagnostics.getSnapshot, props.diagnostics.getSnapshot)
  const sessionId = props.store.api.currentSessionId()
  const context = snapshot.context?.sessionId === sessionId ? snapshot.context : undefined
  const showRules = snapshot.diagnosedAt !== undefined || snapshot.status === 'error'
  const showContext = context !== undefined
  const status = snapshot.status === 'stale' ? props.t('diagnostics.stale')
    : snapshot.busy ? props.t('diagnostics.running')
      : snapshot.status === 'error' ? props.t(context?.error !== undefined ? 'diagnostics.failed' : 'diagnostics.rulesFailed')
        : context?.error !== undefined ? props.t('diagnostics.contextFailed')
          : sessionId !== undefined && showRules && !showContext ? props.t('diagnostics.contextPending')
            : snapshot.status === 'ready' ? props.t('diagnostics.completed') : ''
  return <>
    <section className={css.card} aria-label={props.t('diagnostics.title')}>
      <header className={css.header}>
        <div className={css.intro}><h2>{props.t('diagnostics.title')}</h2><p>{props.t(sessionId === undefined ? 'diagnostics.noSession' : 'diagnostics.hint')}</p></div>
        <Button className={css.run} shape="pill" variant="primary" aria-busy={snapshot.busy} disabled={snapshot.busy} onClick={() => { void props.diagnostics.run(sessionId) }}>
          {props.t(snapshot.busy ? 'diagnostics.running' : 'diagnostics.run')}
        </Button>
      </header>
      <p className={css.notice} role="status" aria-atomic="true">{status}</p>
      {(showRules || showContext) && <DiagnosticResults key={sessionId ?? ''} t={props.t}>
        {showRules && <DiagnosticsPanel diagnostics={props.diagnostics} t={props.t} />}
        {showContext && <ContextActivationDiagnosticsCard snapshot={context} sessionId={sessionId} t={props.t} />}
      </DiagnosticResults>}
    </section>
    <ModulesPage {...props} />
  </>
}

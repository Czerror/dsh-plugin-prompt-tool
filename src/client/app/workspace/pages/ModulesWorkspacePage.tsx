import { useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolStore } from '../../../data/use-prompt-tool-store.ts'
import type { RuleDiagnosticsSession, RuleDiagnosticTarget } from '../../../data/rule-diagnostics-session.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { ModulesPage } from '../../../features/modules/ModulesPage.tsx'
import { ContextActivationDiagnosticsCard } from '../../../features/prompts/ContextActivationDiagnosticsCard.tsx'
import { DiagnosticsPanel } from '../../../features/modules/DiagnosticsPanel.tsx'
import { Button } from '../../../ui/Button.tsx'
import type { createWorkspaceBrowseState } from '../workspace-browse-state.ts'
import css from './diagnostics.module.css'

type ResultsDisclosure = ReturnType<typeof createWorkspaceBrowseState>['diagnosticsResults']

function DiagnosticResults({ children, t, disclosure }: { children: ReactNode; t: PromptToolTranslate; disclosure: ResultsDisclosure }): ReactNode {
  const open = useSyncExternalStore(disclosure.subscribe, disclosure.getSnapshot, disclosure.getSnapshot)
  return <details className={css.results} open={open}>
    <summary onClick={event => { event.preventDefault(); disclosure.toggle() }}>{t(open ? 'diagnostics.hideResults' : 'diagnostics.results')}</summary>
    {open && <div className={css.groups}>{children}</div>}
  </details>
}

export function ModulesWorkspacePage(props: {
  store: PromptToolStore
  diagnostics: RuleDiagnosticsSession
  resultsDisclosure: ResultsDisclosure
  onOpenModule: (moduleId: string, ruleKey?: string) => void
  t: PromptToolTranslate
  onReady: () => void
  onLocate?: (target: RuleDiagnosticTarget) => void
  returnTarget?: RuleDiagnosticTarget
  onReturnFocus?: () => void
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
            : snapshot.status === 'ready' ? props.t('diagnostics.completed') : props.t('diagnostics.never')
  return <>
    <ModulesPage {...props} />
    <details><summary>{props.t('diagnostics.title')}</summary><section className={css.card} aria-label={props.t('diagnostics.title')}>
      <header className={css.header}>
        <div className={css.intro}><h2>{props.t('diagnostics.title')}</h2><p>{props.t(sessionId === undefined ? 'diagnostics.noSession' : 'diagnostics.hint')}{sessionId === undefined ? '' : ` · ${sessionId}`}</p></div>
        <Button className={css.run} shape="pill" variant="primary" aria-busy={snapshot.busy} disabled={snapshot.busy} onClick={() => { void props.diagnostics.run(sessionId) }}>
          {props.t(snapshot.busy ? 'diagnostics.running' : 'diagnostics.run')}
        </Button>
      </header>
      <p className={css.notice} role="status" aria-atomic="true">{status}</p>
      {(showRules || showContext) && <DiagnosticResults t={props.t} disclosure={props.resultsDisclosure}>
        {showRules && <DiagnosticsPanel diagnostics={props.diagnostics} t={props.t} onLocate={props.onLocate} returnTarget={props.returnTarget} onReturnFocus={props.onReturnFocus} />}
        {showContext && <ContextActivationDiagnosticsCard snapshot={context} sessionId={sessionId} t={props.t} />}
      </DiagnosticResults>}
    </section></details>
  </>
}

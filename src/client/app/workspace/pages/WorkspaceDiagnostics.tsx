import { useSyncExternalStore, type ReactNode } from 'react'
import type { RuleDiagnosticsSession, RuleDiagnosticTarget } from '../../../data/rule-diagnostics-session.ts'
import type { PromptToolTranslate } from '../../../locales.ts'
import { ContextActivationDiagnosticsCard } from '../../../features/prompts/ContextActivationDiagnosticsCard.tsx'
import { DiagnosticsPanel } from '../../../features/modules/DiagnosticsPanel.tsx'
import { Button } from '../../../ui/Button.tsx'
import css from './diagnostics.module.css'

export function WorkspaceDiagnostics(props: {
  sessionId?: string
  diagnostics: RuleDiagnosticsSession
  t: PromptToolTranslate
  onLocate?: (target: RuleDiagnosticTarget) => void
  returnTarget?: RuleDiagnosticTarget
  onReturnFocus?: () => void
}): ReactNode {
  const snapshot = useSyncExternalStore(props.diagnostics.subscribe, props.diagnostics.getSnapshot, props.diagnostics.getSnapshot)
  const { sessionId } = props
  const context = snapshot.context?.sessionId === sessionId ? snapshot.context : undefined
  const showRules = snapshot.diagnosedAt !== undefined || snapshot.status === 'error'
  const showContext = context !== undefined
  const status = snapshot.status === 'stale' ? props.t('diagnostics.stale')
    : snapshot.busy ? props.t('diagnostics.running')
      : snapshot.status === 'error' ? props.t(context?.error !== undefined ? 'diagnostics.failed' : 'diagnostics.rulesFailed')
        : context?.error !== undefined ? props.t('diagnostics.contextFailed')
          : sessionId !== undefined && showRules && !showContext ? props.t('diagnostics.contextPending')
            : snapshot.status === 'ready' ? props.t('diagnostics.completed') : props.t('diagnostics.never')
  return <section className={css.card} aria-label={props.t('diagnostics.title')}>
      <header className={css.header}>
        <p>{props.t(sessionId === undefined ? 'diagnostics.noSession' : 'diagnostics.hint')}{sessionId === undefined ? '' : ` · ${sessionId}`}</p>
        <Button className={css.run} shape="pill" variant="primary" aria-busy={snapshot.busy} disabled={snapshot.busy} onClick={() => { void props.diagnostics.run(sessionId) }}>
          {props.t(snapshot.busy ? 'diagnostics.running' : 'diagnostics.run')}
        </Button>
      </header>
      <p className={css.notice} role="status" aria-atomic="true">{status}</p>
      {(showRules || showContext) && <div className={css.groups}>
        {showRules && <DiagnosticsPanel diagnostics={props.diagnostics} t={props.t} onLocate={props.onLocate} returnTarget={props.returnTarget} onReturnFocus={props.onReturnFocus} />}
        {showContext && <ContextActivationDiagnosticsCard snapshot={context} sessionId={sessionId} t={props.t} />}
      </div>}
    </section>
}

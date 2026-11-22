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
  const { sessionId, t } = props
  const context = snapshot.context?.sessionId === sessionId ? snapshot.context : undefined
  const status = snapshot.status === 'stale' ? t('diagnostics.stale')
    : snapshot.busy ? t('diagnostics.running')
      : snapshot.status === 'error' ? t(context?.error !== undefined ? 'diagnostics.failed' : 'diagnostics.rulesFailed')
        : context?.error !== undefined ? t('diagnostics.contextFailed')
          : sessionId !== undefined && snapshot.diagnosedAt !== undefined && !context ? t('diagnostics.contextPending')
            : snapshot.diagnosedAt !== undefined ? t('diagnostics.ready', { time: new Date(snapshot.diagnosedAt).toLocaleTimeString() }) : t('diagnostics.never')
  return <section className={css.card} aria-label={t('diagnostics.title')}>
      <header className={css.header}>
        <h2>{t('rules.sidebarDiagnostics')}</h2>
        <Button className={css.run} variant="outline" aria-label={t(snapshot.busy ? 'diagnostics.running' : 'diagnostics.run')}
          aria-busy={snapshot.busy} disabled={snapshot.busy} onClick={() => { void props.diagnostics.run(sessionId) }}>
          {t(snapshot.busy ? 'diagnostics.running' : 'diagnostics.run')}
        </Button>
      </header>
      <p className={css.notice} role="status" aria-atomic="true">{status}</p>
      <div className={css.groups}>
        <DiagnosticsPanel snapshot={snapshot} t={t} onLocate={props.onLocate} returnTarget={props.returnTarget} onReturnFocus={props.onReturnFocus} />
        <ContextActivationDiagnosticsCard key={sessionId} snapshot={context} sessionId={sessionId} t={t} />
      </div>
    </section>
}

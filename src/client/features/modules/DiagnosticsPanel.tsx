import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import type { RuleDiagnosticsSession, RuleDiagnosticTarget } from '../../data/rule-diagnostics-session.ts'
import { Button } from '../../ui/Button.tsx'
import ui from '../../ui/controls.module.css'

export function DiagnosticsPanel(props: {
  diagnostics: RuleDiagnosticsSession
  t: PromptToolTranslate
  onLocate?: (target: RuleDiagnosticTarget) => void
  returnTarget?: RuleDiagnosticTarget
  onReturnFocus?: () => void
}): ReactNode {
  const { t } = props
  const snapshot = useSyncExternalStore(props.diagnostics.subscribe, props.diagnostics.getSnapshot, props.diagnostics.getSnapshot)
  const returnButton = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const records = useRef<HTMLDetailsElement>(null)
  const returnIndex = props.returnTarget === undefined ? -1 : snapshot.records.findIndex(item =>
    item.moduleId === props.returnTarget?.moduleId && item.ruleId === props.returnTarget?.ruleId && item.actionId === props.returnTarget?.actionId)
  useLayoutEffect(() => {
    if (props.returnTarget) {
      if (records.current) records.current.open = true
      const frame = requestAnimationFrame(() => {
        const target = returnButton.current ?? heading.current
        target?.focus()
        props.onReturnFocus?.()
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [props.returnTarget, props.onReturnFocus])
  const time = snapshot.diagnosedAt === undefined ? '' : new Date(snapshot.diagnosedAt).toLocaleString()
  const status = snapshot.busy
    ? t('diagnostics.running')
    : snapshot.status === 'idle'
      ? t('diagnostics.never')
      : snapshot.status === 'stale'
        ? t('diagnostics.stale')
        : snapshot.status === 'error'
          ? t('diagnostics.error', { error: snapshot.error ?? '' })
          : ''
  return <section aria-label={t('diagnostics.rules')}>
    <h3 ref={heading} tabIndex={-1}>{t('diagnostics.rules')}</h3>
    {status !== '' && <p className={ui.configFieldHint} role="status">{status}</p>}
    {snapshot.diagnosedAt !== undefined && <>
      <p className={ui.configFieldHint}>{t('diagnostics.ready', { time })}</p>
      <p className={ui.configFieldHint}>{snapshot.configs === undefined ? t('diagnostics.configsUnavailable') : t('diagnostics.configs', snapshot.configs)}</p>
      <p className={ui.configFieldHint}>{t('diagnostics.unavailable', { count: snapshot.unavailableCount })}</p>
      {snapshot.dropped > 0 && <p className={ui.configFieldHint}>{t('diagnostics.dropped', { count: snapshot.dropped })}</p>}
      {snapshot.records.length === 0 && <p className={ui.configFieldHint}>{t('diagnostics.noRuleRecords')}</p>}
      {snapshot.records.length > 0 && <details ref={records}><summary>{t('diagnostics.details', { count: snapshot.records.length })}</summary><ul>{snapshot.records.map((record, index) => <li key={index}>
        <strong>{[record.moduleId, record.ruleId, record.actionId, record.channel].filter(Boolean).join(' / ')}</strong>
        {record.moduleId !== undefined && props.onLocate && <Button shape="pill" variant="outline"
          ref={returnIndex === index ? returnButton : undefined}
          onClick={() => props.onLocate?.({ moduleId: record.moduleId!, ruleId: record.ruleId, actionId: record.actionId })}>
          {t('diagnostics.openRule', { target: [record.moduleId, record.ruleId, record.actionId].filter(Boolean).join(' / ') })}
        </Button>}
        <p className={ui.configFieldHint}>{t('diagnostics.record', { hit: record.hit, miss: record.miss, unavailable: record.unavailable, error: record.error })}</p>
        {record.reason !== undefined && <p className={ui.configFieldHint}>{record.reason}</p>}
      </li>)}</ul></details>}
    </>}
  </section>
}

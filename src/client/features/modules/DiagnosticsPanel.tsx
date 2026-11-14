import { useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import type { RuleDiagnosticsSession } from '../../data/rule-diagnostics-session.ts'
import { Button } from '../../ui/Button.tsx'
import ui from '../../ui/controls.module.css'

export function DiagnosticsPanel(props: { diagnostics: RuleDiagnosticsSession; t: PromptToolTranslate }): ReactNode {
  const { t } = props
  const snapshot = useSyncExternalStore(props.diagnostics.subscribe, props.diagnostics.getSnapshot, props.diagnostics.getSnapshot)
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
  return <section aria-label={t('diagnostics.run')}>
    <Button variant="outline" disabled={snapshot.busy} onClick={() => { void props.diagnostics.run() }}>
      {snapshot.busy ? t('diagnostics.running') : t('diagnostics.run')}
    </Button>
    <p className={ui.configFieldHint} role="status">{status}</p>
    {snapshot.diagnosedAt !== undefined && <>
      <p className={ui.configFieldHint}>{t('diagnostics.ready', { time })}</p>
      <p className={ui.configFieldHint}>{snapshot.configs === undefined ? t('diagnostics.configsUnavailable') : t('diagnostics.configs', snapshot.configs)}</p>
      <p className={ui.configFieldHint}>{t('diagnostics.unavailable', { count: snapshot.unavailableCount })}</p>
      {snapshot.dropped > 0 && <p className={ui.configFieldHint}>{t('diagnostics.dropped', { count: snapshot.dropped })}</p>}
      <ul>{snapshot.records.map((record, index) => <li key={index}>
        <strong>{[record.moduleId, record.ruleId, record.channel].filter(Boolean).join(' / ')}</strong>
        <p className={ui.configFieldHint}>{t('diagnostics.record', { hit: record.hit, miss: record.miss, unavailable: record.unavailable, error: record.error })}</p>
        {record.reason !== undefined && <p className={ui.configFieldHint}>{record.reason}</p>}
      </li>)}</ul>
    </>}
  </section>
}

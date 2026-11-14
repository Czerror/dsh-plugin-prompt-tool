/** 上下文诊断只呈现统一手动快照，不拥有请求或计时器。 */
import type { ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import type { RuleDiagnosticsSnapshot } from '../../data/rule-diagnostics-session.ts'
import ui from '../../ui/controls.module.css'

export function ContextActivationDiagnosticsCard(props: {
  snapshot: RuleDiagnosticsSnapshot['context']
  sessionId?: string
  t: PromptToolTranslate
}): ReactNode {
  const { snapshot, t } = props
  return <section aria-label={t('diagnostics.context')}>
    <h3>{t('diagnostics.context')}</h3>
    {props.sessionId === undefined ? <p className={ui.configFieldHint}>{t('diagnostics.noSession')}</p>
      : snapshot === undefined ? <p className={ui.configFieldHint}>{t('diagnostics.never')}</p>
        : <>
          {snapshot.error !== undefined && <p role="status" className={ui.configFieldHint}>{t('worldBookDiag.failed', { reason: snapshot.error })}</p>}
          {snapshot.diagnosedAt !== undefined && <p className={ui.configFieldHint}>{t('diagnostics.ready', { time: new Date(snapshot.diagnosedAt).toLocaleString() })}</p>}
          {snapshot.diagnosedAt !== undefined && snapshot.records.length === 0 && <p className={ui.configFieldHint}>{t('worldBookDiag.empty')}</p>}
          {snapshot.records.length > 0 && <details>
            <summary>{t('diagnostics.details', { count: snapshot.records.length })}</summary>
            <ul>{snapshot.records.map((record, index) => <li key={`${record.id}:${index}`}>
              <strong>{record.id}</strong>{' '}
              <span>{t(`worldBookDiag.stage.${record.stage}` as 'worldBookDiag.stage.excluded')}</span>{' '}
              <small>{record.reason}</small>
            </li>)}</ul>
          </details>}
          {snapshot.truncated && <p className={ui.configFieldHint}>{t('worldBookDiag.truncated')}</p>}
        </>}
  </section>
}

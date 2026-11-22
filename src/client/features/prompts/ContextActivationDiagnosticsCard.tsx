/** 上下文诊断只呈现统一手动快照，不拥有请求或计时器。 */
import { useMemo, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import type { RuleDiagnosticsSnapshot } from '../../data/rule-diagnostics-session.ts'
import { DiagnosticGroup } from '../../ui/DiagnosticGroup.tsx'
import css from '../../ui/diagnostics.module.css'

type ContextRecords = NonNullable<RuleDiagnosticsSnapshot['context']>['records']
const stages = ['excluded', 'rejected', 'candidate', 'selected', 'committed'] as const

function ContextRecordsByStage({ records, t }: { records: ContextRecords; t: PromptToolTranslate }) {
  const groups = useMemo(() => {
    const byStage = new Map<string, ContextRecords>()
    for (const record of records) {
      const group = byStage.get(record.stage)
      if (group) group.push(record)
      else byStage.set(record.stage, [record])
    }
    return byStage
  }, [records])
  return stages.map(stage => {
    const group = groups.get(stage)
    return group && <DiagnosticGroup key={stage} level="group" label={t(`worldBookDiag.stage.${stage}`)} meta={group.length}>
      {() => group.map((record, index) => <DiagnosticGroup key={`${index}:${record.id}`} level="record" label={record.id}>
        {() => <><p className={css.facts}>{record.id}</p><p className={css.reason}>{record.reason}</p></>}
      </DiagnosticGroup>)}
    </DiagnosticGroup>
  })
}

export function ContextActivationDiagnosticsCard(props: {
  snapshot: RuleDiagnosticsSnapshot['context']
  sessionId?: string
  t: PromptToolTranslate
}): ReactNode {
  const { snapshot, t } = props
  const count = snapshot?.diagnosedAt === undefined ? undefined : snapshot.records.length
  const warning = props.sessionId === undefined ? t('diagnostics.noSessionShort')
    : snapshot?.error !== undefined ? t('diagnostics.contextFailed')
      : snapshot?.truncated ? t('diagnostics.truncatedShort') : undefined
  const meta = [count, warning].filter(value => value !== undefined).join(' · ') || undefined
  return <DiagnosticGroup label={t('diagnostics.context')} meta={meta}>
    {() => <>
      {props.sessionId === undefined ? <p className={css.notice}>{t('diagnostics.noSession')}</p>
        : <p className={css.facts}>{t('diagnostics.session')} · {props.sessionId}</p>}
      {props.sessionId !== undefined && !snapshot && <p className={css.notice}>{t('diagnostics.contextPending')}</p>}
      {snapshot?.error !== undefined && <p className={css.notice}>{t('worldBookDiag.failed', { reason: snapshot.error })}</p>}
      {snapshot?.diagnosedAt !== undefined && <>
        <p className={css.notice}>{t('diagnostics.ready', { time: new Date(snapshot.diagnosedAt).toLocaleString() })}</p>
        {snapshot.records.length === 0 ? <p className={css.notice}>{t('worldBookDiag.empty')}</p>
          : <ContextRecordsByStage records={snapshot.records} t={t} />}
      </>}
      {snapshot?.truncated && <p className={css.notice}>{t('worldBookDiag.truncated')}</p>}
    </>}
  </DiagnosticGroup>
}

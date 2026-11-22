import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PromptToolTranslate } from '../../locales.ts'
import type { RuleDiagnosticsSnapshot, RuleDiagnosticTarget } from '../../data/rule-diagnostics-session.ts'
import type { RuleDiagnosticRecord } from '../../../shared/bridge-contract.ts'
import { DiagnosticGroup } from '../../ui/DiagnosticGroup.tsx'
import css from '../../ui/diagnostics.module.css'

const recordKey = ({ moduleId, ruleId, channel, actionId, agentId }: Pick<RuleDiagnosticRecord, 'moduleId' | 'ruleId' | 'channel' | 'actionId' | 'agentId'>): string =>
  JSON.stringify([moduleId, ruleId, channel, actionId, agentId])

export function DiagnosticsPanel(props: {
  snapshot: RuleDiagnosticsSnapshot
  t: PromptToolTranslate
  onLocate?: (target: RuleDiagnosticTarget) => void
  returnTarget?: RuleDiagnosticTarget
  onReturnFocus?: () => void
}): ReactNode {
  const { t, snapshot, onLocate, returnTarget, onReturnFocus } = props
  const sectionButton = useRef<HTMLButtonElement>(null)
  const returnButton = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [openModules, setOpenModules] = useState(() => new Set<string | undefined>())
  const [openRecords, setOpenRecords] = useState(() => new Set<string>())
  const [previousRecords, setPreviousRecords] = useState(snapshot.records)
  if (previousRecords !== snapshot.records) {
    setPreviousRecords(snapshot.records)
    if (openModules.size) setOpenModules(new Set())
    if (openRecords.size) setOpenRecords(new Set())
  }
  const returnKey = returnTarget === undefined ? undefined : recordKey(returnTarget)
  const expanded = open || returnKey !== undefined
  const groups = useMemo(() => {
    const grouped = new Map<string | undefined, RuleDiagnosticRecord[]>()
    if (expanded) for (const record of snapshot.records) {
      const records = grouped.get(record.moduleId)
      if (records) records.push(record)
      else grouped.set(record.moduleId, [record])
    }
    return grouped
  }, [expanded, snapshot.records])

  useLayoutEffect(() => {
    if (returnTarget === undefined || returnKey === undefined) return
    const frame = requestAnimationFrame(() => {
      if (returnButton.current) {
        setOpen(true)
        setOpenModules(current => new Set(current).add(returnTarget.moduleId))
        setOpenRecords(current => new Set(current).add(returnKey))
      }
      const target = returnButton.current ?? sectionButton.current
      target?.focus()
      onReturnFocus?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [returnTarget, returnKey, onReturnFocus])

  const status = snapshot.busy ? t('diagnostics.running')
    : snapshot.status === 'idle' ? t('diagnostics.never')
      : snapshot.status === 'stale' ? t('diagnostics.stale')
        : snapshot.status === 'error' ? t('diagnostics.error', { error: snapshot.error ?? '' }) : undefined
  const count = snapshot.diagnosedAt === undefined ? undefined : snapshot.records.length
  const summary = snapshot.status === 'error'
    ? (count === undefined ? t('diagnostics.rulesFailed') : `${count} · ${t('diagnostics.rulesFailed')}`)
    : count
  return <DiagnosticGroup label={t('diagnostics.rules')} meta={summary} open={expanded}
    onToggle={() => setOpen(!expanded)} triggerRef={sectionButton}>
    {() => <>
      {status !== undefined && <p className={css.notice} role="status">{status}</p>}
      {snapshot.diagnosedAt !== undefined && <>
        <p className={css.facts}>
          <span>{t('diagnostics.ready', { time: new Date(snapshot.diagnosedAt).toLocaleString() })}</span>
          <span>{snapshot.configs === undefined ? t('diagnostics.configsUnavailable') : t('diagnostics.configs', snapshot.configs)}</span>
          <span>{t('diagnostics.unavailable', { count: snapshot.unavailableCount })}</span>
        </p>
        {snapshot.dropped > 0 && <p className={css.notice}>{t('diagnostics.dropped', { count: snapshot.dropped })}</p>}
        {snapshot.records.length === 0 && <p className={css.notice}>{t('diagnostics.noRuleRecords')}</p>}
      </>}
      {[...groups].map(([moduleId, records]) => <DiagnosticGroup key={JSON.stringify([moduleId])}
        label={moduleId ?? t('diagnostics.unknownModule')} meta={records.length} level="group"
        open={openModules.has(moduleId) || (returnTarget !== undefined && returnTarget.moduleId === moduleId)}
        onToggle={() => setOpenModules(current => {
          const next = new Set(current)
          if (next.has(moduleId)) next.delete(moduleId)
          else next.add(moduleId)
          return next
        })}>
        {() => records.map(record => {
          const key = recordKey(record)
          return <DiagnosticGroup key={key} label={record.actionId ? `${record.ruleId} / ${record.actionId}` : record.ruleId}
            meta={<span title={record.channel}>{record.channel}</span>} level="record" open={openRecords.has(key) || key === returnKey}
            onToggle={() => setOpenRecords(current => {
              const next = new Set(current)
              if (next.has(key)) next.delete(key)
              else next.add(key)
              return next
            })}>
            {() => {
              const { ruleId, channel, actionId, agentId, hit, miss, unavailable, error } = record
              const identity = [moduleId, ruleId, actionId, channel, agentId].filter(Boolean).join(' / ')
              return <>
                <p className={css.reason}>{identity}</p>
                <p className={css.facts}>{t('diagnostics.record', { hit, miss, unavailable, error })}</p>
                {record.reason !== undefined && <p className={css.reason}>{record.reason}</p>}
                {moduleId !== undefined && onLocate && <button type="button" className={css.locate} ref={key === returnKey ? returnButton : undefined}
                  aria-label={`${t('diagnostics.locate')} ${identity}`} onClick={() => onLocate({ moduleId, ruleId, channel, actionId, agentId })}>
                  {t('diagnostics.locate')}
                </button>}
              </>
            }}
          </DiagnosticGroup>
        })}
      </DiagnosticGroup>)}
    </>}
  </DiagnosticGroup>
}

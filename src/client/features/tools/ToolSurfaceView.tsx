import { useEffect, useId, useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusBadge } from '../../ui/StatusBadge.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import { loadToolSurface, type ToolSurfaceEntry, type ToolSurfaceResult, type ToolSurfaceSource } from './tool-surface-request.ts'
import css from './tools.module.css'

type ToolSurfaceProps = ToolSurfaceSource & { label: string; t: PromptToolTranslate; query?: string; headerAction?: ReactNode; children?: ReactNode; expandedState?: Record<string, boolean>; onReady?: () => void }
const matches = (entry: ToolSurfaceEntry, query: string): boolean =>
  entry.name.toLowerCase().includes(query) || entry.description.toLowerCase().includes(query)

/** 一工具一卡；公开事实只到名称/描述/来源视角，不伪造插件配置或运行状态。 */
export function ToolSurfaceList({ tools, filter, t, sourceLabel, sourceId = '', expandedName }: {
  tools: readonly ToolSurfaceEntry[]; filter: string; t: PromptToolTranslate; sourceLabel?: string; sourceId?: string; expandedName?: string
}): ReactNode {
  const sourceLabelText = sourceLabel ?? t('tools.surface.sourceLabel')
  const prefix = useId()
  const [expanded, setExpanded] = useState<string | null>(expandedName ?? null)
  const visible = tools.filter((entry) => matches(entry, filter.trim().toLowerCase()))
  return <>
    <p className={css.toolSurfaceHint} role="status">{t('tools.surface.count', { visible: visible.length, total: tools.length })}</p>
    {visible.length === 0 ? <p className={css.toolSurfaceHint}>{tools.length === 0 ? t('tools.surface.emptySource') : t('tools.surface.emptyFilter')}</p> : (
      <ul className={css.toolSurfaceCards} aria-label={t('tools.surface.list.aria')}>
        {visible.map((entry, index) => {
          const key = `${entry.name}:${index}`
          const open = expanded === key || expanded === entry.name
          const detailId = `${prefix}-tool-${index}`
          return <li key={key} className={css.toolSurfaceCard} data-tool-card="true" data-open={open || undefined}>
            <button type="button" className={css.toolCardToggle} aria-expanded={open} aria-controls={detailId}
              aria-label={t('tools.surface.card.aria', { name: entry.name })} onClick={() => setExpanded(open ? null : key)}>
              <strong className={css.toolCardTitle}>{entry.name}</strong>
              <span className={css.toolCardTrailing}><StatusBadge tone="success" label={t('tools.surface.badge.visible')} /><IconChevronDownOutlineRegular className={css.toolChevron} aria-hidden="true" /></span>
            </button>
            {open && <div id={detailId} className={css.toolCardDetails}>
              <code className={css.toolEntryValue}>{entry.name}</code>
              <dl className={css.toolFacts}>
                <dt>{t('tools.surface.detail.name')}</dt><dd>{entry.name}</dd>
                <dt>{t('tools.surface.detail.from')}</dt><dd>{sourceLabelText}{sourceId && <> · <code>{sourceId}</code></>}</dd>
                <dt>{t('tools.surface.detail.status')}</dt><dd>{t('tools.surface.badge.visible')}</dd>
                <dt>{t('tools.surface.detail.description')}</dt><dd>{entry.description || t('tools.surface.detail.noDescription')}</dd>
              </dl>
            </div>}
          </li>
        })}
      </ul>
    )}
  </>
}

export function ToolSurfaceView(props: ToolSurfaceProps): ReactNode {
  const key = props.sessionId !== undefined ? `session:${props.sessionId}` : `preset:${props.presetId}`
  return <ToolSurfaceContent key={key} {...props} />
}

function ToolSurfaceContent(props: ToolSurfaceProps): ReactNode {
  const { t } = props
  const { sessionId, presetId, query = '' } = props
  const [result, setResult] = useState<ToolSurfaceResult | null>(null)
  const [revision, setRevision] = useState(0)
  const groupKey = sessionId !== undefined ? `session:${sessionId}` : `preset:${presetId}`
  const [expanded, setExpanded] = useState(props.expandedState?.[groupKey] ?? true)
  const contentId = useId()
  const sourceId = sessionId ?? presetId ?? ''
  const loading = sourceId.length > 0 && result === null
  const open = expanded || query.trim().length > 0
  useEffect(() => { if (!loading) props.onReady?.() }, [loading, props.onReady])
  useEffect(() => loadToolSurface(sessionId !== undefined ? { sessionId } : { presetId: presetId! }, setResult), [sessionId, presetId, revision])
  const count = result?.ok ? result.value.tools.filter((entry) => matches(entry, query.trim().toLowerCase())).length : undefined

  return <section className={css.toolGroup} aria-label={props.label} aria-busy={loading}>
    <div className={css.toolGroupHeading}>
      <button type="button" className={css.toolGroupToggle} aria-expanded={open} aria-controls={contentId} onClick={() => {
        setExpanded(!open)
        if (props.expandedState) props.expandedState[groupKey] = !open
      }}>
        <IconChevronDownOutlineRegular className={css.toolChevron} aria-hidden="true" /><span>{props.label}</span>
      </button>
      <div className={css.toolHeaderAction}>{props.headerAction}</div>
    </div>
    <p className={css.toolGroupSub}>{sessionId !== undefined ? t('tools.surface.sub.session') : t('tools.surface.sub.preset')}{count !== undefined && t('tools.surface.sub.count', { count })}</p>
    {open && <div className={css.toolGroupBody} id={contentId}>
      {props.children}
      {sourceId.length === 0 ? <p className={css.toolSurfaceHint}>{sessionId !== undefined ? t('tools.surface.noSession') : t('tools.surface.noPreset')}</p> : <>
        <div className={css.toolSurfaceControls}>
          <p className={css.toolSurfaceHint}>{t('tools.surface.origin')}<code>{sourceId}</code></p>
          <button type="button" className={css.toolRefresh} disabled={loading} onClick={() => { setResult(null); setRevision((value) => value + 1) }}>{t('tools.surface.refresh')}</button>
        </div>
        {loading && <p className={css.toolSurfaceHint} role="status">{t('tools.surface.loading')}</p>}
        {result !== null && (result.ok
          ? <ToolSurfaceList tools={result.value.tools} filter={query} t={t} sourceLabel={props.label} sourceId={sourceId} />
          : <p className={css.toolSurfaceError} role="alert">{result.message || t('tools.surface.readFailed')}{t('tools.surface.retrySuffix')}</p>)}
      </>}
      <p className={css.toolSurfaceHint}>{sessionId !== undefined
        ? t('tools.surface.note.session')
        : t('tools.surface.note.preset')}</p>
    </div>}
  </section>
}

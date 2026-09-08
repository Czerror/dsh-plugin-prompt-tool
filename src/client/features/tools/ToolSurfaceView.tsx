import { useEffect, useId, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { loadToolSurface, type ToolSurfaceEntry, type ToolSurfaceResult, type ToolSurfaceSource } from './tool-surface-request.ts'
import css from './tools.module.css'

type ToolSurfaceProps = ToolSurfaceSource & { label: string; query?: string; headerAction?: ReactNode; children?: ReactNode }
const matches = (entry: ToolSurfaceEntry, query: string): boolean =>
  entry.name.toLowerCase().includes(query) || entry.description.toLowerCase().includes(query)

/** 一工具一卡；公开事实只到名称/描述/来源视角，不伪造插件配置或运行状态。 */
export function ToolSurfaceList({ tools, filter, sourceLabel = '工具面', sourceId = '', expandedName }: {
  tools: readonly ToolSurfaceEntry[]; filter: string; sourceLabel?: string; sourceId?: string; expandedName?: string
}): ReactNode {
  const prefix = useId()
  const [expanded, setExpanded] = useState<string | null>(expandedName ?? null)
  const visible = tools.filter((entry) => matches(entry, filter.trim().toLowerCase()))
  return <>
    <p className={css.toolSurfaceHint} role="status">显示 {visible.length} / {tools.length} 个工具</p>
    {visible.length === 0 ? <p className={css.toolSurfaceHint}>{tools.length === 0 ? '该来源暂无可见工具。' : '无匹配工具，请调整搜索。'}</p> : (
      <ul className={css.toolSurfaceCards} aria-label="模型可见工具">
        {visible.map((entry, index) => {
          const key = `${entry.name}:${index}`
          const open = expanded === key || expanded === entry.name
          const detailId = `${prefix}-tool-${index}`
          return <li key={key} className={css.toolSurfaceCard} data-tool-card="true" data-open={open || undefined}>
            <button type="button" className={css.toolCardToggle} aria-expanded={open} aria-controls={detailId}
              aria-label={`查看工具 ${entry.name}`} onClick={() => setExpanded(open ? null : key)}>
              <strong className={css.toolCardTitle}>{entry.name}</strong>
              <span className={css.toolCardTrailing}><span className={css.toolVisibleDot} aria-hidden="true" /><Tag tone="success">模型可见</Tag><IconChevronDownOutline14 className={css.toolChevron} aria-hidden="true" /></span>
            </button>
            {open && <div id={detailId} className={css.toolCardDetails}>
              <code className={css.toolEntryValue}>{entry.name}</code>
              <dl className={css.toolFacts}>
                <dt>完整名称</dt><dd>{entry.name}</dd>
                <dt>来自</dt><dd>{sourceLabel}{sourceId && <> · <code>{sourceId}</code></>}</dd>
                <dt>可见状态</dt><dd>模型可见</dd>
                <dt>工具描述</dt><dd>{entry.description || '（无描述）'}</dd>
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
  const { sessionId, presetId, query = '' } = props
  const [result, setResult] = useState<ToolSurfaceResult | null>(null)
  const [revision, setRevision] = useState(0)
  const [expanded, setExpanded] = useState(true)
  const contentId = useId()
  const sourceId = sessionId ?? presetId ?? ''
  const loading = sourceId.length > 0 && result === null
  const open = expanded || query.trim().length > 0
  useEffect(() => loadToolSurface(sessionId !== undefined ? { sessionId } : { presetId: presetId! }, setResult), [sessionId, presetId, revision])
  const count = result?.ok ? result.value.tools.filter((entry) => matches(entry, query.trim().toLowerCase())).length : undefined

  return <section className={css.toolGroup} aria-label={props.label} aria-busy={loading}>
    <div className={css.toolGroupHeading}>
      <button type="button" className={css.toolGroupToggle} aria-expanded={open} aria-controls={contentId} onClick={() => setExpanded(!open)}>
        <IconChevronDownOutline14 className={css.toolChevron} aria-hidden="true" /><span>{props.label}</span>
      </button>
      <div className={css.toolHeaderAction}>{props.headerAction}</div>
    </div>
    <p className={css.toolGroupSub}>{sessionId !== undefined ? '当前存活会话 · 冻结 generation' : '所选预设 · 后续 generation'}{count !== undefined && ` · ${count} 个`}</p>
    {open && <div className={css.toolGroupBody} id={contentId}>
      {props.children}
      {sourceId.length === 0 ? <p className={css.toolSurfaceHint}>{sessionId !== undefined ? '尚未选择当前会话；不会自动创建或恢复会话。' : '请选择预设后读取工具能力。'}</p> : <>
        <div className={css.toolSurfaceControls}>
          <p className={css.toolSurfaceHint}>来源：<code>{sourceId}</code></p>
          <button type="button" className={css.toolRefresh} disabled={loading} onClick={() => { setResult(null); setRevision((value) => value + 1) }}>刷新工具</button>
        </div>
        {loading && <p className={css.toolSurfaceHint} role="status">正在读取工具…</p>}
        {result !== null && (result.ok
          ? <ToolSurfaceList tools={result.value.tools} filter={query} sourceLabel={props.label} sourceId={sourceId} />
          : <p className={css.toolSurfaceError} role="alert">{result.message || '工具面读取失败'}；可刷新重试。</p>)}
      </>}
      <p className={css.toolSurfaceHint}>{sessionId !== undefined
        ? '刷新不升级既有会话的 generation，也不会自动 resume 会话。'
        : '预设能力不代表当前会话；修改预设不替换既有会话的冻结 generation。'}</p>
    </div>}
  </section>
}

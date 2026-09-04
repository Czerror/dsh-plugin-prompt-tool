/** 只读工具面视图：/tool-surface 返回当前存活本地 Agent 实际可见工具
 *  （name/description 摘要）。搜索仅客户端过滤，不增加请求频率。
 *  无会话/未知 session 显示明确空态或稳定错误，不自动 resume。 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { bridgeCall } from '../../data/bridge-client.ts'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './tools.module.css'

const styles = { ...sharedCss, ...featureCss }

export interface ToolSurfaceEntry { name: string; description: string }

type ToolSurfaceProps = {
  /** 视角标题（当前会话 / 预设工具能力）。 */
  label: string
  /** 已由可编辑自定义工具卡呈现的名称，避免同一有效 schema 重复显示。 */
  hiddenNames?: readonly string[]
} & ({ sessionId: string; presetId?: never } | { presetId: string; sessionId?: never })

export function ToolSurfaceView(props: ToolSurfaceProps): ReactNode {
  const sessionId = 'sessionId' in props ? props.sessionId : undefined
  const presetId = 'presetId' in props ? props.presetId : undefined
  const { label } = props
  const [tools, setTools] = useState<ToolSurfaceEntry[] | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')

  const load = useCallback(() => {
    if ((sessionId ?? presetId ?? '').length === 0) {
      setTools(null)
      setError(undefined)
      return
    }
    setLoading(true)
    setError(undefined)
    const request = sessionId !== undefined ? { sessionId } : { presetId: presetId! }
    void bridgeCall('toolSurface', request).then((result) => {
      setLoading(false)
      if (result.ok) {
        setTools(result.value.tools)
      } else {
        setTools(null)
        setError(('message' in result ? result.message : undefined) ?? '工具面读取失败')
      }
    })
  }, [presetId, sessionId])

  useEffect(() => { load() }, [load])

  const keyword = filter.trim().toLowerCase()
  const hiddenNames = new Set(props.hiddenNames ?? [])
  const visible = (tools ?? []).filter((entry) => !hiddenNames.has(entry.name) &&
    (keyword.length === 0 || entry.name.toLowerCase().includes(keyword) || entry.description.toLowerCase().includes(keyword)))

  return (
    <div className={styles.settingRowStack} style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: 8 }}>
      <span className={styles.settingCopy}>
        <strong>{label}（只读）</strong>
        <small>{tools === null ? '' : `${visible.length} 个工具 · `}{presetId !== undefined
          ? '来自官方预设后续 generation 的有效工具能力（name/description 摘要）；仅在选择预设时懒加载。'
          : '来自当前存活会话的有效工具面（name/description 摘要）；既有会话保留创建时冻结的 generation。'}</small>
      </span>
      {(sessionId ?? presetId ?? '').length === 0
        ? <p className={styles.configFieldHint}>未选择工具面来源。</p>
        : (
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input className={styles.configInput} aria-label="工具面搜索" placeholder="搜索工具名/描述（客户端过滤）" value={filter}
              onChange={(event) => setFilter(event.target.value)} />
            <button type="button" className={styles.pillButton} onClick={load} disabled={loading}>刷新</button>
          </span>
        )}
      {loading && <p className={styles.configFieldHint}>加载中…</p>}
      {!loading && error !== undefined && <p className={styles.configFieldHint}>{error}</p>}
      {!loading && error === undefined && (sessionId ?? presetId ?? '').length > 0 && tools !== null && (
        visible.length === 0
          ? <p className={styles.configFieldHint}>{tools.length === 0 ? '该 Agent 当前无可见工具。' : '无匹配工具。'}</p>
          : (
            <div className={styles.toolSurfaceCards}>
              {visible.map((entry) => (
                <article key={entry.name} className={styles.toolSurfaceCard} data-tool-card="true">
                  <strong><code>{entry.name}</code></strong>
                  <span>{entry.description || '（无描述）'}</span>
                </article>
              ))}
            </div>
          )
      )}
    </div>
  )
}

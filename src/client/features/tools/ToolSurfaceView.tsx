/** 只读工具面视图：/tool-surface 返回当前存活本地 Agent 实际可见工具
 *  （name/description 摘要）。搜索仅客户端过滤，不增加请求频率。
 *  无会话/未知 session 显示明确空态或稳定错误，不自动 resume。 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { bridgeCall } from '../../data/bridge-client.ts'
import styles from '../../PromptUi.module.css'

export interface ToolSurfaceEntry { name: string; description: string }

export function ToolSurfaceView(props: {
  /** 当前主会话或子代理 session id（客户端从官方 sessions snapshot 取，不持久化）。 */
  sessionId: string
  /** 视角标题（主会话 / 子代理）。 */
  label: string
}): ReactNode {
  const { sessionId, label } = props
  const [tools, setTools] = useState<ToolSurfaceEntry[] | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')

  const load = useCallback(() => {
    if (sessionId.length === 0) {
      setTools(null)
      setError(undefined)
      return
    }
    setLoading(true)
    setError(undefined)
    void bridgeCall('toolSurface', { sessionId }).then((result) => {
      setLoading(false)
      if (result.ok) {
        setTools(result.value.tools)
      } else {
        setTools(null)
        setError(('message' in result ? result.message : undefined) ?? '工具面读取失败')
      }
    })
  }, [sessionId])

  useEffect(() => { load() }, [load])

  const keyword = filter.trim().toLowerCase()
  const visible = (tools ?? []).filter((entry) =>
    keyword.length === 0 || entry.name.toLowerCase().includes(keyword) || entry.description.toLowerCase().includes(keyword))

  return (
    <div className={styles.settingRowStack} style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: 8 }}>
      <span className={styles.settingCopy}>
        <strong>{label} 实际工具面（只读）</strong>
        <small>{tools === null ? '' : `${tools.length} 个工具 · `}当前存活会话的可见工具（name/description 摘要）；保存/重建后既有会话与子代理保留原 generation 与创建时冻结的工具集。</small>
      </span>
      {sessionId.length === 0
        ? <p className={styles.configFieldHint}>无当前会话上下文；工具面仅对存活本地 Agent 可用。</p>
        : (
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input className={styles.configInput} aria-label="工具面搜索" placeholder="搜索工具名/描述（客户端过滤）" value={filter}
              onChange={(event) => setFilter(event.target.value)} />
            <button type="button" className={styles.pillButton} onClick={load} disabled={loading}>刷新</button>
          </span>
        )}
      {loading && <p className={styles.configFieldHint}>加载中…</p>}
      {!loading && error !== undefined && <p className={styles.configFieldHint}>{error}</p>}
      {!loading && error === undefined && sessionId.length > 0 && tools !== null && (
        visible.length === 0
          ? <p className={styles.configFieldHint}>{tools.length === 0 ? '该 Agent 当前无可见工具。' : '无匹配工具。'}</p>
          : (
            <ul style={{ maxHeight: 180, overflowY: 'auto', margin: 0, paddingLeft: 18 }}>
              {visible.map((entry) => (
                <li key={entry.name}><code>{entry.name}</code> — {entry.description}</li>
              ))}
            </ul>
          )
      )}
    </div>
  )
}

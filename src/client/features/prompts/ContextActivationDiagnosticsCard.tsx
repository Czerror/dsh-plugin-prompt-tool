/** 上下文激活诊断卡（只读）：读取当前会话最近一次选择记录，解释候选/入选/已注入与真实拒绝原因。
 *  只在用户点击时读取一次，不触发求值、抽样或时间窗推进。 */
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { bridgeCall } from '../../data/bridge-client.ts'
import type { HostApiPort } from '../../data/store-ports.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { ContextActivationDiagnosticRecord } from '../../../shared/bridge-contract.ts'
import ui from '../../ui/controls.module.css'
import { Button } from '../../ui/Button.tsx'

export const ContextActivationDiagnosticsCard = memo(function ContextActivationDiagnosticsCard(props: {
  store: HostApiPort
  t: PromptToolTranslate
}): ReactNode {
  const { store, t } = props
  const [records, setRecords] = useState<ContextActivationDiagnosticRecord[]>([])
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [diagnosedAt, setDiagnosedAt] = useState<number>()
  const busy = useRef(false)
  const generation = useRef(0)
  const sessionId = store.api.currentSessionId()
  useEffect(() => {
    generation.current += 1
    setRecords([]); setTruncated(false); setError(undefined); setDiagnosedAt(undefined); setLoading(false)
    return () => { generation.current += 1 }
  }, [sessionId])

  const refresh = useCallback(async (): Promise<void> => {
    if (busy.current || sessionId === undefined) return
    busy.current = true
    const requestGeneration = generation.current
    setLoading(true)
    try {
      const res = await bridgeCall('contextActivationDiagnostics', { sessionId })
      if (requestGeneration !== generation.current || store.api.currentSessionId() !== sessionId) return
      if (res.ok) {
        // 防御畸形载荷：只认数组记录，避免异常响应把整页渲染打断。
        setRecords(Array.isArray(res.value.records) ? res.value.records : [])
        setTruncated(res.value.truncated === true)
        setError(undefined)
        setDiagnosedAt(Date.now())
      } else {
        setError(res.message ?? 'settings bridge unavailable')
      }
    } finally {
      busy.current = false
      if (requestGeneration === generation.current) setLoading(false)
    }
  }, [store, sessionId])

  return (
    <div className={ui.section}>
      <div className={ui.sectionHeading}>
        <div>
          <h2>{t('worldBookDiag.title')}</h2>
          <p>{t('worldBookDiag.hint')}</p>
        </div>
        <Button shape="pill" variant="outline" size="md" disabled={loading || sessionId === undefined} onClick={() => void refresh()}>
          {t('worldBookDiag.refresh')}
        </Button>
      </div>
      {error !== undefined && <p>{t('worldBookDiag.failed', { reason: error })}</p>}
      {diagnosedAt === undefined && error === undefined && <p>{t('diagnostics.never')}</p>}
      {diagnosedAt !== undefined && <p>{t('diagnostics.ready', { time: new Date(diagnosedAt).toLocaleString() })}</p>}
      {diagnosedAt !== undefined && error === undefined && records.length === 0 && <p>{t('worldBookDiag.empty')}</p>}
      {records.length > 0 && (
        <ul>
          {records.map((record, index) => (
            <li key={`${record.id}:${record.stage}:${record.reason}:${index}`}>
              <strong>{record.id}</strong>{' '}
              <span>{t(`worldBookDiag.stage.${record.stage}` as 'worldBookDiag.stage.excluded')}</span>{' '}
              <small>{record.reason}</small>
            </li>
          ))}
        </ul>
      )}
      {truncated && <p>{t('worldBookDiag.truncated')}</p>}
    </div>
  )
})

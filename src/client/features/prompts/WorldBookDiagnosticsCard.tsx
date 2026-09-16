/** 世界书诊断卡（只读）：读取当前会话最近一次选择记录，解释候选/入选/已注入与真实拒绝原因。
 *  只在用户点击或挂载时读取一次，不触发求值、抽样或时间窗推进。 */
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react'
import { bridgeCall } from '../../data/bridge-client.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { WorldBookDiagnosticRecord } from '../../../shared/bridge-contract.ts'
import ui from '../../ui/controls.module.css'

export const WorldBookDiagnosticsCard = memo(function WorldBookDiagnosticsCard(props: {
  store: PromptToolStore
  t: PromptToolTranslate
}): ReactNode {
  const { store, t } = props
  const [records, setRecords] = useState<WorldBookDiagnosticRecord[]>([])
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const sessionId = store.api.currentSessionId()
    setLoading(true)
    try {
      const res = await bridgeCall('worldBookDiagnostics', sessionId === undefined ? {} : { sessionId })
      if (res.ok) {
        // 防御畸形载荷：只认数组记录，避免异常响应把整页渲染打断。
        setRecords(Array.isArray(res.value.records) ? res.value.records : [])
        setTruncated(res.value.truncated === true)
        setError(undefined)
      } else {
        setError(res.message ?? 'settings bridge unavailable')
      }
    } finally {
      setLoading(false)
    }
  }, [store])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <div className={ui.section}>
      <div className={ui.sectionHeading}>
        <div>
          <h2>{t('worldBookDiag.title')}</h2>
          <p>{t('worldBookDiag.hint')}</p>
        </div>
        <button type="button" className={ui.pillButton} disabled={loading} onClick={() => void refresh()}>
          {t('worldBookDiag.refresh')}
        </button>
      </div>
      {error !== undefined && <p>{t('worldBookDiag.failed', { reason: error })}</p>}
      {error === undefined && records.length === 0 && <p>{t('worldBookDiag.empty')}</p>}
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

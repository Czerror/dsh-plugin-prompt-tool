import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { DialogSurface } from './DialogSurface.tsx'
import styles from './controls.module.css'

/** 危险操作确认：取消先聚焦；请求中拒绝重复提交，失败保留当前确认面。
 *  取消与确认同族几何（`.pillButton` / `.confirmDanger`，同一胶囊尺寸与字号），
 *  主次只由语义色区分：取消是中性的描边胶囊，确认删除是实心 error 底。
 *  两处入口（预设、角色卡等）共用本组件，因此删除确认的外观不会各走一套。 */
export function ConfirmDialog(props: {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  failureMessage?: string
  returnFocusRef?: RefObject<HTMLElement | null>
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => { if (busy) cancelRef.current?.focus() }, [busy])
  const cancel = (): void => { if (!pending.current) props.onCancel() }
  const confirm = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await props.onConfirm()
      props.onCancel()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : props.failureMessage ?? String(reason))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return <DialogSurface title={props.title} description={props.description} role="alertdialog"
    initialFocusRef={cancelRef} returnFocusRef={props.returnFocusRef} closeLabel={props.cancelLabel} onClose={cancel}>
    {error !== undefined && <p className={styles.confirmError} role="alert">{error}</p>}
    <div className={styles.confirmActions} aria-busy={busy}>
      <button ref={cancelRef} type="button" className={styles.pillButton} aria-disabled={busy} onClick={cancel}>{props.cancelLabel}</button>
      <button type="button" className={styles.confirmDanger} disabled={busy} onClick={() => { void confirm() }}>{props.confirmLabel}</button>
    </div>
  </DialogSurface>
}

import { useEffect, useRef } from 'react'

/** 离开编辑区域才提交；焦点事件沿 React 树识别同区域的 portal。 */
export function useAutosave(identity: string, save: () => void) {
  const frame = useRef<number>()
  const composing = useRef(false)
  const focused = useRef(false)
  const pending = useRef(false)
  const latest = useRef({ identity, save })
  latest.current = { identity, save }
  const cancel = (): void => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined }
  const flush = (): void => {
    cancel()
    pending.current = composing.current
    if (!composing.current) latest.current.save()
  }
  const onBlur = (): void => {
    focused.current = false
    cancel()
    frame.current = requestAnimationFrame(() => { frame.current = undefined; if (!focused.current) flush() })
  }
  useEffect(() => {
    composing.current = false; focused.current = false; pending.current = false
    return () => {
      // 折叠可能先于焦点回调卸载子编辑器，只兑现同身份已经发生的离区提交。
      const leaving = frame.current !== undefined && !focused.current && !composing.current && latest.current.identity === identity
      cancel(); pending.current = false
      if (leaving) latest.current.save()
    }
  }, [identity])
  return {
    flush, isFocused: () => focused.current, onBlur,
    onFocus: () => { focused.current = true; pending.current = false; cancel() },
    onCompositionStart: () => { composing.current = true },
    onCompositionEnd: () => {
      composing.current = false
      if (pending.current) { cancel(); frame.current = requestAnimationFrame(flush) }
    },
  }
}

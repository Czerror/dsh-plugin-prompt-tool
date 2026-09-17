import { useEffect, useRef, type RefObject } from 'react'

/** 已发布 Menu 的 portal 先隐藏后定位；等可见帧再补齐首项焦点。ref 仅指向调用方自己的 label。 */
export function useMenuFocus(open: boolean): RefObject<HTMLSpanElement> {
  const labelRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => { labelRef.current?.closest('button')?.focus() })
    return () => cancelAnimationFrame(frame)
  }, [open])
  return labelRef
}

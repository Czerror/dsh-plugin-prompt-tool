import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** 仅在焦点将越过首尾或当前焦点不在弹窗内时返回循环目标。 */
export function nextDialogFocusIndex(length: number, current: number, backward: boolean): number | undefined {
  if (length <= 0) return undefined
  if (current < 0) return backward ? length - 1 : 0
  if (backward && current === 0) return length - 1
  if (!backward && current === length - 1) return 0
  return undefined
}

export function useDialogFocus<T extends HTMLElement>(open: boolean, onClose: () => void): {
  dialogRef: RefObject<T>
  onDialogKeyDown: (event: ReactKeyboardEvent<T>) => void
} {
  const dialogRef = useRef<T>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    return () => { restoreRef.current?.focus() }
  }, [open])

  const onDialogKeyDown = useCallback((event: ReactKeyboardEvent<T>): void => {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab' || dialogRef.current === null) return
    const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((element) => !element.hasAttribute('disabled'))
    const current = document.activeElement instanceof HTMLElement ? focusables.indexOf(document.activeElement) : -1
    const next = nextDialogFocusIndex(focusables.length, current, event.shiftKey)
    if (next === undefined) return
    event.preventDefault()
    focusables[next]?.focus()
  }, [open, onClose])

  return { dialogRef, onDialogKeyDown }
}

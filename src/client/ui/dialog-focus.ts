import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

export const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'

/** 仅在焦点将越过首尾或当前焦点不在弹窗内时返回循环目标。 */
export function nextDialogFocusIndex(length: number, current: number, backward: boolean): number | undefined {
  if (length <= 0) return undefined
  if (current < 0) return backward ? length - 1 : 0
  if (backward && current === 0) return length - 1
  if (!backward && current === length - 1) return 0
  return undefined
}

export function useDialogFocus<T extends HTMLElement>(open: boolean, onClose: () => void, options?: {
  initialFocusRef?: RefObject<HTMLElement | null>
  returnFocusRef?: RefObject<HTMLElement | null>
}): {
  dialogRef: RefObject<T>
  onDialogKeyDown: (event: ReactKeyboardEvent<T>) => void
} {
  const dialogRef = useRef<T>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    const returnTarget = options?.returnFocusRef?.current
    restoreRef.current = returnTarget?.querySelector<HTMLElement>(FOCUSABLE) ?? returnTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const card = restoreRef.current?.closest('article')
    const siblings = card?.parentElement === null || card?.parentElement === undefined ? [] : [...card.parentElement.children]
    const at = card === null || card === undefined ? -1 : siblings.indexOf(card)
    const fallbacks = at < 0 ? [] : [...siblings.slice(at + 1), ...siblings.slice(0, at).reverse()]
      .map((element) => element.querySelector<HTMLElement>(FOCUSABLE)).filter((element) => element !== null)
    const parent = card?.parentElement
    // 锚定浮层首帧可能仍为 hidden；与菜单一致，等定位帧后再聚焦。
    const frame = requestAnimationFrame(() => {
      const initial = options?.initialFocusRef?.current ?? [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
        .find((element) => !element.matches(':disabled') && element.getClientRects().length > 0)
      ;(initial ?? dialogRef.current)?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      if (restoreRef.current?.isConnected) { restoreRef.current.focus(); return }
      // 删除 owner 可先安排更精确的焦点；仅在焦点随卸载丢失时补到相邻卡/创建入口。
      if (document.activeElement !== document.body && document.activeElement?.isConnected) return
      const target = fallbacks.find((element) => element.isConnected && !element.matches(':disabled'))
        ?? parent?.querySelector<HTMLElement>('[data-create-entry], button:not(:disabled)')
      target?.focus()
    }
  }, [open])

  const onDialogKeyDown = useCallback((event: ReactKeyboardEvent<T>): void => {
    if (!open || event.defaultPrevented) return
    // body portal 的 React 事件仍向外层对话冒泡；浮层拥有自己的键盘边界。
    if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab' || dialogRef.current === null) return
    const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((element) => !element.matches(':disabled') && element.getClientRects().length > 0)
    const current = document.activeElement instanceof HTMLElement ? focusables.indexOf(document.activeElement) : -1
    const next = nextDialogFocusIndex(focusables.length, current, event.shiftKey)
    if (next === undefined) return
    event.preventDefault()
    focusables[next]?.focus()
  }, [open, onClose])

  return { dialogRef, onDialogKeyDown }
}
